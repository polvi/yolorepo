# OpenMonkey TLA+ Specs

Formal safety model of the OpenMonkey design: an open userscript registry.
OpenMonkey ships no browser extension of its own; users install scripts
through standard third-party userscript managers (the quoid/userscripts
Safari app, Tampermonkey, etc.) that fetch a raw `<slug>.user.js` URL from
the registry. `OpenMonkey.tla` and `OpenMonkey.cfg` are the exact spec and
configuration that passed TLC model checking (36,231 states generated, 2,313
distinct, full search to depth 8, no violations). Hub record:
https://tlc.proc.io/hub/623f9b12-a08b-4b6d-850a-29d58934eb61/OpenMonkey

## What is modeled

State machine actions:

- **CreateScript**: creating a script publishes version 1 immediately and
  publicly. Versions are immutable once published.
- **PublishVersion**: only the author publishes new versions (up to
  `MaxVersion`); each is public at once, and the version number only grows.
- **Fork**: any user can fork any published script into a new script they
  author, recording `forkedFrom` lineage.
- **Scan**: a non-author user has a specific published version security-scanned
  on their own behalf (their own inference endpoint) and publishes the verdict
  to the registry as an advisory community report. Verdicts are
  nondeterministic: `pass`, `warn`, or `fail`. Scans are per user x per exact
  version and never change (versions are immutable), and a verdict for version
  N says nothing about version N+1.
- **Install**: any user installs any published version by pointing their
  userscript manager at the raw `<slug>.user.js` URL. No scan verdict is
  consulted; the registry cannot gate this step.
- **Run**: only installed (user, script, version) pairs run.
- **Uninstall**: removes the install and stops any running instance.

## Scan verdicts are advisory

Install and run happen inside a third-party userscript manager, outside the
registry's trusted computing base, so the registry cannot enforce "no foreign
version runs without a pass or accepted-warn scan". The earlier model's
enforced gate (and its warn-override machinery) is gone. Scan-before-run is
now a user norm supported by published community verdicts, not a system
invariant, and the spec deliberately checks no such invariant. What remains
are exactly the properties the registry itself enforces.

## Invariants checked

1. **ForkAcyclic**: the transitive closure of `forkedFrom` is irreflexive.
2. **InstalledImpliesPublished**: every installed version was actually
   published (managers can only fetch published `<slug>.user.js` content, and
   versions are never retracted).
3. **RunningImpliesInstalled**: a manager only runs scripts it holds.
4. **ScanRefsPublishedVersion**: every recorded scan verdict references an
   exact published version of an existing script, never a version of the
   reporter's own script; verdicts never carry over across versions because
   the scan record is keyed on the exact version.
5. **TypeOK** and **ForkParentCreated** (forked scripts and their parents
   exist) as supporting invariants.

Immutability and monotonic publishing, and author-only version publishing,
are enforced by construction in the `PublishVersion` action (the published
version only increments, and only when `author[s] = u`).

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
  scan records at 1, scans plus installs at 2, and concurrent runs at 1. With
  installs no longer gated on scans, this tighter cap keeps the search small
  while still covering every invariant-relevant scenario: install without any
  scan, run-then-uninstall, install-then-upgrade-then-reinstall (uninstall v1,
  install v2), scan-after-install, and fork-then-scan.

## Re-checking

Run the spec and config through the `tlc_check` MCP tool (or TLC with the
`.cfg`) unchanged. Keep updates to this spec in lockstep with architecture
changes, and only commit `.tla`/`.cfg` pairs that pass.
