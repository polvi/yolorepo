-------------------------- MODULE KosyncCredentials --------------------------
(***************************************************************************)
(* KOReader progress-sync (kosync) credential lifecycle for happybook.    *)
(*                                                                        *)
(* Models the D1 table                                                    *)
(*   kosync_credentials(user_id PRIMARY KEY, username UNIQUE NOT NULL,    *)
(*                      password NOT NULL, created_at)                    *)
(* as a set of <<user, username, password>> triples, and the operations:  *)
(*                                                                        *)
(*  - Enable/Regenerate: generate a fresh random (username, password)     *)
(*    pair and INSERT ... ON CONFLICT(user_id) DO UPDATE SET username,    *)
(*    password.  Each attempt is one atomic SQL statement; if the fresh   *)
(*    username collides with ANOTHER user's UNIQUE username the           *)
(*    statement fails with no effect and the caller retries with fresh    *)
(*    random values, up to MaxAttempts times, then gives up.              *)
(*  - Revoke: DELETE by user_id.                                          *)
(*  - Auth (KOReader request): atomic SELECT user_id, password WHERE      *)
(*    username = n, then compare md5(password) with the presented key.    *)
(*    Abstractly: auth succeeds for (n, p) iff <<u, n, p>> is a current   *)
(*    row, and the request then acts as u.                                *)
(*                                                                        *)
(* Invariants:                                                            *)
(*  - UsernamesUnique: no two users ever hold the same username.          *)
(*  - AtMostOneCredPerUser: user_id is a primary key.                     *)
(*  - AuthSound: an auth check with (username, password) only ever        *)
(*    resolves to the user whose current row is exactly that pair (so     *)
(*    after regenerate/revoke the old pair no longer authenticates, and   *)
(*    a username can never authenticate as the wrong user).               *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Users,          \* small set of user ids
    Usernames,      \* small username space, so generate-collisions occur
    Passwords,      \* small password space
    MaxAttempts,    \* retry budget for the regenerate loop (3 in the code)
    NoAuth          \* model value: "no auth result pending"

VARIABLES
    table,      \* subset of Users \X Usernames \X Passwords: the rows
    regen,      \* per-user state of an in-flight enable/regenerate call
    lastAuth    \* result of the auth SELECT taken in the previous step

vars == <<table, regen, lastAuth>>

RegenStates == [active : BOOLEAN, tries : 0..MaxAttempts]

TypeOK ==
    /\ table \subseteq Users \X Usernames \X Passwords
    /\ regen \in [Users -> RegenStates]
    /\ lastAuth \in [name : Usernames, pw : Passwords, user : Users]
                    \cup {NoAuth}

Init ==
    /\ table = {}
    /\ regen = [u \in Users |-> [active |-> FALSE, tries |-> 0]]
    /\ lastAuth = NoAuth

-----------------------------------------------------------------------------
(* A request begins an enable/regenerate for user u.                       *)
StartRegen(u) ==
    /\ ~regen[u].active
    /\ regen' = [regen EXCEPT ![u] = [active |-> TRUE, tries |-> 0]]
    /\ lastAuth' = NoAuth
    /\ UNCHANGED table

(* One upsert attempt with freshly generated pair (n, p) whose username    *)
(* does not collide with another user's row: the atomic INSERT ... ON      *)
(* CONFLICT replaces u's row (if any) and the call returns.                *)
UpsertOk(u, n, p) ==
    /\ regen[u].active
    /\ ~\E r \in table : r[1] # u /\ r[2] = n
    /\ table' = {r \in table : r[1] # u} \cup {<<u, n, p>>}
    /\ regen' = [regen EXCEPT ![u].active = FALSE]
    /\ lastAuth' = NoAuth

(* One upsert attempt whose generated username n is already held by a      *)
(* different user: the UNIQUE(username) constraint rejects the statement,  *)
(* which has no effect on the table.  The caller retries with fresh        *)
(* random values until the budget is exhausted, then gives up (surfacing   *)
(* an error to the user).                                                  *)
UpsertCollision(u, n) ==
    /\ regen[u].active
    /\ \E r \in table : r[1] # u /\ r[2] = n
    /\ regen' = [regen EXCEPT
                    ![u] = [active |-> regen[u].tries + 1 < MaxAttempts,
                            tries  |-> regen[u].tries + 1]]
    /\ lastAuth' = NoAuth
    /\ UNCHANGED table

(* DELETE FROM kosync_credentials WHERE user_id = u.  May interleave with  *)
(* anything, including another request's in-flight regenerate.             *)
Revoke(u) ==
    /\ table' = {r \in table : r[1] # u}
    /\ lastAuth' = NoAuth
    /\ UNCHANGED regen

(* Atomic SELECT user_id, password WHERE username = n plus the md5 key     *)
(* comparison, hit case: record the resolution so AuthSound can inspect    *)
(* it in the post-state.                                                   *)
AuthHit(n, p) ==
    /\ \E u \in Users : <<u, n, p>> \in table
    /\ lastAuth' = [name |-> n, pw |-> p,
                    user |-> CHOOSE u \in Users : <<u, n, p>> \in table]
    /\ UNCHANGED <<table, regen>>

(* SELECT miss or key mismatch: the request is rejected with 401.          *)
AuthMiss(n, p) ==
    /\ ~\E u \in Users : <<u, n, p>> \in table
    /\ lastAuth' = NoAuth
    /\ UNCHANGED <<table, regen>>

Next ==
    \/ \E u \in Users : StartRegen(u) \/ Revoke(u)
    \/ \E u \in Users, n \in Usernames, p \in Passwords : UpsertOk(u, n, p)
    \/ \E u \in Users, n \in Usernames : UpsertCollision(u, n)
    \/ \E n \in Usernames, p \in Passwords : AuthHit(n, p) \/ AuthMiss(n, p)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* UNIQUE(username): no two rows share a username.                         *)
UsernamesUnique ==
    \A n \in Usernames : Cardinality({r \in table : r[2] = n}) <= 1

(* PRIMARY KEY(user_id): no two rows share a user.                         *)
AtMostOneCredPerUser ==
    \A u \in Users : Cardinality({r \in table : r[1] = u}) <= 1

(* Whenever an auth SELECT resolved to a user, that user's current row     *)
(* carries exactly the presented username and password.                    *)
AuthSound ==
    lastAuth = NoAuth \/ <<lastAuth.user, lastAuth.name, lastAuth.pw>> \in table

=============================================================================
