-------------------------- MODULE PwaUpdate --------------------------
(***************************************************************************)
(* Service-worker update flow for an installed PWA in "autoUpdate" mode    *)
(* with a manual force-check.                                              *)
(*                                                                         *)
(* A server holds a deployed app version, bumped by deploys up to          *)
(* MaxVersion.  Each client runs an `active` service worker version and    *)
(* optionally holds a `waiting` worker (NoSW when absent).  An update      *)
(* check, whether from the periodic timer, visibilitychange, or the        *)
(* manual force-check button (all identical abstractly, so one Check       *)
(* action), installs a strictly newer server version into `waiting`.       *)
(*                                                                         *)
(* There is no prompt and no consent step: skipWaiting + clientsClaim      *)
(* activate the waiting worker automatically, the page reloads, and        *)
(* `active` becomes the previously waiting version.  The reload is the     *)
(* step where `active` changes.  The UI's build-version stamp always       *)
(* equals the running `active` version after reload, so it is not a        *)
(* separate variable.  The key property: `active` is monotone, upgrading   *)
(* only to a version that was first installed as `waiting`.                *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    Clients,      \* set of client (browser/installed-PWA) ids, model values
    MaxVersion    \* bound on the number of deployed versions

NoSW == 0        \* "no waiting worker" (versions are 1..MaxVersion)

VARIABLES
    serverVersion, \* currently deployed app version on the server
    active,        \* active[c]  : SW version client c is running
    waiting        \* waiting[c] : installed waiting SW version, or NoSW

vars == <<serverVersion, active, waiting>>

-----------------------------------------------------------------------------

Init ==
    /\ serverVersion = 1
    /\ active  = [c \in Clients |-> 1]
    /\ waiting = [c \in Clients |-> NoSW]

\* A deploy bumps the server's app version.
Deploy ==
    /\ serverVersion < MaxVersion
    /\ serverVersion' = serverVersion + 1
    /\ UNCHANGED <<active, waiting>>

\* Update check (periodic timer, visibilitychange, or manual force-check):
\* a strictly newer server version, not already installed as waiting,
\* installs into `waiting`.
Check(c) ==
    /\ serverVersion > active[c]
    /\ serverVersion # waiting[c]
    /\ waiting' = [waiting EXCEPT ![c] = serverVersion]
    /\ UNCHANGED <<serverVersion, active>>

\* skipWaiting + clientsClaim + reload, fully automatic: the waiting
\* worker activates and the page reloads on the new version.  This is
\* the only step where `active` changes.
ActivateReload(c) ==
    /\ waiting[c] # NoSW
    /\ active'  = [active EXCEPT ![c] = waiting[c]]
    /\ waiting' = [waiting EXCEPT ![c] = NoSW]
    /\ UNCHANGED serverVersion

Next ==
    \/ Deploy
    \/ \E c \in Clients: Check(c) \/ ActivateReload(c)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Invariants *)

TypeOK ==
    /\ serverVersion \in 1..MaxVersion
    /\ active  \in [Clients -> 1..MaxVersion]
    /\ waiting \in [Clients -> {NoSW} \cup 1..MaxVersion]

\* (1) A client only ever runs a version the server actually deployed.
ActiveDeployed ==
    \A c \in Clients: active[c] \in 1..serverVersion

\* (2) A waiting worker, when present, is a deployed version strictly
\* newer than the one running.
WaitingNewer ==
    \A c \in Clients:
        waiting[c] # NoSW =>
            /\ waiting[c] > active[c]
            /\ waiting[c] <= serverVersion

-----------------------------------------------------------------------------
(* Action property: monotone upgrade.  Across every step, a client's
   active version only ever increases, and only to the previously
   installed waiting version, which is then cleared: no downgrade, and
   no skipping to a version that was never installed as waiting. *)

MonotoneUpgrade ==
    \A c \in Clients:
        active'[c] # active[c] =>
            /\ active'[c] > active[c]
            /\ active'[c] = waiting[c]
            /\ waiting'[c] = NoSW

Safety == [][MonotoneUpgrade]_vars

=============================================================================
