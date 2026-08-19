---- MODULE Metering ----
(***************************************************************************)
(* Non-custodial prepaid metering for an attested inference endpoint.      *)
(*                                                                         *)
(* A renter pays into a per-session address on a chain; the runner keeps a *)
(* RAM ledger per session (credited outputs, debited, reserved) and signs  *)
(* usage receipts with a strictly increasing seq and a cumulative debit.   *)
(*                                                                         *)
(* Chain: a sequence of blocks, each a set of payment outputs; an output   *)
(* has a fixed session and amount.  Depth of block i at height H is        *)
(* H - i + 1, and an output is CONFIRMED when its depth >= K.  Reorg       *)
(* replaces the last d blocks (d <= MaxReorg) by a same-height fork:       *)
(* dropped outputs return to the mempool, vanish (double-spent away), or   *)
(* reappear in the fork.                                                   *)
(*                                                                         *)
(* Runner: Scan credits one confirmed output (idempotent: the output id is *)
(* the key) and un-credits one that is no longer confirmed, so balance may *)
(* go negative after a deep reorg.  StartReq takes a request counter       *)
(* (replay protection: counter must exceed the high-water mark), reserves  *)
(* cost iff available >= cost, else refuses with a receipt whose           *)
(* cumulative is unchanged.  Settle debits actual <= reserve, releases the *)
(* rest, appends a receipt.  Abort releases the reserve, no receipt.       *)
(* Restart loses RAM: credits are recomputed by rescan, everything else    *)
(* comes back from the persisted snapshot.  PersistOnWrite chooses the     *)
(* design: TRUE persists (debited, receipts, hwm) atomically before the    *)
(* receipt leaves the runner; FALSE snapshots lazily at arbitrary times.   *)
(*                                                                         *)
(* Ghost state (never lost, not part of the design): issued (every receipt *)
(* any client has ever seen), used (counters accepted as fresh), everConf  *)
(* (outputs that have ever been confirmed).                                *)
(***************************************************************************)
EXTENDS Integers, Sequences, FiniteSets

CONSTANTS Sessions,       \* model values
          OutputIds,      \* model values: chain payment outputs (txid,subaddr)
          K,              \* confirmations required before credit
          MaxHeight,      \* bound on chain length
          MaxReorg,       \* deepest reorg the model performs
          MaxAmt,         \* max amount of one payment output
          MaxCost,        \* max reserve of one request
          MaxCtr,         \* request counters are 1..MaxCtr per session
          MaxInflight,    \* concurrent reserved requests per session
          MaxIssued,      \* bound on receipts emitted per session
          PersistOnWrite, \* BOOLEAN: persist before emitting a receipt
          NULL

ASSUME K >= 1 /\ MaxHeight >= K /\ MaxReorg >= 1 /\ MaxReorg <= MaxHeight
ASSUME MaxAmt >= 1 /\ MaxCost >= 1 /\ MaxCtr >= 1 /\ MaxInflight >= 1
ASSUME PersistOnWrite \in BOOLEAN

Output  == [s: Sessions, amt: 1..MaxAmt]
Receipt == [seq: 1..MaxIssued, cum: 0..(MaxCost * MaxIssued)]

