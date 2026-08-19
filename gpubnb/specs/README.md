# Metering — TLA+ spec of the runner's deposit / metering / receipt logic

Model-checked spec of PROTOCOL.md §6–§7 as the Rust runner has to
implement it: non-custodial prepaid metering for an attested inference
endpoint. Payments land on a chain and are credited only at ≥ K
confirmations (keyed by output id), un-credited on reorg; requests
reserve/settle against a per-session ledger behind a replay-protected
request counter; every response carries a signed receipt with a strictly
increasing `seq` and a non-decreasing cumulative debit; a crash loses RAM
and the runner comes back from a persisted snapshot plus a chain rescan.

Published (passing) generation:
https://tlc.proc.io/hub/623f9b12-a08b-4b6d-850a-29d58934eb61/Metering
(the win, lazy snapshots re-issuing receipt seqs, is on the same page
under `#wins`).

## What is modeled

- Chain: a sequence of blocks, each a set of payment outputs; an output
  `(txid, subaddr_major, subaddr_minor)` is a model value with a fixed
  session and amount chosen at `Pay`. Depth of block `i` at height `H`
  is `H − i + 1`; an output is confirmed at depth ≥ K. `Confirm` mines
  any subset of the mempool (including nothing, so depth grows).
- `Reorg`: the last `d ≤ MaxReorg` blocks are replaced by a same-height
  fork. Each dropped output returns to the mempool, vanishes for good
  (double-spent away), or reappears in the fork's oldest block (so a
  payment can reappear at depth `d` and be confirmed again). Height is
  preserved, which is what keeps "reorg shallower than K" a meaningful
  finality assumption.
- Watcher: `Credit` credits one confirmed output that is not yet in the
  idempotency index; `Uncredit` removes one that is no longer confirmed.
  Both update a separate `balance` counter the way an implementation
  would, so the spec can check counter and index agree.
- Requests: `StartReq` takes a request counter; it must exceed the
  session's high-water mark (`Replay` is the rejected case and changes
  nothing). If `balance − reserved ≥ cost` the cost is reserved,
  otherwise the request is refused with a receipt whose cumulative is
  unchanged (`payment_required` + receipt). `Settle` debits
  `actual ≤ reserve`, releases the rest, and emits a receipt with the
  new cumulative. `Abort` (upstream error / client gone) releases the
  reserve only.
- Persistence: `snap[s]` is the durable record `(debited, receipts,
  hwm)`. `PersistOnWrite = TRUE` writes it atomically in the same step
  that emits a receipt or accepts a counter (persist-before-emit).
  `PersistOnWrite = FALSE` is the lazy design: `Persist` snapshots at
  arbitrary moments. `Restart` rebuilds `credited`/`balance` by a full
  rescan at depth ≥ K, restores debited/receipts/hwm from the snapshot,
  and drops in-flight reservations.
- Ghost state (never lost, not part of the design): `issued` is every
  receipt any client has ever received, `used` the counters ever
  accepted as fresh, `everConf` the outputs that were ever confirmed.

## Invariants checked

- `TypeOK`, `ChainWellFormed` — typing; an output is in at most one of
  mempool / one block / nowhere.
- `SpentWithinConfirmed` — `debited + reserved ≤ Σ amount of outputs for
  the session that were ever at depth ≥ K`. This is the form of "the
  service never spends unconfirmed money" that survives a reorg deeper
  than K: the loss is bounded by once-confirmed payments, and no
  mempool or shallow output ever backs a debit. Crediting at depth ≥ 1
  instead of ≥ K breaks it (checked by mutation).
- `SolventUnderFinality` — under `MaxReorg < K`, the strong form:
  `debited + reserved ≤ Σ credited outputs currently at depth ≥ K`.
  Vacuous in the saved config (`MaxReorg = K`), checked for real in the
  `MaxReorg = 1` run noted in the cfg.
- `NoDoubleCredit` — `balance = Σ credited − debited`: each output id is
  credited once at any time, across reorg and restart. A design that
  persisted the credit counter and also rescanned would fail it.
- `CreditedWasConfirmed` — credits only ever come from confirmed
  outputs.
- `ReservedMatchesInflight` — the reserve counter equals the sum of
  open requests: no reserve leak on abort, no double release on settle.
- `IssuedMonotone` — over everything clients have ever received, `seq`
  strictly increases and cumulative never decreases, across restarts.
- `ReceiptsConsistent` — in the runner's view `seq` is the position in
  the log, the last cumulative equals `debited` (and no receipts means
  no debit), and the snapshot never runs ahead of RAM (`snap.debited ≤
  debited`, `snap.hwm ≤ hwm`, snapshot receipts are a prefix).
- `ReceiptsDurable` — with persist-before-emit the runner's receipt log
  equals what was issued (nothing a client holds can be forgotten).
- `ReplaySafe` — the high-water mark is the largest counter ever
  accepted (everything at or below it is refused) and no counter ever
  yields more than one receipt.
- `NoOverdraftAdmission` (action property) — a reserve is only ever
  taken out of `balance − reserved`; a negative balance after a reorg
  admits nothing until new confirmed money arrives.

