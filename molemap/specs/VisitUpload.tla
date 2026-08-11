---------------------------- MODULE VisitUpload ----------------------------
(***************************************************************************)
(* Safety model of molemap's resumable visit-upload protocol between a    *)
(* local CLI and a Cloudflare Worker backed by D1 (visit rows) and R2     *)
(* (content-addressed artifact blobs).                                    *)
(*                                                                        *)
(* Uploading a visit: for each artifact sha the CLI sends a "begin"       *)
(* probe (does R2 already have this sha?) and, if absent, PUTs the        *)
(* bytes.  The server commits the blob to R2 BEFORE responding, so the    *)
(* success response can be lost while the write persisted; the CLI's      *)
(* belief for that sha becomes "unknown".  The CLI can crash at any       *)
(* point; on restart its belief is wiped and rebuilt purely by            *)
(* re-probing each sha.  That re-probe is the entire resume mechanism:    *)
(* there is no client-side journal the server has to trust.               *)
(*                                                                        *)
(* Finalize: the CLI POSTs a manifest referencing a set of artifact       *)
(* shas.  The server finalizes the visit with that manifest hash only if  *)
(* every referenced sha is present in R2 at commit time.  Finalize is     *)
(* idempotent for the same manifest hash (200 no-op) and rejects a        *)
(* different hash for an already-finalized visit (409).  The finalize     *)
(* response can also be lost; the CLI retries.  In-flight finalize        *)
(* requests are modeled as a message set (finReq) so they survive a       *)
(* client crash and can be processed while the CLI is down; PUT ack loss  *)
(* is folded into PutArtifact as a nondeterministic outcome.              *)
(*                                                                        *)
(* The client here is deliberately over-permissive: it may POST any       *)
(* manifest at any time, even before uploading anything.  The invariants  *)
(* must therefore be guaranteed by the server-side checks alone.          *)
(*                                                                        *)
(* DESIGN CONSTRAINT (found by TLC): finalize must be an ATOMIC           *)
(* check-and-set of the visit row -- in D1 terms, verify the referenced   *)
(* shas in R2, then                                                       *)
(*     UPDATE visits SET manifest = ?1 WHERE id = ?2 AND manifest IS NULL *)
(* resolving "0 rows changed" by re-reading: stored hash = mine => 200    *)
(* idempotent, else 409.  A naive read-validate-then-write finalize       *)
(* (read the visit as unfinalized in one step, write the manifest in a    *)
(* later step) is broken: with finalize requests for two different        *)
(* manifests concurrently in flight (a retry racing a re-run, or two      *)
(* devices), both validation reads see the visit as unfinalized, m1       *)
(* commits, then m2's write silently replaces it -- TLC produced a        *)
(* 9-state trace violating AtMostOneManifest (417 distinct states).      *)
(* ServerFinalizeCommit below models the corrected atomic form: its      *)
(* visit = "absent" guard and the visit write are one action.            *)
(***************************************************************************)

Artifacts == {"a1", "a2"}
Manifests == {"m1", "m2"}

\* Fixed manifest -> referenced-sha mapping: m1 references both artifacts,
\* m2 a proper subset, so both the 412 (missing blob) and 409 (different
\* manifest) server paths are reachable.
ArtifactsOf == [m \in Manifests |-> IF m = "m1" THEN {"a1", "a2"} ELSE {"a1"}]

Beliefs == {"pending", "uploaded", "unknown"}

VARIABLES
  cliBelief,     \* Artifacts -> CLI's local belief about each sha
  r2,            \* set of shas durably present in R2 (never deleted)
  visit,         \* server-side visit row: "absent" or the finalized manifest
  everVisit,     \* history: first manifest the visit was ever finalized with
  finReq,        \* finalize requests in flight (survive a client crash)
  cliKnowsFinal, \* what the CLI has learned from a delivered finalize 200
  crashed        \* CLI is down

vars == <<cliBelief, r2, visit, everVisit, finReq, cliKnowsFinal, crashed>>

TypeOK ==
  /\ cliBelief \in [Artifacts -> Beliefs]
  /\ r2 \subseteq Artifacts
  /\ visit \in {"absent"} \cup Manifests
  /\ everVisit \in {"absent"} \cup Manifests
  /\ finReq \subseteq Manifests
  /\ cliKnowsFinal \in {"none"} \cup Manifests
  /\ crashed \in BOOLEAN

Init ==
  /\ cliBelief = [a \in Artifacts |-> "pending"]
  /\ r2 = {}
  /\ visit = "absent"
  /\ everVisit = "absent"
  /\ finReq = {}
  /\ cliKnowsFinal = "none"
  /\ crashed = FALSE

(***************************************************************************)
(* "begin" probe: the CLI asks whether R2 already has the sha and          *)
(* rebuilds its belief from the answer.  This is the only way an          *)
(* "unknown" belief is ever resolved.                                     *)
(***************************************************************************)
BeginProbe(a) ==
  /\ ~crashed
  /\ cliBelief' = [cliBelief EXCEPT ![a] = IF a \in r2 THEN "uploaded" ELSE "pending"]
  /\ UNCHANGED <<r2, visit, everVisit, finReq, cliKnowsFinal, crashed>>

(***************************************************************************)
(* PUT: the server commits the blob to R2, then responds.  The response   *)
(* may be lost after the write persisted, leaving the CLI at "unknown";   *)
(* it recovers by re-probing (retry = BeginProbe on an "unknown" sha).    *)
(***************************************************************************)
PutArtifact(a) ==
  /\ ~crashed
  /\ cliBelief[a] = "pending"
  /\ r2' = r2 \cup {a}
  /\ \/ cliBelief' = [cliBelief EXCEPT ![a] = "uploaded"]  \* ack delivered
     \/ cliBelief' = [cliBelief EXCEPT ![a] = "unknown"]   \* ack lost
  /\ UNCHANGED <<visit, everVisit, finReq, cliKnowsFinal, crashed>>

CliCrash ==
  /\ ~crashed
  /\ crashed' = TRUE
  /\ UNCHANGED <<cliBelief, r2, visit, everVisit, finReq, cliKnowsFinal>>

\* Restart wipes all local state; belief is rebuilt only via probes.
CliRestart ==
  /\ crashed
  /\ crashed' = FALSE
  /\ cliBelief' = [a \in Artifacts |-> "unknown"]
  /\ cliKnowsFinal' = "none"
  /\ UNCHANGED <<r2, visit, everVisit, finReq>>

\* The CLI POSTs a manifest.  No belief guard: the server must be safe
\* against any client.  Retries re-enable this after a lost response.
FinalizeRequest(m) ==
  /\ ~crashed
  /\ cliKnowsFinal = "none"
  /\ m \notin finReq
  /\ finReq' = finReq \cup {m}
  /\ UNCHANGED <<cliBelief, r2, visit, everVisit, cliKnowsFinal, crashed>>

\* A 200 response either reaches a live CLI or is lost in transit.
RespondOk(m) ==
  \/ /\ ~crashed
     /\ cliKnowsFinal' = m
  \/ UNCHANGED cliKnowsFinal

(***************************************************************************)
(* Atomic check-and-set: blob presence check, unfinalized check, and the  *)
(* manifest write are a single action (D1 conditional UPDATE).            *)
(***************************************************************************)
ServerFinalizeCommit(m) ==
  /\ m \in finReq
  /\ visit = "absent"
  /\ ArtifactsOf[m] \subseteq r2
  /\ visit' = m
  /\ everVisit' = IF everVisit = "absent" THEN m ELSE everVisit
  /\ finReq' = finReq \ {m}
  /\ RespondOk(m)
  /\ UNCHANGED <<cliBelief, r2, crashed>>

\* Same manifest hash again: 200 no-op.
ServerFinalizeIdempotent(m) ==
  /\ m \in finReq
  /\ visit = m
  /\ finReq' = finReq \ {m}
  /\ RespondOk(m)
  /\ UNCHANGED <<cliBelief, r2, visit, everVisit, crashed>>

\* 409 (already finalized with a different manifest) or 412 (referenced
\* sha missing from R2).  No server-side state changes.
ServerFinalizeReject(m) ==
  /\ m \in finReq
  /\ \/ visit \notin {"absent", m}
     \/ (visit = "absent" /\ ~(ArtifactsOf[m] \subseteq r2))
  /\ finReq' = finReq \ {m}
  /\ UNCHANGED <<cliBelief, r2, visit, everVisit, cliKnowsFinal, crashed>>

Next ==
  \/ \E a \in Artifacts : BeginProbe(a) \/ PutArtifact(a)
  \/ CliCrash
  \/ CliRestart
  \/ \E m \in Manifests :
       \/ FinalizeRequest(m)
       \/ ServerFinalizeCommit(m)
       \/ ServerFinalizeIdempotent(m)
       \/ ServerFinalizeReject(m)

Spec == Init /\ [][Next]_vars

--------------------------------------------------------------------------------
(* Invariants *)

\* (1) A finalized visit's manifest references only blobs durably in R2.
FinalizedImpliesBlobsPresent ==
  visit \in Manifests => ArtifactsOf[visit] \subseteq r2

\* (2) Once finalized with m, the visit never becomes a different m'
\*     (everVisit records the first finalization and is never rewritten).
AtMostOneManifest ==
  visit \in Manifests => visit = everVisit

\* (3) The CLI never believes "uploaded" for a sha R2 does not have:
\*     probe-driven resume is sound.
BeliefAccurate ==
  \A a \in Artifacts : cliBelief[a] = "uploaded" => a \in r2

\* (4) A delivered finalize 200 reflects the actual finalized manifest.
CliFinalKnowledgeSound ==
  cliKnowsFinal \in Manifests => visit = cliKnowsFinal

================================================================================
