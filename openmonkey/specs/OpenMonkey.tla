---------------------------- MODULE OpenMonkey ----------------------------
(***************************************************************************)
(* OpenMonkey: an open userscript registry.  OpenMonkey ships no browser   *)
(* extension of its own; users install scripts through standard third-     *)
(* party userscript managers (the quoid/userscripts Safari app,            *)
(* Tampermonkey, etc.) that fetch a raw <slug>.user.js URL from the        *)
(* registry.                                                               *)
(*                                                                         *)
(* Scripts have immutable published versions (1..MaxVersion).  Publishing  *)
(* a script or a new version makes it public immediately; only the author  *)
(* publishes versions, and the published version number only grows.  Any   *)
(* user may fork any published script, producing a new script they author  *)
(* with forked_from lineage, which must stay acyclic.                      *)
(*                                                                         *)
(* Security scans still exist, but they are ADVISORY community reports:    *)
(* a user records a pass / warn / fail verdict against an exact published  *)
(* version, and the registry publishes those verdicts alongside the        *)
(* script.  Because install and run happen inside a third-party manager,   *)
(* outside the registry's trusted computing base, the registry cannot      *)
(* enforce "scan before run".  Install and run are therefore modeled as    *)
(* unrestricted user actions; scan-before-run is a user norm supported by  *)
(* published verdicts, not a system invariant.  What the registry does     *)
(* enforce, and what this spec checks: lineage acyclicity, immutable /     *)
(* monotonic publishing, author-only version publishing, scans that        *)
(* reference an exact published version (never carrying over to a new      *)
(* version), running implies installed, and installed implies published.   *)
(*                                                                         *)
(* Safety-only, finite model.  Two symmetry-breaking modeling choices      *)
(* keep TLC's search small without losing behavior classes:                *)
(*   1. Script identities are the ordered slots 1..NumScripts, always      *)
(*      allocated lowest-free-slot first.                                  *)
(*   2. Direct creation is done by a designated Creator; every other user  *)
(*      still becomes an author via Fork, so author and non-author roles   *)
(*      are exercised for all users.                                       *)
(* NoScript (= 0) marks "no fork parent".                                  *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Users,       \* set of users (model values)
    Creator,     \* the user who creates scripts directly (symmetry breaking)
    NumScripts,  \* number of script identity slots
    MaxVersion,  \* highest version number a script can reach
    NULL         \* model value: "no author"

ASSUME NumScripts \in Nat /\ NumScripts >= 1
ASSUME MaxVersion \in Nat /\ MaxVersion >= 1

Scripts  == 1..NumScripts
NoScript == 0
Versions == 1..MaxVersion
Verdicts == {"pass", "warn", "fail"}

VARIABLES
    author,     \* [Scripts -> Users \cup {NULL}]  NULL = not yet created
    published,  \* [Scripts -> 0..MaxVersion]      latest published version, 0 = none
    forkedFrom, \* [Scripts -> Scripts \cup {NoScript}] fork lineage
    scans,      \* [Users \X Scripts \X Versions -> Verdicts \cup {"none"}]
    installed,  \* set of <<user, script, version>> (in the user's manager)
    running     \* set of <<user, script, version>>, subset of installed

vars == <<author, published, forkedFrom, scans, installed, running>>

Created == {s \in Scripts : published[s] > 0}

\* Lowest-free-slot allocation for new script identities.
NextFreeSlot(s) == published[s] = 0 /\ \A x \in 1..(s - 1) : published[x] > 0

Init ==
    /\ author = [s \in Scripts |-> NULL]
    /\ published = [s \in Scripts |-> 0]
    /\ forkedFrom = [s \in Scripts |-> NoScript]
    /\ scans = [x \in Users \X Scripts \X Versions |-> "none"]
    /\ installed = {}
    /\ running = {}

(***************************************************************************)
(* Publishing (registry-enforced)                                          *)
(***************************************************************************)

\* Creating a script publishes version 1 immediately and publicly.
CreateScript(u, s) ==
    /\ u = Creator
    /\ NextFreeSlot(s)
    /\ author' = [author EXCEPT ![s] = u]
    /\ published' = [published EXCEPT ![s] = 1]
    /\ UNCHANGED <<forkedFrom, scans, installed, running>>

\* Only the author publishes new versions; they are public at once, and the
\* version number only ever grows (immutability + monotonicity).
PublishVersion(u, s) ==
    /\ author[s] = u
    /\ published[s] \in 1..(MaxVersion - 1)
    /\ published' = [published EXCEPT ![s] = published[s] + 1]
    /\ UNCHANGED <<author, forkedFrom, scans, installed, running>>

\* Any user can fork any published (hence readable) script into a fresh
\* script identity they author, recording forked_from lineage.
Fork(u, src, dst) ==
    /\ src \in Created
    /\ NextFreeSlot(dst)
    /\ author' = [author EXCEPT ![dst] = u]
    /\ published' = [published EXCEPT ![dst] = 1]
    /\ forkedFrom' = [forkedFrom EXCEPT ![dst] = src]
    /\ UNCHANGED <<scans, installed, running>>

(***************************************************************************)
(* Advisory scanning (registry publishes, does not enforce)                *)
(***************************************************************************)

\* A non-author user scans a specific published version (their own
\* inference endpoint) and publishes the verdict to the registry as a
\* community report.  The verdict is nondeterministic.  Versions are
\* immutable, so a verdict never changes once recorded, and a verdict for
\* version N says nothing about version N+1.
Scan(u, s, v) ==
    /\ v \in 1..published[s]
    /\ author[s] # NULL
    /\ author[s] # u
    /\ scans[u, s, v] = "none"
    /\ \E verdict \in Verdicts :
          scans' = [scans EXCEPT ![u, s, v] = verdict]
    /\ UNCHANGED <<author, published, forkedFrom, installed, running>>

(***************************************************************************)
(* Installing and running (third-party manager, outside the registry TCB)  *)
(***************************************************************************)

\* Any user installs any published version by pointing their userscript
\* manager at the raw <slug>.user.js URL.  The registry cannot gate this:
\* no scan verdict is consulted.  Consulting published community verdicts
\* first is a user norm, not an enforced precondition.
Install(u, s, v) ==
    /\ v \in 1..published[s]
    /\ <<u, s, v>> \notin installed
    /\ installed' = installed \cup {<<u, s, v>>}
    /\ UNCHANGED <<author, published, forkedFrom, scans, running>>

\* Only installed pairs run (a manager runs what it has installed).
Run(u, s, v) ==
    /\ <<u, s, v>> \in installed
    /\ <<u, s, v>> \notin running
    /\ running' = running \cup {<<u, s, v>>}
    /\ UNCHANGED <<author, published, forkedFrom, scans, installed>>

\* Uninstalling also stops any running instance.
Uninstall(u, s, v) ==
    /\ <<u, s, v>> \in installed
    /\ installed' = installed \ {<<u, s, v>>}
    /\ running' = running \ {<<u, s, v>>}
    /\ UNCHANGED <<author, published, forkedFrom, scans>>

Next ==
    \E u \in Users, s \in Scripts :
        \/ CreateScript(u, s)
        \/ PublishVersion(u, s)
        \/ \E dst \in Scripts : Fork(u, s, dst)
        \/ \E v \in Versions :
              \/ Scan(u, s, v)
              \/ Install(u, s, v)
              \/ Run(u, s, v)
              \/ Uninstall(u, s, v)

Spec == Init /\ [][Next]_vars

(***************************************************************************)
(* Finite-exploration bound (model artifact, not part of the design).      *)
(* Caps cumulative scan records, concurrent installs, and concurrent runs  *)
(* so TLC's search stays small.  Every invariant-relevant scenario fits    *)
(* inside it: install-then-upgrade-then-reinstall, scan-after-install      *)
(* (now legal), install-without-any-scan, fork-then-scan.                  *)
(***************************************************************************)

ScannedSlots == {t \in Users \X Scripts \X Versions : scans[t] # "none"}

StateConstraint ==
    /\ Cardinality(ScannedSlots) <= 2
    /\ Cardinality(ScannedSlots) + Cardinality(installed) <= 3
    /\ Cardinality(running) <= 1

(***************************************************************************)
(* Invariants: exactly the properties the registry itself enforces.  There *)
(* is deliberately no "foreign runs are scanned" invariant: with install   *)
(* and run in a third-party manager, the registry cannot make that true.   *)
(***************************************************************************)

TypeOK ==
    /\ author \in [Scripts -> Users \cup {NULL}]
    /\ published \in [Scripts -> 0..MaxVersion]
    /\ forkedFrom \in [Scripts -> Scripts \cup {NoScript}]
    /\ scans \in [Users \X Scripts \X Versions -> Verdicts \cup {"none"}]
    /\ installed \subseteq Users \X Scripts \X Versions
    /\ running \subseteq Users \X Scripts \X Versions

\* 1. Fork lineage is acyclic (transitive closure of forked_from is
\*    irreflexive).
ForkEdges ==
    {<<s, forkedFrom[s]>> : s \in {x \in Scripts : forkedFrom[x] # NoScript}}

RECURSIVE TC(_)
TC(R) ==
    LET RR == R \cup {e \in Scripts \X Scripts :
                        \E b \in Scripts : <<e[1], b>> \in R /\ <<b, e[2]>> \in R}
    IN IF RR = R THEN R ELSE TC(RR)

ForkAcyclic ==
    \A s \in Scripts : <<s, s>> \notin TC(ForkEdges)

\* 2. Every installed version was actually published (managers can only
\*    fetch published <slug>.user.js content, and versions are never
\*    retracted, so this stays true).
InstalledImpliesPublished ==
    \A t \in installed : t[3] \in 1..published[t[2]]

\* 3. Running implies installed: a manager only runs scripts it holds.
RunningImpliesInstalled ==
    running \subseteq installed

\* 4. Every recorded scan verdict references an exact published version of
\*    an existing script, and never a version of the reporter's own script.
\*    Verdicts never carry over across versions by construction (the scans
\*    function is keyed on the exact version).
ScanRefsPublishedVersion ==
    \A t \in Users \X Scripts \X Versions :
        scans[t] # "none" =>
            /\ author[t[2]] # NULL
            /\ author[t[2]] # t[1]
            /\ t[3] \in 1..published[t[2]]

\* Forked scripts and their parents actually exist.
ForkParentCreated ==
    \A s \in Scripts : forkedFrom[s] # NoScript =>
        /\ s \in Created
        /\ forkedFrom[s] \in Created

=============================================================================
