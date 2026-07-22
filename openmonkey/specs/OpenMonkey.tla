---------------------------- MODULE OpenMonkey ----------------------------
(***************************************************************************)
(* OpenMonkey: an open userscript registry plus browser extension.        *)
(*                                                                         *)
(* Scripts have immutable published versions (1..MaxVersion).  Publishing  *)
(* a script or a new version makes it public immediately.  A user installs *)
(* a specific (script, version).  Authors install their own scripts        *)
(* directly; anyone else must first have that exact version security-      *)
(* scanned on their own behalf (scan is per user x per version).  Verdicts *)
(* are pass / warn / fail: pass installs, warn installs only with an       *)
(* explicit user override, fail never installs.  Only installed pairs may  *)
(* run.  A new version is never covered by scans of older versions.  Any   *)
(* user may fork any published script, producing a new script they author  *)
(* with forked_from lineage, which must stay acyclic.                      *)
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
    overrides,  \* set of <<user, script, version>> with explicit warn override
    installed,  \* set of <<user, script, version>>
    running     \* set of <<user, script, version>>, subset of installed

vars == <<author, published, forkedFrom, scans, overrides, installed, running>>

Created == {s \in Scripts : published[s] > 0}

\* Lowest-free-slot allocation for new script identities.
NextFreeSlot(s) == published[s] = 0 /\ \A x \in 1..(s - 1) : published[x] > 0

Init ==
    /\ author = [s \in Scripts |-> NULL]
    /\ published = [s \in Scripts |-> 0]
    /\ forkedFrom = [s \in Scripts |-> NoScript]
    /\ scans = [x \in Users \X Scripts \X Versions |-> "none"]
    /\ overrides = {}
    /\ installed = {}
    /\ running = {}

(***************************************************************************)
(* Publishing                                                              *)
(***************************************************************************)

\* Creating a script publishes version 1 immediately and publicly.
CreateScript(u, s) ==
    /\ u = Creator
    /\ NextFreeSlot(s)
    /\ author' = [author EXCEPT ![s] = u]
    /\ published' = [published EXCEPT ![s] = 1]
    /\ UNCHANGED <<forkedFrom, scans, overrides, installed, running>>

\* Only the author publishes new versions; they are public at once.
PublishVersion(u, s) ==
    /\ author[s] = u
    /\ published[s] \in 1..(MaxVersion - 1)
    /\ published' = [published EXCEPT ![s] = published[s] + 1]
    /\ UNCHANGED <<author, forkedFrom, scans, overrides, installed, running>>

\* Any user can fork any published (hence readable) script into a fresh
\* script identity they author, recording forked_from lineage.
Fork(u, src, dst) ==
    /\ src \in Created
    /\ NextFreeSlot(dst)
    /\ author' = [author EXCEPT ![dst] = u]
    /\ published' = [published EXCEPT ![dst] = 1]
    /\ forkedFrom' = [forkedFrom EXCEPT ![dst] = src]
    /\ UNCHANGED <<scans, overrides, installed, running>>

(***************************************************************************)
(* Scanning                                                                *)
(***************************************************************************)

\* A non-author user scans a specific published version on their own
\* behalf (their own inference endpoint).  The verdict is nondeterministic.
\* Versions are immutable, so a verdict never changes once recorded.
Scan(u, s, v) ==
    /\ v \in 1..published[s]
    /\ author[s] # NULL
    /\ author[s] # u
    /\ scans[u, s, v] = "none"
    /\ \E verdict \in Verdicts :
          scans' = [scans EXCEPT ![u, s, v] = verdict]
    /\ UNCHANGED <<author, published, forkedFrom, overrides, installed, running>>

\* Explicit user override of a warn verdict.
OverrideWarn(u, s, v) ==
    /\ scans[u, s, v] = "warn"
    /\ <<u, s, v>> \notin overrides
    /\ overrides' = overrides \cup {<<u, s, v>>}
    /\ UNCHANGED <<author, published, forkedFrom, scans, installed, running>>

(***************************************************************************)
(* Installing and running                                                  *)
(***************************************************************************)

\* Authors install their own published versions directly, no scan needed.
InstallAsAuthor(u, s, v) ==
    /\ author[s] = u
    /\ v \in 1..published[s]
    /\ <<u, s, v>> \notin installed
    /\ installed' = installed \cup {<<u, s, v>>}
    /\ UNCHANGED <<author, published, forkedFrom, scans, overrides, running>>

