------------------------------- MODULE Hub -------------------------------
(***************************************************************************)
(* TLA hub publishing feature for the tlc-rs Cloudflare Worker MCP server. *)
(* Safety subset: users authenticate for an API key, each user has a       *)
(* publish flag (default on).  A check request for a named module either   *)
(* passes or fails.  On a passing check by an authenticated user whose     *)
(* publish flag is on and who did not opt out, a generation is recorded    *)
(* for (user, module) — unless the content equals the latest generation's  *)
(* content (dedupe).  A (user, module)'s generations are visible on the    *)
(* hub iff the user's publish flag is currently on.                        *)
(*                                                                         *)
(* Wins (tlc_report_win): an authenticated user may record a "win" against *)
(* one of their own published specs, citing a generation g with            *)
(* 1 <= g <= latest (the worker defaults g to latest when omitted).        *)
(* Ownership is structural: the D1 lookup is keyed by the caller's         *)
(* user_id, so a win row can only ever attach to the reporter's own spec.  *)
(* Generations are immutable and latest is monotone, so a recorded win     *)
(* must keep pointing at a valid generation forever, even as further       *)
(* generations are published.  Wins are visible on the hub only while the  *)
(* owning user's publish flag is on (same query-time join as specs).       *)
(*                                                                         *)
(* Rejected requests (failed/opted-out/unauthorized checks, out-of-range   *)
(* or unauthenticated win reports) change no state and are modeled as      *)
(* stutter steps; the acceptance rules are checked by the SafePublish and  *)
(* WinAddSound action properties on every transition.  Earlier revisions   *)
(* recorded the last request in observer variables, which multiplied the   *)
(* state space past the checker's budget.                                  *)
(***************************************************************************)
EXTENDS Naturals, Sequences

CONSTANTS
    Users,      \* model values, e.g. {u1, u2}
    Modules,    \* model values, e.g. {m1}
    Content,    \* content universe, e.g. {"c1", "c2"}
    MaxGen      \* bound on latest generation number (state constraint)

VARIABLES
    authed,     \* [Users -> BOOLEAN]        user holds an API key
    pubFlag,    \* [Users -> BOOLEAN]        publish flag (default TRUE)
    latest,     \* [UM -> Nat]               latest generation number
    gens,       \* [UM -> Seq(Content)]      gens[um][i] = content of gen i
    hub,        \* [UM -> SUBSET Nat]        generation numbers visible on hub
    wins        \* SUBSET WinRecord          recorded wins (D1 wins table)

vars == <<authed, pubFlag, latest, gens, hub, wins>>

UM == Users \X Modules

\* A stored win row: wins(spec_id -> (user, module), gen).
WinRecord == [user : Users, module : Modules, gen : 1..MaxGen]

TypeOK ==
    /\ authed  \in [Users -> BOOLEAN]
    /\ pubFlag \in [Users -> BOOLEAN]
    /\ latest  \in [UM -> Nat]
    /\ gens    \in [UM -> Seq(Content)]
    /\ hub     \in [UM -> SUBSET Nat]
    /\ wins \subseteq WinRecord

---------------------------------------------------------------------------

Init ==
    /\ authed  = [u \in Users |-> FALSE]
    /\ pubFlag = [u \in Users |-> TRUE]        \* default TRUE
    /\ latest  = [um \in UM |-> 0]
    /\ gens    = [um \in UM |-> <<>>]
    /\ hub     = [um \in UM |-> {}]
    /\ wins    = {}

\* A user authenticates and receives an API key.
Authenticate(u) ==
    /\ ~authed[u]
    /\ authed' = [authed EXCEPT ![u] = TRUE]
    /\ UNCHANGED <<pubFlag, latest, gens, hub, wins>>

\* A user toggles their publish flag; hub visibility follows the flag.
\* Wins need no update: their visibility is a query-time join on the flag.
TogglePublish(u) ==
    /\ pubFlag' = [pubFlag EXCEPT ![u] = ~@]
    /\ hub' = [um \in UM |->
                 IF um[1] = u
                 THEN IF pubFlag'[u] THEN 1..latest[um] ELSE {}
                 ELSE hub[um]]
    /\ UNCHANGED <<authed, latest, gens, wins>>

\* A passing, non-opted-out check by an authenticated user whose publish
\* flag is on records a new generation for (u, m) with content c — unless
\* the content equals the latest generation's (dedupe).  Failed checks,
\* opt-outs, unauthenticated callers, and flag-off users change nothing
\* (stutter), as do dedupe hits.
Publish(u, m, c) ==
    LET um == <<u, m>> IN
    /\ authed[u]
    /\ pubFlag[u]
    /\ ~(latest[um] > 0 /\ gens[um][latest[um]] = c)   \* dedupe
    /\ latest' = [latest EXCEPT ![um] = @ + 1]
    /\ gens'   = [gens EXCEPT ![um] = Append(@, c)]
    /\ hub'    = [hub EXCEPT ![um] = 1..latest'[um]]
    /\ UNCHANGED <<authed, pubFlag, wins>>

\* tlc_report_win: authenticated user u records a win against their own
\* spec (u, m), citing generation g with 1 <= g <= latest (which implies
\* the spec exists; the worker defaults g to latest when omitted, covered
\* here by the nondeterministic choice of g).  Reports for someone else's
\* spec, a missing spec, or an out-of-range g are rejected without any
\* state change (stutter).
ReportWin(u, m, g) ==
    LET um == <<u, m>> IN
    /\ authed[u]
    /\ g >= 1 /\ g <= latest[um]
    /\ wins' = wins \cup {[user |-> u, module |-> m, gen |-> g]}
    /\ UNCHANGED <<authed, pubFlag, latest, gens, hub>>

Next ==
    \/ \E u \in Users : Authenticate(u)
    \/ \E u \in Users : TogglePublish(u)
    \/ \E u \in Users, m \in Modules, c \in Content : Publish(u, m, c)
    \/ \E u \in Users, m \in Modules, g \in 1..MaxGen : ReportWin(u, m, g)

Spec == Init /\ [][Next]_vars

---------------------------------------------------------------------------
(* Invariants *)

\* Generations are dense: exactly 1..latest exist for every (user, module).
DenseGenerations ==
    \A um \in UM : /\ Len(gens[um]) = latest[um]
                   /\ DOMAIN gens[um] = 1..latest[um]

\* Dedupe worked: no two consecutive generations store equal content.
NoConsecutiveDupes ==
    \A um \in UM :
        \A i \in 1..(latest[um] - 1) : gens[um][i] # gens[um][i + 1]

\* Hub shows exactly 1..latest when the flag is on, nothing when it is off.
HubVisibility ==
    \A um \in UM :
        hub[um] = IF pubFlag[um[1]] THEN 1..latest[um] ELSE {}

\* Every stored win refers to an existing spec of its reporter and to a
\* generation in 1..latest — and stays valid as further publishes occur,
\* because generations are immutable and latest only grows.
WinsWellFormed ==
    \A w \in wins :
        /\ latest[<<w.user, w.module>>] >= 1
        /\ w.gen \in 1..latest[<<w.user, w.module>>]

\* A win visible on the hub (owner's flag on) cites a hub-visible gen;
\* with the flag off, the spec is hidden and the win hides with it.
WinVisibility ==
    \A w \in wins :
        pubFlag[w.user] => w.gen \in hub[<<w.user, w.module>>]

(* Action property: latest never decreases (checked as [][...]_vars). *)
LatestMonotonic ==
    [][\A um \in UM : latest'[um] >= latest[um]]_vars

(* Action property: a generation is only ever recorded for an
   authenticated user whose publish flag is on, one at a time, and
   existing generations are immutable (append-only gens). *)
SafePublish ==
    [][\A um \in UM :
         latest'[um] > latest[um] =>
             /\ authed[um[1]]
             /\ pubFlag[um[1]]
             /\ latest'[um] = latest[um] + 1
             /\ gens'[um] = Append(gens[um], gens'[um][latest'[um]])]_vars

(* Action property: wins are append-only, and any newly inserted win row
   is reported by an authenticated owner (rows carry the reporter's own
   user) citing a generation that exists at insertion time. *)
WinAddSound ==
    [][/\ wins \subseteq wins'
       /\ \A w \in wins' \ wins :
            /\ authed[w.user]
            /\ w.gen \in 1..latest[<<w.user, w.module>>]]_vars

(* State constraint keeping the model finite. *)
GenBound == \A um \in UM : latest[um] <= MaxGen

===========================================================================
