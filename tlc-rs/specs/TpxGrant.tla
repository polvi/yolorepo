----------------------------- MODULE TpxGrant -----------------------------
(***************************************************************************)
(* Metered OAuth 2.1 grant lifecycle for the hub's user-funded defense     *)
(* chat (worker/src/tpx-client.ts).  A grant carries a fixed USD budget    *)
(* (modeled as small naturals) and issues rotating token generations: a    *)
(* successful refresh mints generation n+1 and invalidates generation n's  *)
(* refresh token; presenting a rotated (old) refresh token revokes the     *)
(* whole grant.  Two browser tabs share one localStorage token store with  *)
(* only a best-effort lock, so a tab may act on a stale copy of the        *)
(* refresh token — the benign outcome of that race is revocation, never a  *)
(* violated invariant.  Chat requests spend one unit each; the server      *)
(* rejects spend past the granted budget (402), and revoked or exhausted  *)
(* grants accept neither spend nor refresh.                                *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Tabs,       \* model values, e.g. {t1, t2}: browser tabs sharing a store
    Budget,     \* granted budget in spend units, e.g. 3
    MaxGen      \* bound on token generations, e.g. 3

VARIABLES
    grant,      \* "none" | "active" | "revoked"   server-side grant state
    spent,      \* Nat   cumulative spend accepted by the server
    serverGen,  \* Nat   latest token generation issued (0 = none yet)
    valid,      \* SUBSET Nat   refresh-token generations the server accepts
    store,      \* Nat   generation currently in the shared localStorage
    tab         \* [Tabs -> Nat]  generation each tab holds in memory (0 = none)

vars == <<grant, spent, serverGen, valid, store, tab>>

GrantStates == {"none", "active", "revoked"}

TypeOK ==
    /\ grant     \in GrantStates
    /\ spent     \in 0..Budget
    /\ serverGen \in 0..MaxGen
    /\ valid     \subseteq 1..MaxGen
    /\ store     \in 0..MaxGen
    /\ tab       \in [Tabs -> 0..MaxGen]

---------------------------------------------------------------------------

Init ==
    /\ grant     = "none"
    /\ spent     = 0
    /\ serverGen = 0
    /\ valid     = {}
    /\ store     = 0
    /\ tab       = [t \in Tabs |-> 0]

\* The visitor authorizes: generation 1 of both tokens lands in the store.
CreateGrant ==
    /\ grant = "none"
    /\ grant'     = "active"
    /\ serverGen' = 1
    /\ valid'     = {1}
    /\ store'     = 1
    /\ UNCHANGED <<spent, tab>>

\* A tab (re)reads the shared localStorage into memory.  Because reads and
\* rotations interleave freely, a tab can be left holding a stale generation.
TabRead(t) ==
    /\ tab[t] # store
    /\ tab' = [tab EXCEPT ![t] = store]
    /\ UNCHANGED <<grant, spent, serverGen, valid, store>>

\* A tab refreshes with the current refresh token: the server rotates,
\* issuing generation n+1 and invalidating generation n.  The tab writes
\* the new pair back to the store immediately.
RefreshOk(t) ==
    /\ grant = "active"
    /\ spent < Budget                 \* exhausted grants refuse refresh
    /\ tab[t] # 0
    /\ tab[t] = serverGen
    /\ serverGen < MaxGen
    /\ serverGen' = serverGen + 1
    /\ valid'     = (valid \ {serverGen}) \union {serverGen + 1}
    /\ store'     = serverGen + 1
    /\ tab'       = [tab EXCEPT ![t] = serverGen + 1]
    /\ UNCHANGED <<grant, spent>>

\* A tab lost the race: it presents a refresh token that has already been
\* rotated away.  The server treats reuse as theft and revokes the grant;
\* the client clears the store on invalid_grant.  Benign but terminal.
RefreshStale(t) ==
    /\ grant = "active"
    /\ spent < Budget
    /\ tab[t] # 0
    /\ tab[t] < serverGen
    /\ grant' = "revoked"
    /\ valid' = {}
    /\ store' = 0
    /\ tab'   = [tab EXCEPT ![t] = 0]
    /\ UNCHANGED <<spent, serverGen>>

\* A chat request spends one unit.  The server only accepts it while the
\* grant is active and the budget still covers it; otherwise 402.
Spend(t) ==
    /\ grant = "active"
    /\ tab[t] # 0
    /\ spent + 1 <= Budget
    /\ spent' = spent + 1
    /\ UNCHANGED <<grant, serverGen, valid, store, tab>>

\* The visitor clicks revoke: the server invalidates everything and the
\* client clears the shared store.
ClientRevoke(t) ==
    /\ grant = "active"
    /\ tab[t] # 0
    /\ grant' = "revoked"
    /\ valid' = {}
    /\ store' = 0
    /\ tab'   = [tab EXCEPT ![t] = 0]
    /\ UNCHANGED <<spent, serverGen>>

Next ==
    \/ CreateGrant
    \/ \E t \in Tabs : TabRead(t)
    \/ \E t \in Tabs : RefreshOk(t)
    \/ \E t \in Tabs : RefreshStale(t)
    \/ \E t \in Tabs : Spend(t)
    \/ \E t \in Tabs : ClientRevoke(t)

Spec == Init /\ [][Next]_vars

---------------------------------------------------------------------------
(* Invariants *)

\* Cumulative spend never exceeds the granted budget.
SpendWithinBudget == spent <= Budget

\* At most one refresh-token generation is ever valid: exactly the latest
\* issued while the grant is active, none otherwise (rotation is airtight).
RotationSafety ==
    /\ Cardinality(valid) <= 1
    /\ grant = "active" => valid = {serverGen}
    /\ grant # "active" => valid = {}

(* Action property: revocation is final — a revoked grant issues no new  *)
(* token generations and accepts no further spend.                       *)
NoZombieGrant ==
    [][grant = "revoked" => /\ grant'     = "revoked"
                            /\ serverGen' = serverGen
                            /\ valid'     = {}
                            /\ spent'     = spent]_vars

===========================================================================
