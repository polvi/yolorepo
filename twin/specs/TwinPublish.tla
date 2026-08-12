------------------------------ MODULE TwinPublish ------------------------------
(***************************************************************************)
(* Publish protocol for a Gaussian-splat scene host backed by an object   *)
(* store (R2) with per-object atomic writes and strong read-after-write   *)
(* consistency.  One scene slug, three logical objects:                   *)
(*                                                                        *)
(*   ARTIFACT  the splat bytes                                            *)
(*   META      scene metadata naming/describing the artifact              *)
(*   INDEX     the global scene listing                                   *)
(*                                                                        *)
(* The publisher writes, in strict order, ARTIFACT=v then META=v then     *)
(* INDEX=v.  A republish repeats the sequence with v+1, overwriting in    *)
(* place.  Readers discover via INDEX, then read META, then ARTIFACT;     *)
(* each read is a separate non-atomic step, so a republish can            *)
(* interleave anywhere.                                                   *)
(*                                                                        *)
(* Version 0 means "object does not exist".                               *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    MaxV,     \* number of publishes the publisher performs (versions 1..MaxV)
    Readers   \* set of reader identities

ASSUME MaxV \in Nat /\ MaxV >= 1

VARIABLES
    artifact,  \* version currently stored in the ARTIFACT object (0 = absent)
    meta,      \* version currently stored in the META object     (0 = absent)
    index,     \* version the INDEX entry points at               (0 = unlisted)
    pubV,      \* version the publisher is currently publishing (MaxV+1 = done)
    pubPhase,  \* next object the publisher will write
    rpc,       \* per-reader program counter
    rMeta,     \* version each reader observed when it read META
    rArt       \* version each reader observed when it read ARTIFACT

vars == <<artifact, meta, index, pubV, pubPhase, rpc, rMeta, rArt>>

Versions == 0..MaxV

TypeOK ==
    /\ artifact \in Versions
    /\ meta     \in Versions
    /\ index    \in Versions
    /\ pubV     \in 1..(MaxV + 1)
    /\ pubPhase \in {"artifact", "meta", "index"}
    /\ rpc      \in [Readers -> {"index", "meta", "artifact", "done"}]
    /\ rMeta    \in [Readers -> Versions]
    /\ rArt     \in [Readers -> Versions]

Init ==
    /\ artifact = 0
    /\ meta     = 0
    /\ index    = 0
    /\ pubV     = 1
    /\ pubPhase = "artifact"
    /\ rpc      = [r \in Readers |-> "index"]
    /\ rMeta    = [r \in Readers |-> 0]
    /\ rArt     = [r \in Readers |-> 0]

(***************************************************************************)
(* Publisher: one atomic object write per step, in strict order.          *)
(***************************************************************************)

PubWriteArtifact ==
    /\ pubV <= MaxV
    /\ pubPhase = "artifact"
    /\ artifact' = pubV
    /\ pubPhase' = "meta"
    /\ UNCHANGED <<meta, index, pubV, rpc, rMeta, rArt>>

PubWriteMeta ==
    /\ pubV <= MaxV
    /\ pubPhase = "meta"
    /\ meta' = pubV
    /\ pubPhase' = "index"
    /\ UNCHANGED <<artifact, index, pubV, rpc, rMeta, rArt>>

PubWriteIndex ==
    /\ pubV <= MaxV
    /\ pubPhase = "index"
    /\ index' = pubV
    /\ pubV' = pubV + 1
    /\ pubPhase' = "artifact"
    /\ UNCHANGED <<artifact, meta, rpc, rMeta, rArt>>

(***************************************************************************)
(* Readers: INDEX, then META, then ARTIFACT, one non-atomic read per      *)
(* step.  A reader that finds the scene unlisted stops.                   *)
(***************************************************************************)

ReadIndex(r) ==
    /\ rpc[r] = "index"
    /\ rpc' = [rpc EXCEPT ![r] = IF index = 0 THEN "done" ELSE "meta"]
    /\ UNCHANGED <<artifact, meta, index, pubV, pubPhase, rMeta, rArt>>

ReadMeta(r) ==
    /\ rpc[r] = "meta"
    /\ rMeta' = [rMeta EXCEPT ![r] = meta]
    /\ rpc' = [rpc EXCEPT ![r] = "artifact"]
    /\ UNCHANGED <<artifact, meta, index, pubV, pubPhase, rArt>>

ReadArtifact(r) ==
    /\ rpc[r] = "artifact"
    /\ rArt' = [rArt EXCEPT ![r] = artifact]
    /\ rpc' = [rpc EXCEPT ![r] = "done"]
    /\ UNCHANGED <<artifact, meta, index, pubV, pubPhase, rMeta>>

(***************************************************************************)
(* Allow stuttering once everything has finished (avoids a spurious      *)
(* deadlock report in this terminating model).                            *)
(***************************************************************************)

Terminating ==
    /\ pubV > MaxV
    /\ \A r \in Readers : rpc[r] = "done"
    /\ UNCHANGED vars

Next ==
    \/ PubWriteArtifact
    \/ PubWriteMeta
    \/ PubWriteIndex
    \/ \E r \in Readers : ReadIndex(r) \/ ReadMeta(r) \/ ReadArtifact(r)
    \/ Terminating

Spec == Init /\ [][Next]_vars

(***************************************************************************)
(* Invariants                                                              *)
(***************************************************************************)

\* If the INDEX lists the scene, its META and ARTIFACT objects exist.
NoDanglingIndex ==
    index /= 0 => (meta /= 0 /\ artifact /= 0)

\* The stored META never describes an artifact that has not been written:
\* at every state, META's version is at most ARTIFACT's version.  This is
\* exactly what the artifact-before-meta write order buys.
MetaNeverAheadOfArtifact ==
    meta <= artifact

\* A reader that completed its sequence may have seen stale meta with newer
\* bytes (rMeta <= rArt), but never meta describing bytes newer than what
\* it fetched.  Readers that stopped at an empty index have 0 <= 0.
ReaderSafety ==
    \A r \in Readers :
        rpc[r] = "done" => rMeta[r] <= rArt[r]

=================================================================================
