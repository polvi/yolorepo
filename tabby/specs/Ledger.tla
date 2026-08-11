---- MODULE Ledger ----
(***************************************************************************)
(* The tabby group-expense ledger (Splitwise-style), balances derived.     *)
(*                                                                         *)
(* Balances are never stored: Net(u) is derived from the expense log and   *)
(* the payments table.  Expenses split by the exact remainder rule (first  *)
(* amt % n participants in a fixed user ordering pay one extra unit).      *)
(* Payments are keyed by a client-generated id: Propose binds a transfer   *)
(* suggested by greedy settlement over CURRENT nets to a fresh id; Submit  *)
(* records it iff the id is unset (SQL INSERT OR IGNORE); Resubmit is a    *)
(* no-op.  AddExpense may interleave with Propose/Submit, so a payment can *)
(* be recorded against a stale suggestion -- conservation must still hold. *)
(* Payment method (XMR vs cash) and recorder (payer or recipient) are      *)
(* metadata: both reach the ledger as the same idempotent Transfer row.    *)
(* Cash adds ProposeCash: an ARBITRARY transfer ("they handed me $300")    *)
(* bound to a fresh id, unconstrained by the greedy suggestions, so nets   *)
(* may overshoot and flip sign -- conservation must survive that too.     *)
(***************************************************************************)
EXTENDS Integers, Sequences, FiniteSets

CONSTANTS Users,        \* model values: group members
          MaxAmt,       \* max single-expense amount (abstract units)
          MaxExpenses,  \* bound on the expense log
          PaymentIds,   \* model values: client-generated payment ids
          NULL          \* absent row / unbound attempt

ASSUME MaxAmt >= 1 /\ MaxExpenses >= 1

(* ---- Fixed deterministic user ordering (models ORDER BY user id) ---- *)

RECURSIVE SetToSeq(_)
SetToSeq(S) == IF S = {} THEN <<>>
               ELSE LET x == CHOOSE x \in S : TRUE
                    IN <<x>> \o SetToSeq(S \ {x})

UserSeq == SetToSeq(Users)
NU      == Cardinality(Users)
Idx(u)  == CHOOSE i \in 1..NU : UserSeq[i] = u
PidSeq  == SetToSeq(PaymentIds)

Min(a, b) == IF a < b THEN a ELSE b

RECURSIVE SumSeq(_)
SumSeq(s) == IF s = <<>> THEN 0 ELSE Head(s) + SumSeq(Tail(s))

MaxTotal == MaxAmt * MaxExpenses

\* Multi-person expenses only: single-participant expenses shift one
\* pairwise IOU and exercise no remainder/settlement structure; excluding
\* them keeps the model finite-small.
SplitSets == {P \in SUBSET Users : Cardinality(P) >= 2}
Expense   == [payer: Users, parts: SplitSets, amt: 1..MaxAmt]
Transfer  == [from: Users, to: Users, amt: 1..(2 * MaxTotal)]

VARIABLES
  expenses,  \* Seq(Expense): append-only expense log
  payments,  \* [PaymentIds -> Transfer \cup {NULL}]: recorded payment rows
  attempts   \* [PaymentIds -> Transfer \cup {NULL}]: transfer bound at propose

vars == <<expenses, payments, attempts>>

(* ---- Exact remainder split rule ---- *)

ShareOf(e, u) ==
  IF u \notin e.parts THEN 0
  ELSE LET n    == Cardinality(e.parts)
           base == e.amt \div n
           r    == e.amt % n
           pseq == SelectSeq(UserSeq, LAMBDA v : v \in e.parts)
           k    == CHOOSE i \in 1..n : pseq[i] = u
       IN base + (IF k <= r THEN 1 ELSE 0)

(* ---- Derived balances (never stored) ---- *)

Paid(u) == SumSeq([i \in 1..Len(expenses) |->
             IF expenses[i].payer = u THEN expenses[i].amt ELSE 0])