\* Non-authors install only after a scan of exactly this version on their
\* behalf: pass, or warn with an explicit override.  fail never installs.
\* A scan of any other version of the same script grants nothing.
InstallForeign(u, s, v) ==
    /\ author[s] # NULL
    /\ author[s] # u
    /\ v \in 1..published[s]
    /\ <<u, s, v>> \notin installed
    /\ \/ scans[u, s, v] = "pass"
       \/ /\ scans[u, s, v] = "warn"
          /\ <<u, s, v>> \in overrides
    /\ installed' = installed \cup {<<u, s, v>>}
    /\ UNCHANGED <<author, published, forkedFrom, scans, overrides, running>>

\* Only installed pairs run.
Run(u, s, v) ==
    /\ <<u, s, v>> \in installed
    /\ <<u, s, v>> \notin running
    /\ running' = running \cup {<<u, s, v>>}
    /\ UNCHANGED <<author, published, forkedFrom, scans, overrides, installed>>

\* Uninstalling also stops any running instance.
Uninstall(u, s, v) ==
    /\ <<u, s, v>> \in installed
    /\ installed' = installed \ {<<u, s, v>>}
    /\ running' = running \ {<<u, s, v>>}
    /\ UNCHANGED <<author, published, forkedFrom, scans, overrides>>

Next ==
    \E u \in Users, s \in Scripts :
        \/ CreateScript(u, s)
        \/ PublishVersion(u, s)
        \/ \E dst \in Scripts : Fork(u, s, dst)
        \/ \E v \in Versions :
              \/ Scan(u, s, v)
              \/ OverrideWarn(u, s, v)
              \/ InstallAsAuthor(u, s, v)
              \/ InstallForeign(u, s, v)
              \/ Run(u, s, v)
              \/ Uninstall(u, s, v)

Spec == Init /\ [][Next]_vars

(***************************************************************************)
(* Finite-exploration bound (model artifact, not part of the design).      *)
(* Caps cumulative scan records, concurrent installs, and concurrent runs  *)
(* so TLC's search stays small.  Every invariant-relevant scenario fits    *)
(* inside it: upgrade-needs-rescan (scan v1, install v1, publish v2, scan  *)
(* v2, swap installs), warn-plus-override, fail-blocks, fork-then-scan.    *)
(***************************************************************************)

ScannedSlots == {t \in Users \X Scripts \X Versions : scans[t] # "none"}

StateConstraint ==
    /\ Cardinality(ScannedSlots) <= 2
    /\ Cardinality(ScannedSlots) + Cardinality(installed) <= 3
    /\ Cardinality(running) <= 1

(***************************************************************************)
(* Invariants                                                              *)
(***************************************************************************)

TypeOK ==
    /\ author \in [Scripts -> Users \cup {NULL}]
    /\ published \in [Scripts -> 0..MaxVersion]
    /\ forkedFrom \in [Scripts -> Scripts \cup {NoScript}]
    /\ scans \in [Users \X Scripts \X Versions -> Verdicts \cup {"none"}]
    /\ overrides \subseteq Users \X Scripts \X Versions
    /\ installed \subseteq Users \X Scripts \X Versions
    /\ running \subseteq installed

\* 1. Any running foreign (user, version) has a scan verdict for exactly
\*    that version: pass, or warn with a recorded override.  Never fail,
\*    never unscanned.
NoUnscannedForeignRun ==
    \A t \in running :
        LET u == t[1]  s == t[2]  v == t[3] IN
        \/ author[s] = u
        \/ scans[u, s, v] = "pass"
        \/ /\ scans[u, s, v] = "warn"
           /\ t \in overrides

\* 2. No foreign install rides on a scan of a different version: the scan
\*    consulted is for exactly the installed version (and is acceptable).
ScanIsPerVersion ==
    \A t \in installed :
        LET u == t[1]  s == t[2]  v == t[3] IN
        author[s] # u =>
            /\ scans[u, s, v] \in {"pass", "warn"}
            /\ (scans[u, s, v] = "warn" => t \in overrides)

\* 3. Fork lineage is acyclic (transitive closure of forked_from is
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

\* 4. Every installed version was actually published (and versions are
\*    never retracted, so this stays true).
InstalledImpliesPublished ==
    \A t \in installed : t[3] \in 1..published[t[2]]

\* Forked scripts and their parents actually exist.
ForkParentCreated ==
    \A s \in Scripts : forkedFrom[s] # NoScript =>
        /\ s \in Created
        /\ forkedFrom[s] \in Created

=============================================================================