Result (`Metering.cfg`, persist-before-emit): all hold. 69,872 states
generated, 5,772 distinct, depth 15, queue empty. Two-session run
(`Sessions = {s1, s2}`, `MaxCtr = MaxIssued = 1`): 214,497 / 17,144,
depth 15. `MaxReorg = 1`: 6,272 / 997, depth 12.

## What the checker found

The lazy-snapshot design (`PersistOnWrite = FALSE`, "debits since the
last snapshot are lost") violates `IssuedMonotone` and `ReplaySafe`
within three steps: a request is refused and receipt `seq 1` goes out;
crash before any snapshot; restart puts the high-water mark back at 0;
the same counter is accepted again and a second `seq 1` receipt is
emitted. With a settled debit in place of the refusal the same run
emits a later receipt whose cumulative is lower than one the client
already holds. So "cumulative may only be ≥ the snapshot's" is not a
property that can be offered to clients: what must hold is that the
snapshot *is* the emitted history. The corrected design (persist the
durable record before the receipt or the acceptance leaves the runner)
passes; reported as a win on the hub.

## What is abstracted away

- Amounts and costs are small naturals; piconero arithmetic, `ceil`
  pricing, token estimates versus actuals are out of scope (`actual ≤
  reserve` is the only thing the ledger depends on).
- One output per model value; the key `(txid, major, minor)` is the
  model value. Subaddress re-linking by label after restart is assumed
  to work (the session survives; only RAM is lost).
- HPKE/session keys, signatures, and the wire envelope are not modeled;
  "receipt emitted" is the ghost append.
- `MaxInflight = 1`: one outstanding request per session. The spec
  supports more (reserves are a sequence) at a state-space cost.
- Liveness: runs quiesce at the bounds, deadlock checking is off.
- Bounds: 1 session (2 in the alternate run), 2 outputs, chain of 3
  blocks, K = 2, reorgs up to K deep, counters 1..2, at most 2 receipts
  per session. Sessions share nothing but the chain in the design, so a
  single session exercises every per-session property; the two-session
  run at the same bounds exceeds the hosted checker's budget.

## Re-running the check

Validate `Metering.tla` with the `tlc_parse` MCP tool, then run
`tlc_check` with the module source and the contents of `Metering.cfg` as
the config. The files here are the passing configuration byte for byte.
Any classic TLA+ toolchain works too: `tlc -config Metering.cfg
Metering.tla`. Flip `PersistOnWrite = FALSE` to reproduce the
counterexample; set `MaxReorg = 1` to check `SolventUnderFinality`
non-vacuously.

Hosted-checker notes: bounds of one `\E` cannot refer to an earlier
variable of the same `\E` (write `\E s \in S : \E i \in 1..Len(f[s])`),
and a primed variable inside a record constructor (`[receipts |->
receipts'[s]]`) does not resolve; the spec builds the new value with
`Append(receipts[s], r)` instead.

## What implementers must get right (Rust runner)

- Credit only at `confirmations >= K`, using the watcher's height, and
  key credits by `(txid, subaddr_major, subaddr_minor)`: a `HashSet`
  (or table) of credited keys is the idempotency index; `balance` is
  derived from it, never a free-running counter. `get_transfers`
  returns the same transfer on every poll; without the key check every
  poll is a double credit.
- Un-credit on reorg: a key that is in the index but no longer reported
  at depth ≥ K is removed and its amount subtracted, even if that makes
  the balance negative. A negative balance admits nothing
  (`balance − reserved < reserve` → `payment_required`) until new
  confirmed outputs arrive.
- Never persist credits. On start, rebuild the index and balance by a
  full rescan of the wallet at depth ≥ K. Persisting them *and*
  rescanning is the double-credit-after-restore bug.
- Persist `(cumulative_debit, receipt log or at least last seq/cum,
  hwm)` durably *before* the receipt event is written to the response
  stream and before an accepted request starts upstream. `fsync` (or
  SQLite in WAL with synchronous=FULL) then send. A snapshot taken
  "every N seconds" re-issues `seq` values after a crash and can emit a
  cumulative lower than one the client already holds (the checker's
  counterexample).
- `seq` is the length of the persisted receipt log plus one; never a
  RAM counter. Refusals (`payment_required`) also emit and persist a
  receipt with the unchanged cumulative.
- The counter check is `ctr > hwm`, not `ctr != hwm` and not "not
  seen"; persist `hwm` whenever it advances (refuse and accept paths,
  not only settle). After restore, counters at or below the persisted
  `hwm` must still be rejected with 409.
- Reserve on admission, release exactly once: settle releases
  `reserve − actual` and debits `actual ≤ reserve`; abort, upstream
  error, and client disconnect release the whole reserve. Use an RAII
  guard or a single release path so no branch leaks a reserve (a leaked
  reserve refuses a funded session forever).
- In-flight reservations are RAM-only by design: after a crash their
  upstream calls are dead and the rescan plus snapshot leaves
  `reserved = 0`.