Owed(u) == SumSeq([i \in 1..Len(expenses) |-> ShareOf(expenses[i], u)])
Sent(u) == SumSeq([i \in 1..Len(PidSeq) |->
             LET p == payments[PidSeq[i]]
             IN IF p # NULL /\ p.from = u THEN p.amt ELSE 0])
Recv(u) == SumSeq([i \in 1..Len(PidSeq) |->
             LET p == payments[PidSeq[i]]
             IN IF p # NULL /\ p.to = u THEN p.amt ELSE 0])

Net(u) == Paid(u) - Owed(u) + Sent(u) - Recv(u)
NetF   == [u \in Users |-> Net(u)]

(* ---- Greedy settlement: largest debtor pays largest creditor,        ---- *)
(* ---- deterministic tiebreak by user order                            ---- *)

RECURSIVE GreedyRec(_)
GreedyRec(f) ==
  IF \A u \in Users : f[u] = 0 THEN <<>>
  ELSE LET debtors   == {u \in Users : f[u] < 0}
           creditors == {u \in Users : f[u] > 0}
           d == CHOOSE u \in debtors :
                  \A v \in debtors :
                    f[u] < f[v] \/ (f[u] = f[v] /\ Idx(u) <= Idx(v))
           c == CHOOSE u \in creditors :
                  \A v \in creditors :
                    f[u] > f[v] \/ (f[u] = f[v] /\ Idx(u) <= Idx(v))
           m == Min(0 - f[d], f[c])
       IN <<[from |-> d, to |-> c, amt |-> m]>>
            \o GreedyRec([f EXCEPT ![d] = @ + m, ![c] = @ - m])

RECURSIVE ApplyRec(_, _)
ApplyRec(f, ts) ==
  IF ts = <<>> THEN f
  ELSE LET t == Head(ts)
       IN ApplyRec([f EXCEPT ![t.from] = @ + t.amt, ![t.to] = @ - t.amt],
                   Tail(ts))

(* ---- Actions ---- *)

Init ==
  /\ expenses = <<>>
  /\ payments = [id \in PaymentIds |-> NULL]
  /\ attempts = [id \in PaymentIds |-> NULL]

AddExpense ==
  /\ Len(expenses) < MaxExpenses
  /\ \E e \in Expense : expenses' = Append(expenses, e)
  /\ UNCHANGED <<payments, attempts>>

\* A client renders the greedy settlement over CURRENT nets and binds one
\* of its suggested transfers to a fresh client-generated id.  Nets may
\* change (AddExpense) before the submit lands: the stale-suggestion race.
\* (\E f \in {NetF} forces the derived nets to a concrete value before the
\* recursive settlement walks over them.)
ProposePayment ==
  \E id \in PaymentIds :
    /\ attempts[id] = NULL
    /\ \E f \in {NetF} :
         LET ts == GreedyRec(f)
         IN /\ ts # <<>>
            /\ \E i \in 1..Len(ts) :
                 attempts' = [attempts EXCEPT ![id] = ts[i]]
    /\ UNCHANGED <<expenses, payments>>

\* Cash settles out-of-band at any amount, recorded by either party: the
\* bound transfer is arbitrary, not one of the greedy suggestions.
ProposeCash ==
  \E id \in PaymentIds :
    /\ attempts[id] = NULL
    /\ \E from \in Users, to \in Users, amt \in 1..MaxAmt :
         /\ from # to
         /\ attempts' = [attempts EXCEPT ![id] = [from |-> from, to |-> to, amt |-> amt]]
    /\ UNCHANGED <<expenses, payments>>

\* INSERT OR IGNORE: the row is written iff the id is unset.
SubmitPayment ==
  \E id \in PaymentIds :
    /\ attempts[id] # NULL
    /\ payments[id] = NULL
    /\ payments' = [payments EXCEPT ![id] = attempts[id]]
    /\ UNCHANGED <<expenses, attempts>>

\* Redelivery of an already-recorded id (double tap / network retry):
\* the IGNORE branch fires and nothing changes.
ResubmitPayment ==
  \E id \in PaymentIds :
    /\ attempts[id] # NULL
    /\ payments[id] # NULL
    /\ payments' = payments
    /\ UNCHANGED <<expenses, attempts>>

Next == AddExpense \/ ProposePayment \/ ProposeCash \/ SubmitPayment \/ ResubmitPayment

Spec == Init /\ [][Next]_vars

(* ---- Invariants ---- *)

TypeOK ==
  /\ Len(expenses) <= MaxExpenses
  /\ \A i \in 1..Len(expenses) : expenses[i] \in Expense
  /\ payments \in [PaymentIds -> Transfer \cup {NULL}]
  /\ attempts \in [PaymentIds -> Transfer \cup {NULL}]

\* Money is conserved: derived nets always sum to zero, even when a
\* payment was recorded against a stale suggestion.
Conservation == SumSeq([i \in 1..NU |-> Net(UserSeq[i])]) = 0

\* The remainder rule distributes every expense exactly.
SharesExact ==
  \A i \in 1..Len(expenses) :
    SumSeq([k \in 1..NU |-> ShareOf(expenses[i], UserSeq[k])]) = expenses[i].amt

\* Greedy settlement zeroes all nets in at most |Users|-1 transfers.
SettlementSound ==
  \A f \in {NetF} :
    LET ts == GreedyRec(f)
    IN /\ Len(ts) <= NU - 1
       /\ \A u \in Users : ApplyRec(f, ts)[u] = 0

\* A recorded row is exactly the attempt bound to its id.
IdempotentPayments ==
  \A id \in PaymentIds : payments[id] # NULL => payments[id] = attempts[id]

\* Once written, a payment row never changes (action property).
NoOverwrite ==
  [][\A id \in PaymentIds :
       payments[id] # NULL => payments'[id] = payments[id]]_vars

====