VARIABLES
  \* chain
  outs,      \* [OutputIds -> Output \cup {NULL}]: NULL until paid
  mempool,   \* SUBSET OutputIds: paid, not in a block
  chain,     \* Seq(SUBSET OutputIds): block i holds a set of outputs
  \* runner RAM ledger
  credited,  \* SUBSET OutputIds: idempotency index of credited outputs
  balance,   \* [Sessions -> Int]: credited sum - debited (the impl's counter)
  debited,   \* [Sessions -> Nat]: cumulative debit
  reserved,  \* [Sessions -> Nat]: the impl's reserve counter
  inflight,  \* [Sessions -> Seq(1..MaxCost)]: reserves of open requests
  hwm,       \* [Sessions -> 0..MaxCtr]: request-counter high-water mark
  receipts,  \* [Sessions -> Seq(Receipt)]: receipts as the runner knows them
  \* persistence
  snap,      \* [Sessions -> Snap]: last persisted (debited, receipts, hwm)
  \* ghost
  issued,    \* [Sessions -> Seq(Receipt)]: every receipt ever emitted
  used,      \* [Sessions -> SUBSET (1..MaxCtr)]: counters accepted as fresh
  everConf   \* SUBSET OutputIds: outputs that were ever at depth >= K

chainVars  == <<outs, mempool, chain>>
ledgerVars == <<credited, balance, debited, reserved, inflight, hwm, receipts>>
ghostVars  == <<issued, used, everConf>>
vars       == <<chainVars, ledgerVars, snap, ghostVars>>

(* ---- Helpers ---- *)

Min(a, b) == IF a < b THEN a ELSE b

RECURSIVE SumAmt(_)
SumAmt(S) == IF S = {} THEN 0
             ELSE LET o == CHOOSE o \in S : TRUE
                  IN outs[o].amt + SumAmt(S \ {o})

RECURSIVE SumSeq(_)
SumSeq(q) == IF q = <<>> THEN 0 ELSE Head(q) + SumSeq(Tail(q))

RemoveAt(q, i) == SubSeq(q, 1, i - 1) \o SubSeq(q, i + 1, Len(q))

MaxOf(S) == IF S = {} THEN 0 ELSE CHOOSE m \in S : \A x \in S : x <= m

Height == Len(chain)

\* Blocks with depth >= K, i.e. index <= Height - K + 1.
ConfSet == UNION {chain[i] : i \in 1..(Height - K + 1)}

OutsOf(s, S) == {o \in S : outs[o] # NULL /\ outs[o].s = s}

Available(s) == balance[s] - reserved[s]

LiveSnap(s) == [debited |-> debited[s], receipts |-> receipts[s], hwm |-> hwm[s]]

(* ---- Init ---- *)

Init ==
  /\ outs     = [o \in OutputIds |-> NULL]
  /\ mempool  = {}
  /\ chain    = <<>>
  /\ credited = {}
  /\ balance  = [s \in Sessions |-> 0]
  /\ debited  = [s \in Sessions |-> 0]
  /\ reserved = [s \in Sessions |-> 0]
  /\ inflight = [s \in Sessions |-> <<>>]
  /\ hwm      = [s \in Sessions |-> 0]
  /\ receipts = [s \in Sessions |-> <<>>]
  /\ snap     = [s \in Sessions |-> [debited |-> 0, receipts |-> <<>>, hwm |-> 0]]
  /\ issued   = [s \in Sessions |-> <<>>]
  /\ used     = [s \in Sessions |-> {}]
  /\ everConf = {}

(* ---- Chain actions ---- *)

\* A renter pays: a fresh output for some session enters the mempool.
Pay ==
  \E o \in OutputIds, s \in Sessions, amt \in 1..MaxAmt :
    /\ outs[o] = NULL
    /\ outs'    = [outs EXCEPT ![o] = [s |-> s, amt |-> amt]]
    /\ mempool' = mempool \cup {o}
    /\ UNCHANGED <<chain, ledgerVars, snap, ghostVars>>

\* A block is mined holding any subset of the mempool; depth grows.
Confirm ==
  /\ Height < MaxHeight
  /\ \E B \in SUBSET mempool :
       /\ chain'    = Append(chain, B)
       /\ mempool'  = mempool \ B
       /\ everConf' = everConf \cup
                        UNION {chain'[i] : i \in 1..(Height + 1 - K + 1)}
  /\ UNCHANGED <<outs, ledgerVars, snap, issued, used>>

\* The last d blocks are replaced by a competing fork of the same height:
\* dropped outputs go back to the mempool or vanish (double-spent away);
\* the fork's oldest block may carry some of the pool (so a payment can
\* reappear at depth d and be confirmed again), its newer blocks are empty.
Reorg ==
  \E d \in 1..Min(MaxReorg, Height) :
    LET dropped == UNION {chain[i] : i \in (Height - d + 1)..Height}
    IN \E V \in SUBSET dropped :                \* vanished for good
       LET pool == (mempool \cup dropped) \ V
       IN \E B \in SUBSET pool :                \* re-included by the fork
            /\ chain'   = SubSeq(chain, 1, Height - d)
                          \o <<B>> \o [i \in 1..(d - 1) |-> {}]
            /\ mempool' = pool \ B
            /\ everConf' = everConf \cup
                             UNION {chain'[i] : i \in 1..(Height - K + 1)}
            /\ UNCHANGED <<outs, ledgerVars, snap, issued, used>>

(* ---- Runner: watcher ---- *)

\* Credit one confirmed, not-yet-credited output (keyed by output id).
Credit ==
  \E o \in ConfSet \ credited :
    /\ credited' = credited \cup {o}
    /\ balance'  = [balance EXCEPT ![outs[o].s] = @ + outs[o].amt]
    /\ UNCHANGED <<chainVars, debited, reserved, inflight, hwm, receipts,
                   snap, ghostVars>>

\* Un-credit an output that is no longer confirmed (reorg); balance may
\* go negative if it was already spent.
Uncredit ==
  \E o \in credited \ ConfSet :
    /\ credited' = credited \ {o}
    /\ balance'  = [balance EXCEPT ![outs[o].s] = @ - outs[o].amt]
    /\ UNCHANGED <<chainVars, debited, reserved, inflight, hwm, receipts,
                   snap, ghostVars>>

(* ---- Runner: requests ---- *)

Emit(s, r) ==
  /\ receipts' = [receipts EXCEPT ![s] = Append(@, r)]
  /\ issued'   = [issued   EXCEPT ![s] = Append(@, r)]

\* Fresh request counter: reserve if funded, else refuse with a receipt.
StartReq ==
  \E s \in Sessions, ctr \in 1..MaxCtr, cost \in 1..MaxCost :
    /\ ctr > hwm[s]
    /\ hwm'  = [hwm  EXCEPT ![s] = ctr]
    /\ used' = [used EXCEPT ![s] = @ \cup {ctr}]
    /\ IF Available(s) >= cost
       THEN /\ Len(inflight[s]) < MaxInflight
            /\ inflight' = [inflight EXCEPT ![s] = Append(@, cost)]
            /\ reserved' = [reserved EXCEPT ![s] = @ + cost]
            /\ snap' = IF PersistOnWrite
                       THEN [snap EXCEPT ![s] = [@ EXCEPT !.hwm = ctr]]
                       ELSE snap
            /\ UNCHANGED <<receipts, issued>>
       ELSE LET r == [seq |-> Len(receipts[s]) + 1, cum |-> debited[s]]
            IN /\ Len(issued[s]) < MaxIssued
               /\ Emit(s, r)
               /\ snap' = IF PersistOnWrite
                          THEN [snap EXCEPT ![s] = [debited  |-> debited[s],
                                                    receipts |-> Append(receipts[s], r),
                                                    hwm      |-> ctr]]
                          ELSE snap
               /\ UNCHANGED <<inflight, reserved>>
    /\ UNCHANGED <<chainVars, credited, balance, debited, everConf>>

\* A counter at or below the high-water mark: rejected, nothing changes.
Replay ==
  \E s \in Sessions, ctr \in 1..MaxCtr :
    /\ ctr <= hwm[s]
    /\ UNCHANGED vars

\* Upstream finished: debit actual <= reserve, release the rest, receipt.
Settle ==
  \E s \in Sessions : \E i \in 1..Len(inflight[s]) :
    \E actual \in 0..inflight[s][i] :
      /\ Len(issued[s]) < MaxIssued
      /\ debited'  = [debited  EXCEPT ![s] = @ + actual]
      /\ balance'  = [balance  EXCEPT ![s] = @ - actual]
      /\ reserved' = [reserved EXCEPT ![s] = @ - inflight[s][i]]
      /\ inflight' = [inflight EXCEPT ![s] = RemoveAt(@, i)]
      /\ LET r == [seq |-> Len(receipts[s]) + 1, cum |-> debited[s] + actual]
         IN /\ Emit(s, r)
            /\ snap' = IF PersistOnWrite
                       THEN [snap EXCEPT ![s] = [debited  |-> debited[s] + actual,
                                                 receipts |-> Append(receipts[s], r),
                                                 hwm      |-> hwm[s]]]
                       ELSE snap
      /\ UNCHANGED <<chainVars, credited, hwm, used, everConf>>

\* Upstream error / client gone before the final frame: release only.
Abort ==
  \E s \in Sessions : \E i \in 1..Len(inflight[s]) :
    /\ reserved' = [reserved EXCEPT ![s] = @ - inflight[s][i]]
    /\ inflight' = [inflight EXCEPT ![s] = RemoveAt(@, i)]
    /\ UNCHANGED <<chainVars, credited, balance, debited, hwm, receipts,
                   snap, ghostVars>>

(* ---- Persistence and restart ---- *)

\* Lazy design only: snapshot a session's durable state at some moment.
Persist ==
  /\ ~PersistOnWrite
  /\ \E s \in Sessions :
       /\ snap[s] # LiveSnap(s)
       /\ snap' = [snap EXCEPT ![s] = LiveSnap(s)]
  /\ UNCHANGED <<chainVars, ledgerVars, ghostVars>>

\* Crash + restore: RAM is gone.  Credits are rebuilt by a full rescan of
\* the chain at depth >= K; debited/receipts/hwm come from the snapshot;
\* in-flight reservations are simply gone (their upstream calls died).
Restart ==
  /\ credited' = ConfSet
  /\ balance'  = [s \in Sessions |-> SumAmt(OutsOf(s, ConfSet)) - snap[s].debited]
  /\ debited'  = [s \in Sessions |-> snap[s].debited]
  /\ receipts' = [s \in Sessions |-> snap[s].receipts]
  /\ hwm'      = [s \in Sessions |-> snap[s].hwm]
  /\ reserved' = [s \in Sessions |-> 0]
  /\ inflight' = [s \in Sessions |-> <<>>]
  /\ UNCHANGED <<chainVars, snap, ghostVars>>

Next ==
  \/ Pay \/ Confirm \/ Reorg
  \/ Credit \/ Uncredit
  \/ StartReq \/ Replay \/ Settle \/ Abort
  \/ Persist \/ Restart

Spec == Init /\ [][Next]_vars

(* ---- Invariants ---- *)

TypeOK ==
  /\ outs \in [OutputIds -> Output \cup {NULL}]
  /\ mempool \subseteq OutputIds
  /\ Len(chain) <= MaxHeight
  /\ \A i \in 1..Len(chain) : chain[i] \subseteq OutputIds
  /\ credited \subseteq OutputIds
  /\ balance \in [Sessions -> Int]
  /\ debited \in [Sessions -> Nat]
  /\ reserved \in [Sessions -> Nat]
  /\ \A s \in Sessions :
       /\ Len(inflight[s]) <= MaxInflight
       /\ \A i \in 1..Len(inflight[s]) : inflight[s][i] \in 1..MaxCost
       /\ \A i \in 1..Len(receipts[s]) : receipts[s][i] \in Receipt
       /\ snap[s].debited \in 0..(MaxCost * MaxIssued)
       /\ snap[s].hwm \in 0..MaxCtr
       /\ \A i \in 1..Len(snap[s].receipts) : snap[s].receipts[i] \in Receipt
  /\ hwm \in [Sessions -> 0..MaxCtr]
  /\ everConf \subseteq OutputIds

\* An output sits in at most one place: mempool, one block, or nowhere.
ChainWellFormed ==
  /\ \A i, j \in 1..Height : i # j => chain[i] \cap chain[j] = {}
  /\ \A i \in 1..Height : chain[i] \cap mempool = {}
  /\ \A o \in mempool \cup UNION {chain[i] : i \in 1..Height} : outs[o] # NULL

\* (1) Money spent or held on a session's behalf never exceeds payments
\* that were confirmed (depth >= K) at some point.  This is what survives
\* a reorg deeper than K: the loss is bounded by once-confirmed money, and
\* no unconfirmed (mempool / shallow) output ever backs a debit.
SpentWithinConfirmed ==
  \A s \in Sessions :
    debited[s] + reserved[s] <= SumAmt(OutsOf(s, everConf))

\* (1') Under the finality assumption (reorgs shallower than K) the strong
\* form holds: spent + held <= money credited AND currently confirmed.
SolventUnderFinality ==
  MaxReorg < K =>
    \A s \in Sessions :
      debited[s] + reserved[s] <= SumAmt(OutsOf(s, credited \cap ConfSet))

\* (2) Every credited output is credited once: the balance counter equals
\* the sum over the idempotency index, minus debits.  Double credit (e.g.
\* a persisted credit counter plus a rescan) breaks this immediately.
NoDoubleCredit ==
  \A s \in Sessions :
    balance[s] = SumAmt(OutsOf(s, credited)) - debited[s]

\* Credits only ever come from outputs that have been confirmed.
CreditedWasConfirmed == credited \subseteq everConf

\* No reserve leak: the reserve counter is exactly the open requests.
ReservedMatchesInflight ==
  \A s \in Sessions : reserved[s] = SumSeq(inflight[s])

\* (3) Receipts as clients see them: seq strictly increasing, cumulative
\* never decreasing, across restarts.
IssuedMonotone ==
  \A s \in Sessions :
    \A i, j \in 1..Len(issued[s]) :
      i < j => /\ issued[s][i].seq < issued[s][j].seq
               /\ issued[s][i].cum <= issued[s][j].cum

\* (3') The runner's view: seq = position, last cumulative = debited, and
\* the persisted snapshot never runs ahead of RAM.
ReceiptsConsistent ==
  \A s \in Sessions :
    /\ \A i \in 1..Len(receipts[s]) : receipts[s][i].seq = i
    /\ (Len(receipts[s]) = 0 => debited[s] = 0)
    /\ (Len(receipts[s]) > 0 => receipts[s][Len(receipts[s])].cum = debited[s])
    /\ snap[s].debited <= debited[s]
    /\ snap[s].hwm <= hwm[s]
    /\ Len(snap[s].receipts) <= Len(receipts[s])
    /\ \A i \in 1..Len(snap[s].receipts) : snap[s].receipts[i] = receipts[s][i]

\* Persist-before-emit: the runner's receipts are exactly what was issued.
ReceiptsDurable ==
  PersistOnWrite => \A s \in Sessions : receipts[s] = issued[s]

\* (4) Replay protection: the high-water mark is the largest counter ever
\* accepted (so every counter at or below it is rejected), and no counter
\* yields more than one receipt.
ReplaySafe ==
  \A s \in Sessions :
    /\ hwm[s] = MaxOf(used[s])
    /\ Len(issued[s]) <= Cardinality(used[s])

\* Admission: a reserve is only ever taken out of available funds, and a
\* negative balance (post-reorg) admits nothing.
NoOverdraftAdmission ==
  [][\A s \in Sessions :
       reserved'[s] > reserved[s] =>
         reserved'[s] - reserved[s] <= Available(s)]_vars

====
