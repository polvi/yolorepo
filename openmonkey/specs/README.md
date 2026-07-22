# OpenMonkey TLA+ Specs

Formal safety model of the OpenMonkey design: an open userscript registry plus
browser extension. `OpenMonkey.tla` and `OpenMonkey.cfg` are the exact spec and
configuration that passed TLC model checking (114,630 states generated, 10,079
distinct, full search to depth 11, no violations). Hub record:
https://tlc.proc.io/hub/623f9b12-a08b-4b6d-850a-29d58934eb61/OpenMonkey

## What is modeled

State machine actions:

- **CreateScript**: creating a script publishes version 1 immediately and
  publicly. Versions are immutable once published.
- **PublishVersion**: only the author publishes new versions (up to
  `MaxVersion`); each is public at once.
- **Fork**: any user can fork any published script into a new script they
  author, recording `forkedFrom` lineage.
- **Scan**: a non-author user has a specific published version security-scanned
  on their own behalf (their own inference endpoint). Verdicts are
  nondeterministic: `pass`, `warn`, or `fail`. Scans are per user x per
  version and never change (versions are immutable).
- **OverrideWarn**: explicit user override recorded for a `warn` verdict.
- **InstallAsAuthor**: authors install their own published versions directly.
- **InstallForeign**: non-authors install a version only with a scan of exactly
  that version: `pass`, or `warn` plus a recorded override. `fail` never
  installs. A scan of version N grants nothing for version N+1, so upgrades
  force a rescan.
- **Run**: only installed (user, script, version) pairs run.
- **Uninstall**: removes the install and stops any running instance.

## Invariants checked

1. **NoUnscannedForeignRun**: every running (user, version) where the user is
   not the author has a scan verdict for exactly that version that is `pass`,
   or `warn` with an override recorded. Never `fail`, never unscanned.
2. **ScanIsPerVersion**: no foreign install rides on a scan of a different
   version; the scan consulted is for exactly the installed version.
3. **ForkAcyclic**: the transitive closure of `forkedFrom` is irreflexive.
4. **InstalledImpliesPublished**: every installed version was actually
   published.
5. **TypeOK** and **ForkParentCreated** (forked scripts and their parents
   exist) as supporting invariants.

## Auth is out of scope here

OpenMonkey consumes authentication as an abstract session gate: the API
validates the first-party `session_id` cookie (set on the proc.io registrable
domain) by forwarding it to AuthGravity's `/v1/whoami`. The login, register,
and account UI lives in the shared auth surface at auth.proc.io (the
`procauth/` project), which apps link to with a `return_to`; AuthGravity still
issues and validates sessions. That ceremony (challenge issuance, single-use
5-minute expiry, verify creating a session, logout, `return_to` allowlisting)
is modeled separately in `procauth/specs/ProcAuth.tla`, so this spec stays
lean and needs no session state.

## Finiteness and symmetry choices

The model is kept finite and small for the safety-subset TLC engine:

- Constants: 2 users, 2 script slots, versions bounded to 2.
- Script identities are ordered slots allocated lowest-free-slot first,
  removing slot-labeling symmetry.
- Direct creation is done by a designated `Creator` user; other users become
  authors via `Fork`, so author and non-author roles are still exercised for
  every user.
- `StateConstraint` (a model artifact, not part of the design) caps cumulative
  scan records at 2, scans plus installs at 3, and concurrent runs at 1. All
  invariant-relevant scenarios fit inside the cap, including the
  upgrade-needs-rescan flow (scan v1, install v1, publish v2, scan v2,
  uninstall v1, install v2), warn-plus-override, fail-blocks-install, and
  fork-then-scan.

## Re-checking

Run the spec and config through the `tlc_check` MCP tool (or TLC with the
`.cfg`) unchanged. Keep updates to this spec in lockstep with architecture
changes, and only commit `.tla`/`.cfg` pairs that pass.
