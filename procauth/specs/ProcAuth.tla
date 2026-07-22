----------------------------- MODULE ProcAuth -----------------------------
(***************************************************************************)
(* ProcAuth: the shared first-party auth surface at auth.proc.io.          *)
(*                                                                         *)
(* Product apps on *.proc.io link to auth.proc.io (login, register,        *)
(* account) with a return_to back to themselves.  The pages call the auth  *)
(* service's (AuthGravity's) raw API from the browser.  All ceremony       *)
(* kinds (WebAuthn passkey create/get, HKDF account-key signature, silent  *)
(* device-key login) share one shape, modeled as a single abstract         *)
(* ceremony:                                                               *)
(*                                                                         *)
(*   Issue   - GET /v1/{register,login}/options hands the browser a fresh  *)
(*             challenge bound to the requesting principal; the return_to  *)
(*             target is accepted only if it is a *.proc.io app.           *)
(*   Verify  - POST /v1/{register,login}/verify (or /v1/key/...): the      *)
(*             server accepts a challenge only if it is fresh (never used) *)
(*             and no older than TTL, consumes it, creates a session, and  *)
(*             the browser is sent back to the challenge's return_to.      *)
(*   Logout  - POST /v1/logout destroys the session.                       *)
(*                                                                         *)
(* The session_id cookie lives on the proc.io registrable domain, so one   *)
(* sign-in is valid across every *.proc.io app.  The trust model is        *)
(* unchanged: the auth service issues and validates sessions; each app's   *)
(* API forwards the cookie to /v1/whoami, an access gate that is exactly   *)
(* "session active", so apps need no ceremony state of their own.          *)
(* CORS/cross-subdomain transport is not state and is out of scope.        *)
(*                                                                         *)
(* Safety-only, finite model.  The real 5-minute challenge TTL is          *)
(* abstracted to TTL clock ticks against a bounded clock.  Challenge       *)
(* identities are ordered slots allocated lowest-free-slot first           *)
(* (symmetry breaking).  NoChal (= 0) marks "no session".                  *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Users,          \* set of principals (model values)
    Targets,        \* return_to targets requested by browsers (model values)
    AllowedTargets, \* subset of Targets: the *.proc.io apps
    NumChallenges,  \* number of challenge identity slots
    MaxClock,       \* clock bound
    TTL,            \* challenge lifetime in ticks (abstracts 5 minutes)
    NULL            \* model value: "no owner" / "no target"

ASSUME NumChallenges \in Nat /\ NumChallenges >= 1
ASSUME MaxClock \in Nat /\ TTL \in Nat /\ TTL < MaxClock
ASSUME AllowedTargets \subseteq Targets

Chals  == 1..NumChallenges
NoChal == 0

VARIABLES
    clock,          \* 0..MaxClock
    chalOwner,      \* [Chals -> Users \cup {NULL}]  principal it was issued to
    chalReturn,     \* [Chals -> Targets \cup {NULL}] validated return_to
    chalIssued,     \* [Chals -> 0..MaxClock]        issue time
    chalVerifiedAt, \* [Chals -> 0..MaxClock]        consume time (used only)
    chalState,      \* [Chals -> {"none","fresh","used"}]
    sessionChal,    \* [Users -> Chals \cup {NoChal}] challenge backing the
                    \* user's active session; NoChal = logged out
    redirects       \* set of targets the browser was sent back to with a
                    \* fresh session

vars == <<clock, chalOwner, chalReturn, chalIssued, chalVerifiedAt,
          chalState, sessionChal, redirects>>

Init ==
    /\ clock = 0
    /\ chalOwner = [c \in Chals |-> NULL]
    /\ chalReturn = [c \in Chals |-> NULL]
    /\ chalIssued = [c \in Chals |-> 0]
    /\ chalVerifiedAt = [c \in Chals |-> 0]
    /\ chalState = [c \in Chals |-> "none"]
    /\ sessionChal = [u \in Users |-> NoChal]
    /\ redirects = {}

Tick ==
    /\ clock < MaxClock
    /\ clock' = clock + 1
    /\ UNCHANGED <<chalOwner, chalReturn, chalIssued, chalVerifiedAt,
                   chalState, sessionChal, redirects>>

\* Browser arrives with any requested return_to; the ceremony starts only
\* when the target is an allowed *.proc.io app.  The server mints a
\* challenge bound to u.  Lowest-free-slot allocation breaks
\* challenge-labeling symmetry.
Issue(u, c, t) ==
    /\ t \in AllowedTargets
    /\ chalState[c] = "none"
    /\ \A x \in 1..(c - 1) : chalState[x] # "none"
    /\ chalOwner' = [chalOwner EXCEPT ![c] = u]
    /\ chalReturn' = [chalReturn EXCEPT ![c] = t]
    /\ chalIssued' = [chalIssued EXCEPT ![c] = clock]
    /\ chalState' = [chalState EXCEPT ![c] = "fresh"]
    /\ UNCHANGED <<clock, chalVerifiedAt, sessionChal, redirects>>

\* Server-side verify: accepts only a fresh, same-owner, unexpired
\* challenge; consumes it (single use), creates the session, and sends the
\* browser back to the challenge's validated return_to.  A new login
\* replaces any existing session cookie for that user.
Verify(u, c) ==
    /\ chalState[c] = "fresh"
    /\ chalOwner[c] = u
    /\ clock - chalIssued[c] <= TTL
    /\ chalState' = [chalState EXCEPT ![c] = "used"]
    /\ chalVerifiedAt' = [chalVerifiedAt EXCEPT ![c] = clock]
    /\ sessionChal' = [sessionChal EXCEPT ![u] = c]
    /\ redirects' = redirects \cup {chalReturn[c]}
    /\ UNCHANGED <<clock, chalOwner, chalReturn, chalIssued>>

\* POST /v1/logout destroys the session server-side.
Logout(u) ==
    /\ sessionChal[u] # NoChal
    /\ sessionChal' = [sessionChal EXCEPT ![u] = NoChal]
    /\ UNCHANGED <<clock, chalOwner, chalReturn, chalIssued, chalVerifiedAt,
                   chalState, redirects>>

Next ==
    \/ Tick
    \/ \E u \in Users :
        \/ Logout(u)
        \/ \E c \in Chals :
            \/ \E t \in Targets : Issue(u, c, t)
            \/ Verify(u, c)

Spec == Init /\ [][Next]_vars

(***************************************************************************)
(* Invariants                                                              *)
(***************************************************************************)

TypeOK ==
    /\ clock \in 0..MaxClock
    /\ chalOwner \in [Chals -> Users \cup {NULL}]
    /\ chalReturn \in [Chals -> Targets \cup {NULL}]
    /\ chalIssued \in [Chals -> 0..MaxClock]
    /\ chalVerifiedAt \in [Chals -> 0..MaxClock]
    /\ chalState \in [Chals -> {"none", "fresh", "used"}]
    /\ sessionChal \in [Users -> Chals \cup {NoChal}]
    /\ redirects \subseteq Targets

\* 1. Every active session is backed by a consumed challenge that was
\*    issued to exactly that principal.  No session without a completed
\*    ceremony, and never on someone else's challenge.
SessionBackedByOwnChallenge ==
    \A u \in Users : sessionChal[u] # NoChal =>
        /\ chalState[sessionChal[u]] = "used"
        /\ chalOwner[sessionChal[u]] = u

\* 2. A challenge backs at most one session (single use across users;
\*    within a user a re-login replaces the session).
ChallengeSingleUse ==
    \A u1 \in Users, u2 \in Users :
        (u1 # u2 /\ sessionChal[u1] # NoChal) => sessionChal[u1] # sessionChal[u2]

\* 3. Every consumed challenge was verified within TTL of issuance:
\*    expired challenges never create sessions.
VerifiedWithinTTL ==
    \A c \in Chals : chalState[c] = "used" =>
        /\ chalVerifiedAt[c] >= chalIssued[c]
        /\ chalVerifiedAt[c] - chalIssued[c] <= TTL

\* 4. A fresh session is only ever handed back to a *.proc.io app: no
\*    open-redirect of the authenticated browser, and every live
\*    challenge carries a validated return_to.
RedirectsOnlyToAllowed ==
    /\ redirects \subseteq AllowedTargets
    /\ \A c \in Chals : chalState[c] # "none" => chalReturn[c] \in AllowedTargets

(***************************************************************************)
(* Action properties                                                       *)
(***************************************************************************)

\* A consumed challenge is consumed forever: no replay of used challenges.
NoChallengeReplay ==
    [][\A c \in Chals : chalState[c] = "used" => chalState'[c] = "used"]_vars

\* Challenge bindings (owner, return_to, issue time) are immutable once
\* issued.
ChallengeBindingImmutable ==
    [][\A c \in Chals : chalState[c] # "none" =>
        /\ chalOwner'[c] = chalOwner[c]
        /\ chalReturn'[c] = chalReturn[c]
        /\ chalIssued'[c] = chalIssued[c]]_vars

=============================================================================
