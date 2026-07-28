---- MODULE ForkRefs ----
(***************************************************************************)
(* Ref-update protocol for a forkable git-backed site.                     *)
(*                                                                         *)
(* One repo per site.  Refs: "main" (the live site) plus one fork ref per  *)
(* user.  Every write is a compare-and-swap push (user, ref, old, new):    *)
(* the server applies it iff the ref currently equals `old` AND the        *)
(* permission predicate holds.  Fork creation is a push over NoCommit.     *)
(* AcceptProposal models the owner merging a fork: main is atomically set  *)
(* to the fork's head.                                                     *)
(*                                                                         *)
(* Scenario modeled: two devices of the same user racing CAS pushes to     *)
(* that user's fork ref, one owner device pushing main, and one non-owner  *)
(* device attempting main (must always be rejected by permissions).        *)
(***************************************************************************)
EXTENDS Naturals, Sequences, TLC

NoCommit  == 0
MaxCommit == 6                        \* commit ids 1..MaxCommit; 0 = absent
Commits   == 0..MaxCommit

Owner == "o"
UserA == "a"
Users == {Owner, UserA}

MainRef    == "main"
ForkRef(u) == "fork_" \o u
RefIds     == {MainRef} \cup {ForkRef(u) : u \in Users}

(* The server-side permission predicate: main is owner-only, fork_u is     *)
(* writable only by u.  Reads are unrestricted (fetch has no guard).       *)
Permitted(u, r) == IF r = MainRef THEN u = Owner ELSE r = ForkRef(u)

(* Devices: d1,d2 = two devices of UserA racing on UserA's fork;           *)
(* od = the owner pushing main; xd = UserA illegally attempting main.      *)
Devices   == {"d1", "d2", "od", "xd"}
DevUser   == ("d1" :> UserA) @@ ("d2" :> UserA) @@
             ("od" :> Owner) @@ ("xd" :> UserA)
DevTarget == ("d1" :> ForkRef(UserA)) @@ ("d2" :> ForkRef(UserA)) @@
             ("od" :> MainRef)        @@ ("xd" :> MainRef)
DevBudget == ("d1" :> 2) @@ ("d2" :> 1) @@ ("od" :> 1) @@ ("xd" :> 1)

MaxAccepts == 1

(* main starts with a root commit 1; fork refs start absent. *)
InitRef == [r \in RefIds |-> IF r = MainRef THEN 1 ELSE NoCommit]

VARIABLES
  refs,        \* [RefIds -> Commits]: current ref values on the server
  parent,      \* [1..nextCommit-1 -> Commits]: ancestry (parent of each commit)
  nextCommit,  \* next fresh commit id
  dev,         \* per-device client state machine
  hist,        \* history variable: every successful server-side write
  accepts      \* number of AcceptProposal actions taken

vars == <<refs, parent, nextCommit, dev, hist, accepts>>

DevStates == [phase: {"idle", "fetched", "committed"},
              base: Commits, new: Commits, tries: 0..2]

WriteEvents == [ref: RefIds, writer: Users, old: Commits, new: Commits,
                kind: {"push", "accept"}]

TypeOK ==
  /\ refs \in [RefIds -> Commits]
  /\ nextCommit \in 2..(MaxCommit + 1)
  /\ parent \in [1..(nextCommit - 1) -> Commits]
  /\ dev \in [Devices -> DevStates]
  /\ hist \in Seq(WriteEvents)
  /\ accepts \in 0..MaxAccepts

Init ==
  /\ refs = InitRef
  /\ parent = (1 :> NoCommit)
  /\ nextCommit = 2
  /\ dev = [d \in Devices |->
             [phase |-> "idle", base |-> NoCommit, new |-> NoCommit, tries |-> 0]]
  /\ hist = <<>>
  /\ accepts = 0

(* Client: read the current value of the target ref (anyone can read). *)
Fetch(d) ==
  /\ dev[d].phase = "idle"
  /\ dev[d].tries < DevBudget[d]
  /\ dev' = [dev EXCEPT ![d].phase = "fetched", ![d].base = refs[DevTarget[d]]]
  /\ UNCHANGED <<refs, parent, nextCommit, hist, accepts>>

(* Client: create a local commit whose parent is the fetched value        *)
(* (a fast-forward candidate; parent NoCommit means a fork's root).       *)
MakeCommit(d) ==
  /\ dev[d].phase = "fetched"
  /\ nextCommit <= MaxCommit
  /\ parent' = parent @@ (nextCommit :> dev[d].base)
  /\ dev' = [dev EXCEPT ![d].phase = "committed", ![d].new = nextCommit]
  /\ nextCommit' = nextCommit + 1
  /\ UNCHANGED <<refs, hist, accepts>>

(* Server: apply the push.  The CAS test, the permission test, and the    *)
(* ref update happen in ONE atomic action -- this is the atomicity the    *)
(* implementation must provide (e.g. a transactional ref store).          *)
PushOK(d) ==
  LET r == DevTarget[d]
      u == DevUser[d]
  IN /\ dev[d].phase = "committed"
     /\ refs[r] = dev[d].base          \* CAS: ref unchanged since fetch
     /\ Permitted(u, r)                \* permission predicate
     /\ refs' = [refs EXCEPT ![r] = dev[d].new]
     /\ hist' = Append(hist, [ref |-> r, writer |-> u, old |-> dev[d].base,
                              new |-> dev[d].new, kind |-> "push"])
     /\ dev' = [dev EXCEPT ![d].phase = "idle", ![d].base = NoCommit,
                           ![d].new = NoCommit, ![d].tries = @ + 1]
     /\ UNCHANGED <<parent, nextCommit, accepts>>

(* Server: reject the push (stale old value or no permission).  Clean     *)
(* failure: no server state changes; the client may retry by re-fetching. *)
PushRejected(d) ==
  LET r == DevTarget[d]
  IN /\ dev[d].phase = "committed"
     /\ (refs[r] # dev[d].base \/ ~Permitted(DevUser[d], r))
     /\ dev' = [dev EXCEPT ![d].phase = "idle", ![d].base = NoCommit,
                           ![d].new = NoCommit, ![d].tries = @ + 1]
     /\ UNCHANGED <<refs, parent, nextCommit, hist, accepts>>

(* Owner accepts a merge proposal: main is atomically set to the head of  *)
(* UserA's fork.  Owner-only; reading the fork head and writing main are  *)
(* one atomic step (same transactional requirement as PushOK).            *)
AcceptProposal ==
  LET f == ForkRef(UserA)
  IN /\ accepts < MaxAccepts
     /\ refs[f] # NoCommit
     /\ refs[f] # refs[MainRef]
     /\ Permitted(Owner, MainRef)
     /\ refs' = [refs EXCEPT ![MainRef] = refs[f]]
     /\ hist' = Append(hist, [ref |-> MainRef, writer |-> Owner,
                              old |-> refs[MainRef], new |-> refs[f],
                              kind |-> "accept"])
     /\ accepts' = accepts + 1
     /\ UNCHANGED <<parent, nextCommit, dev>>

Next ==
  \/ \E d \in Devices : Fetch(d) \/ MakeCommit(d) \/ PushOK(d) \/ PushRejected(d)
  \/ AcceptProposal

Spec == Init /\ [][Next]_vars

----------------------------------------------------------------------------
(* Invariants *)

(* main's history is only ever changed by the owner (pushes and accepts). *)
MainWrittenOnlyByOwner ==
  \A i \in DOMAIN hist :
    hist[i].ref = MainRef => hist[i].writer = Owner

(* fork_u is only ever written by user u. *)
ForkWrittenOnlyByItsUser ==
  \A i \in DOMAIN hist :
    hist[i].ref # MainRef => hist[i].ref = ForkRef(hist[i].writer)

Max(S) == CHOOSE x \in S : \A y \in S : y <= x

(* CAS atomicity / no lost update: every successful write's `old` is      *)
(* exactly the ref's value at apply time, i.e. per ref the history forms  *)
(* an unbroken chain from the initial value.  A successful push therefore *)
(* never overwrites a value its pusher did not see.                       *)
NoLostUpdate ==
  \A i \in DOMAIN hist :
    LET prev == {j \in DOMAIN hist : j < i /\ hist[j].ref = hist[i].ref}
    IN IF prev = {} THEN hist[i].old = InitRef[hist[i].ref]
                    ELSE hist[i].old = hist[Max(prev)].new

(* Every successful CAS push is a fast-forward: the new commit's parent   *)
(* is the value pushed over.  (Accepts are exempt: a merge proposal moves *)
(* main to a fork head whose parent chain need not include old main.)     *)
PushIsFastForward ==
  \A i \in DOMAIN hist :
    hist[i].kind = "push" => parent[hist[i].new] = hist[i].old

(* Sanity: the live ref values are exactly what the history says. *)
RefsMatchHistory ==
  \A r \in RefIds :
    LET evs == {i \in DOMAIN hist : hist[i].ref = r}
    IN IF evs = {} THEN refs[r] = InitRef[r]
                   ELSE refs[r] = hist[Max(evs)].new

====