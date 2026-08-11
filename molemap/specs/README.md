# VisitUpload — TLA+ spec of molemap's resumable visit upload

Model-checked spec of the upload protocol between the molemap CLI and the
Worker (D1 visit rows + R2 content-addressed blobs): per-sha probe/PUT with
lossy acks, crash/restart resume driven purely by re-probing, and a
finalize step that binds a manifest to the visit.

Published (passing) generation: https://tlc.proc.io/hub/623f9b12-a08b-4b6d-850a-29d58934eb61/VisitUpload

## What is modeled and checked

- Artifact upload: `BeginProbe` (does R2 have this sha?) rebuilds the CLI's
  per-sha belief; `PutArtifact` commits the blob to R2 before responding,
  and the ack may be lost, leaving belief at `unknown`. `CliCrash` /
  `CliRestart` wipe all local state to `unknown`; probes are the entire
  resume mechanism.
- Finalize: requests live in an in-flight message set (they survive a
  client crash). The server commit is one atomic action: visit still
  unfinalized, every referenced sha present in R2, write the manifest.
  Same manifest again is a 200 no-op; a different manifest on a finalized
  visit is a 409; missing blobs is a 412. The 200 response may be lost and
  the CLI retries.
- The modeled client is over-permissive on purpose: it may POST any
  manifest at any time, so TLC proves the server-side checks alone
  guarantee the invariants.

Invariants: `TypeOK`; `FinalizedImpliesBlobsPresent` (a finalized visit's
manifest references only blobs durably in R2); `AtMostOneManifest` (once
finalized with m, the visit never becomes a different m', checked against
a history variable); `BeliefAccurate` (the CLI never believes `uploaded`
for a sha R2 lacks); `CliFinalKnowledgeSound` (a delivered finalize 200
matches the actual finalized manifest).

Result: all invariants hold. 1,041 states generated, 272 distinct,
depth 10, queue empty (complete search). A naive variant with finalize
split into a validate read and a separate write was checked first: TLC
produced a 9-state trace (417 distinct states explored) where finalize
requests for two different manifests both validate against the
unfinalized visit and the second write silently replaces the first
manifest, violating `AtMostOneManifest`. The trace and fix are documented
in the spec's header.

## What implementers must get right

- Server: finalize is an atomic check-then-set of the visit row. Verify
  the referenced shas in R2, then
  `UPDATE visits SET manifest = ?1 WHERE id = ?2 AND manifest IS NULL`;
  insert the token of success only if exactly one row changed. On zero
  rows changed, re-read: stored hash equals the submitted hash gives an
  idempotent 200, anything else a 409. A read-validate-then-write gap
  reintroduces the manifest-overwrite race above.
- Server: reject a different manifest for a finalized visit (409) with no
  state change, and reject finalize with any referenced sha missing from
  R2 (412) with no state change; both responses may be retried safely.
- Server: commit the blob to R2 before acknowledging a PUT, so a lost ack
  always errs toward re-upload of an already-present blob (idempotent for
  content-addressed keys), never toward a phantom blob.
- CLI: treat any lost or unclear response as `unknown` and rebuild belief
  only via probes. Keep no client-side journal of what was uploaded;
  resume after a crash is re-probe every sha, then PUT only the misses,
  then retry finalize with the same manifest hash.
