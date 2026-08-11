---------------------------- MODULE BacktalkGroups ----------------------------
(***************************************************************************)
(* Error-event ingestion into error groups on D1 (SQLite).  Multiple       *)
(* stateless workers ingest events concurrently; a resolver concurrently   *)
(* marks groups resolved.  There are NO cross-statement transactions:      *)
(* each SQL statement is atomic, statements from different requests        *)
(* interleave freely.                                                      *)
(*                                                                         *)
(* Ingest sequence per event (each step = one atomic SQL statement):       *)
(*   s1: INSERT OR IGNORE INTO error_events (id, ...)                      *)
(*       id is a client UUID; retries reuse it.  changes=0 => STOP.        *)
(*   s2: INSERT OR IGNORE INTO error_groups (id, status='open', count=0)   *)
(*       group id is deterministic hash(project, fingerprint), so          *)
(*       concurrent creators collide harmlessly.                           *)
(*   s3: UPDATE error_groups SET event_count = event_count + 1,            *)
(*         status = CASE WHEN status='resolved' THEN 'regressed'           *)
(*                  ELSE status END WHERE id = ?                           *)
(*                                                                         *)
(* Variant = "atomic": s3 is the single conditional UPDATE above (the      *)
(* real design).  Variant = "naive": s3 is split into a SELECT of status   *)
(* followed by a write that decides regression from the READ value; TLC    *)
(* finds the race where a resolve lands between read and write and the     *)
(* resolved->regressed transition is lost (NoMissedRegression).            *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
  Variant,      \* "atomic" (real design) or "naive" (read-then-write s3)
  MaxResolves   \* bound on resolver actions, keeps the model finite

ASSUME Variant \in {"atomic", "naive"}

(* Small fixed world: 3 event ids over 2 fingerprints; e1 is retried.     *)
Events   == {"e1", "e2", "e3"}
Fps      == {"f1", "f2"}
FpOf     == [e \in Events |-> IF e = "e3" THEN "f2" ELSE "f1"]
Workers  == {"w1", "w2"}
\* Each worker processes its queue of ingest attempts; both queues start
\* with e1, modeling a client retry that reuses the same event id.
Queue    == [w \in Workers |-> IF w = "w1" THEN <<"e1", "e2">> ELSE <<"e1", "e3">>]
QLen     == 2

GroupId(fp) == fp   \* hash(project, fingerprint): deterministic, injective
Statuses    == {"open", "resolved", "regressed"}

VARIABLES
  events,       \* rows in error_events: set of accepted event ids
  groups,       \* rows in error_groups: set of [id, fp, status, count]
  idx,          \* per worker: position in its attempt queue
  pc,           \* per worker: next statement ("s1","s2","s3","s3w")
  readSt,       \* per worker: status read by naive s3 ("none" when idle)
  done,         \* event ids whose s3 update has completed
  dirty,        \* per fp: TRUE iff some ingest completed s3 since the
                \* group's most recent resolve (history for the invariant)
  resolvesLeft  \* resolver budget

vars == <<events, groups, idx, pc, readSt, done, dirty, resolvesLeft>>

GroupRec == [id: Fps, fp: Fps, status: Statuses, count: 0..Cardinality(Events)]

Active(w)   == idx[w] <= QLen
CurEv(w)    == Queue[w][idx[w]]
CurFp(w)    == FpOf[CurEv(w)]
HasGroup(f) == \E g \in groups : g.id = GroupId(f)
GrpOf(f)    == CHOOSE g \in groups : g.id = GroupId(f)

NextAttempt(w) ==
  /\ idx' = [idx EXCEPT ![w] = @ + 1]
  /\ pc'  = [pc  EXCEPT ![w] = "s1"]

Init ==
  /\ events = {}
  /\ groups = {}
  /\ idx    = [w \in Workers |-> 1]
  /\ pc     = [w \in Workers |-> "s1"]
  /\ readSt = [w \in Workers |-> "none"]
  /\ done   = {}
  /\ dirty  = [f \in Fps |-> FALSE]
  /\ resolvesLeft = MaxResolves

(* s1: INSERT OR IGNORE INTO error_events.  Duplicate id => changes=0 =>  *)
(* the worker stops this attempt and moves on.                            *)
S1(w) ==
  /\ Active(w) /\ pc[w] = "s1"
  /\ IF CurEv(w) \in events
       THEN /\ NextAttempt(w)
            /\ UNCHANGED <<events, groups, readSt, done, dirty, resolvesLeft>>
       ELSE /\ events' = events \cup {CurEv(w)}
            /\ pc' = [pc EXCEPT ![w] = "s2"]
            /\ UNCHANGED <<groups, idx, readSt, done, dirty, resolvesLeft>>

(* s2: INSERT OR IGNORE INTO error_groups with deterministic id.          *)
S2(w) ==
  /\ Active(w) /\ pc[w] = "s2"
  /\ groups' = IF HasGroup(CurFp(w))
                 THEN groups
                 ELSE groups \cup {[id |-> GroupId(CurFp(w)), fp |-> CurFp(w),
                                    status |-> "open", count |-> 0]}
  /\ pc' = [pc EXCEPT ![w] = "s3"]
  /\ UNCHANGED <<events, idx, readSt, done, dirty, resolvesLeft>>

(* s3, real design: one atomic conditional UPDATE.                        *)
S3Atomic(w) ==
  /\ Variant = "atomic"
  /\ Active(w) /\ pc[w] = "s3"
  /\ LET g == GrpOf(CurFp(w)) IN
       groups' = (groups \ {g}) \cup
         {[g EXCEPT !.count  = @ + 1,
                    !.status = IF @ = "resolved" THEN "regressed" ELSE @]}
  /\ done'  = done \cup {CurEv(w)}
  /\ dirty' = [dirty EXCEPT ![CurFp(w)] = TRUE]
  /\ NextAttempt(w)
  /\ UNCHANGED <<events, readSt, resolvesLeft>>

(* s3, naive variant, first half: SELECT status.                          *)
S3ReadNaive(w) ==
  /\ Variant = "naive"
  /\ Active(w) /\ pc[w] = "s3"
  /\ readSt' = [readSt EXCEPT ![w] = GrpOf(CurFp(w)).status]
  /\ pc' = [pc EXCEPT ![w] = "s3w"]
  /\ UNCHANGED <<events, groups, idx, done, dirty, resolvesLeft>>

(* s3, naive variant, second half: increment count and flip to regressed  *)
(* only if the READ said resolved.  A resolve between read and write is   *)
(* invisible here, so the resolved->regressed transition is lost.         *)
S3WriteNaive(w) ==
  /\ Active(w) /\ pc[w] = "s3w"
  /\ LET g == GrpOf(CurFp(w)) IN
       groups' = (groups \ {g}) \cup
         {[g EXCEPT !.count  = @ + 1,
                    !.status = IF readSt[w] = "resolved" THEN "regressed" ELSE @]}
  /\ done'   = done \cup {CurEv(w)}
  /\ dirty'  = [dirty EXCEPT ![CurFp(w)] = TRUE]
  /\ readSt' = [readSt EXCEPT ![w] = "none"]
  /\ NextAttempt(w)
  /\ UNCHANGED <<events, resolvesLeft>>

(* Resolver: one atomic statement, legal from 'open' or 'regressed'.      *)
Resolve ==
  /\ resolvesLeft > 0
  /\ \E g \in groups :
       /\ g.status \in {"open", "regressed"}
       /\ groups' = (groups \ {g}) \cup {[g EXCEPT !.status = "resolved"]}
       /\ dirty'  = [dirty EXCEPT ![g.fp] = FALSE]
  /\ resolvesLeft' = resolvesLeft - 1
  /\ UNCHANGED <<events, idx, pc, readSt, done>>

Next ==
  \/ \E w \in Workers :
       S1(w) \/ S2(w) \/ S3Atomic(w) \/ S3ReadNaive(w) \/ S3WriteNaive(w)
  \/ Resolve

Spec == Init /\ [][Next]_vars

----------------------------------------------------------------------------
(* Invariants *)

TypeOK ==
  /\ events \subseteq Events
  /\ groups \subseteq GroupRec
  /\ idx    \in [Workers -> 1..(QLen + 1)]
  /\ pc     \in [Workers -> {"s1", "s2", "s3", "s3w"}]
  /\ readSt \in [Workers -> Statuses \cup {"none"}]
  /\ done   \subseteq events
  /\ dirty  \in [Fps -> BOOLEAN]
  /\ resolvesLeft \in 0..MaxResolves

\* Deterministic group ids make concurrent creators collide harmlessly:
\* a fingerprint never gets two group rows.
OneGroupPerFingerprint ==
  \A f \in Fps : Cardinality({g \in groups : g.fp = f}) <= 1

\* event_count is exactly the number of DISTINCT accepted event ids of the
\* group's fingerprint whose s3 update has completed: no retry double
\* counts, no lost increments.
CountExact ==
  \A g \in groups : g.count = Cardinality({e \in done : FpOf[e] = g.fp})

\* If an ingest completed s3 after the group's most recent resolve, the
\* group must not still read 'resolved' (the update must have regressed
\* it, or a later resolve must have cleared dirty).
NoMissedRegression ==
  \A g \in groups : dirty[g.fp] => g.status # "resolved"

============================================================================
