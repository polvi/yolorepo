--------------------------- MODULE OpdsCredentials ---------------------------
(***************************************************************************)
(* OPDS credential lifecycle for happybook.                               *)
(*                                                                        *)
(* Models the D1 table                                                    *)
(*   opds_credentials(user_id PRIMARY KEY, password UNIQUE, created_at)   *)
(* as a set of <<user, password>> pairs, and the operations:              *)
(*                                                                        *)
(*  - Enable/Regenerate: INSERT ... ON CONFLICT(user_id) DO UPDATE SET    *)
(*    password = new.  Each attempt is one atomic SQL statement; if the   *)
(*    fresh password collides with ANOTHER user's UNIQUE password the     *)
(*    statement fails with no effect and the caller retries with a new    *)
(*    random password, up to MaxAttempts times.                           *)
(*  - Revoke: DELETE by user_id.                                          *)
(*  - Basic-auth read: atomic SELECT user_id WHERE password = p; the      *)
(*    request then acts as the returned user.                             *)
(*                                                                        *)
(* Invariants:                                                            *)
(*  - PasswordsUnique: no two users ever hold the same password.          *)
(*  - AtMostOneCredPerUser: user_id is a primary key.                     *)
(*  - AuthSound: an auth check with password p only ever resolves to a    *)
(*    user whose current password is p (so after regenerate/revoke the    *)
(*    old password no longer authenticates).                              *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Users,          \* small set of user ids
    Passwords,      \* small password space, so generate-collisions occur
    MaxAttempts,    \* retry budget for the regenerate loop (3 in the code)
    NoAuth          \* model value: "no auth result pending"

VARIABLES
    table,      \* subset of Users \X Passwords: the opds_credentials rows
    regen,      \* per-user state of an in-flight enable/regenerate call
    lastAuth    \* result of the auth SELECT taken in the previous step

vars == <<table, regen, lastAuth>>

RegenStates == [active : BOOLEAN, tries : 0..MaxAttempts]

TypeOK ==
    /\ table \subseteq Users \X Passwords
    /\ regen \in [Users -> RegenStates]
    /\ lastAuth \in [pw : Passwords, user : Users] \cup {NoAuth}

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

(* One upsert attempt with freshly generated password p that does not      *)
(* collide with another user's row: the atomic INSERT ... ON CONFLICT      *)
(* replaces u's row (if any) and the call returns.                         *)
UpsertOk(u, p) ==
    /\ regen[u].active
    /\ ~\E v \in Users \ {u} : <<v, p>> \in table
    /\ table' = {r \in table : r[1] # u} \cup {<<u, p>>}
    /\ regen' = [regen EXCEPT ![u].active = FALSE]
    /\ lastAuth' = NoAuth

(* One upsert attempt whose generated password p is already held by a      *)
(* different user: the UNIQUE(password) constraint rejects the statement,  *)
(* which has no effect on the table.  The caller retries until the budget  *)
(* is exhausted, then gives up (surfacing an error to the user).           *)
UpsertCollision(u, p) ==
    /\ regen[u].active
    /\ \E v \in Users \ {u} : <<v, p>> \in table
    /\ regen' = [regen EXCEPT
                    ![u] = [active |-> regen[u].tries + 1 < MaxAttempts,
                            tries  |-> regen[u].tries + 1]]
    /\ lastAuth' = NoAuth
    /\ UNCHANGED table

(* DELETE FROM opds_credentials WHERE user_id = u.  May interleave with    *)
(* anything, including another request's in-flight regenerate.             *)
Revoke(u) ==
    /\ table' = {r \in table : r[1] # u}
    /\ lastAuth' = NoAuth
    /\ UNCHANGED regen

(* Atomic SELECT user_id WHERE password = p, hit case: record the          *)
(* resolution so AuthSound can inspect it in the post-state.               *)
AuthHit(p) ==
    /\ \E u \in Users : <<u, p>> \in table
    /\ lastAuth' = [pw |-> p, user |-> CHOOSE u \in Users : <<u, p>> \in table]
    /\ UNCHANGED <<table, regen>>

(* SELECT miss: the request is rejected with 401.                          *)
AuthMiss(p) ==
    /\ ~\E u \in Users : <<u, p>> \in table
    /\ lastAuth' = NoAuth
    /\ UNCHANGED <<table, regen>>

Next ==
    \/ \E u \in Users : StartRegen(u) \/ Revoke(u)
    \/ \E u \in Users, p \in Passwords : UpsertOk(u, p) \/ UpsertCollision(u, p)
    \/ \E p \in Passwords : AuthHit(p) \/ AuthMiss(p)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* UNIQUE(password): no two rows share a password.                         *)
PasswordsUnique ==
    \A p \in Passwords : Cardinality({r \in table : r[2] = p}) <= 1

(* PRIMARY KEY(user_id): no two rows share a user.                         *)
AtMostOneCredPerUser ==
    \A u \in Users : Cardinality({r \in table : r[1] = u}) <= 1

(* Whenever an auth SELECT resolved to a user, that user's current row     *)
(* carries exactly the presented password.                                 *)
AuthSound ==
    lastAuth = NoAuth \/ <<lastAuth.user, lastAuth.pw>> \in table

=============================================================================
