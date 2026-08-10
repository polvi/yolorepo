# Ledger — TLA+ spec of the tabby group-expense ledger

Model-checked spec of the tabby (Splitwise-for-Monero) ledger core:
an append-only expense log with exact remainder splits, balances that
are always derived (never stored), idempotent payments keyed by
client-generated ids, and greedy debt settlement — checked under the
race where a payment is recorded against a stale settlement
suggestion.

Published (passing) generation: https://tlc.proc.io/hub/623f9b12-a08b-4b6d-850a-29d58934eb61/Ledger

## What is modeled

- Expenses: `(payer, participants, amt)` records appended to a log.
  Amounts are small naturals (abstract µTAB units). Shares follow the
  exact remainder rule: `base = amt div n`, and the first `amt mod n`
  participants in a fixed user ordering (models ORDER BY user id) pay
  `base + 1`, so shares always sum exactly to the amount.
- Balances: `Net(u) = paid − owed + sent − received`, computed from
  the expense log and payments table on every evaluation. There is no
  stored balance anywhere in the state.
- Greedy settlement: repeatedly match the largest debtor with the
  largest creditor (deterministic tiebreak by user order) and transfer
  `min(|debt|, credit)`.
- Payments: `ProposePayment` binds one transfer of the greedy plan
  over CURRENT nets to a fresh client-generated id; `SubmitPayment`
  records it iff that id has no row (SQL `INSERT OR IGNORE`);
  `ResubmitPayment` models double-tap / network-retry redelivery and
  changes nothing.
- The critical race: `AddExpense` interleaves freely with
  propose/submit, so a payment can land against a suggestion computed
  from nets that no longer hold. The ledger records what was actually
  paid; balances just net it out.

## Invariants checked

- `TypeOK` — state typing.
- `Conservation` — the derived nets always sum to zero, including
  after stale-suggestion payments (money is never created or lost).
- `SharesExact` — every expense's shares sum exactly to its amount.
- `SettlementSound` — the greedy plan over the current nets zeroes all
  nets and uses at most `|Users| − 1` transfers.
- `IdempotentPayments` — a recorded row is exactly the attempt bound
  to its id.
- `NoOverwrite` (action property) — once written, a payment row never
  changes on any step.

Result: all invariants and the action property hold. 35,885 states
generated, 14,681 distinct, depth 7, queue empty (complete search of
the bounded model).

## What is abstracted away

- Money is small naturals; real µTAB amounts, currency conversion, and
  Monero itself (tx construction, confirmation) are out of scope — a
  "payment" is just a signed transfer record.
- Payment ids are 2 model values standing in for client UUIDs;
  uniqueness of UUIDs is assumed, collision is not modeled.
- Auth, groups, members joining/leaving: the user set is fixed.
- Single-participant expenses are excluded from the enumeration: they
  only shift one pairwise IOU and exercise no remainder or settlement
  structure, and dropping them keeps the state space small.
- Liveness: runs quiesce when bounds are hit, so deadlock checking is
  off (`CHECK_DEADLOCK FALSE`); quiescence is expected, not an error.
- Bounds: 3 users, expense amounts 1..2, at most 2 expenses, 2 payment
  ids. Overshoot from stale payments is covered by the `Transfer` amt
  range `1..2*MaxTotal`.

## Re-running the check

Validate `Ledger.tla` with the `tlc_parse` MCP tool, then run
`tlc_check` with the module source and the contents of `Ledger.cfg` as
the config. The files in this directory are byte-for-byte the passing
configuration. Any classic TLA+ toolchain works too:
`tlc -config Ledger.cfg Ledger.tla` (deadlock checking already
disabled in the cfg).

Note for the hosted checker: derived-state arguments to recursive
operators must be forced to a value first — the spec's
`\E f \in {NetF}` bindings do exactly that. Passing `NetF` directly
into `GreedyRec` re-evaluates the whole derivation at every recursive
access and the check appears to hang.

## What implementers must get right

- Payments are keyed by a client-generated UUID and written with
  `INSERT OR IGNORE` (or an equivalent atomic conditional insert).
  Redelivery, double-tap, and retry must all hit the IGNORE branch;
  a read-then-insert gap would let a retry double-apply a payment.
- An expense and its shares are written in one atomic D1 batch; a
  partially written share set breaks both `SharesExact` and
  `Conservation`.
- Balances are always derived from the expense and payment tables,
  never stored. A stored balance is exactly what turns the
  stale-suggestion race into corruption; the derived form makes it
  harmless (the payment records what was paid, nets absorb it).
- The remainder rule must be deterministic: order participants by
  user id, give the first `amt mod n` of them `base + 1`. Any client
  or server computing shares differently for the same expense would
  disagree about derived balances.
- Settlement suggestions are advisory. The server must accept a
  payment that no longer matches the current greedy plan; validity is
  "this transfer happened", not "this transfer was optimal".
