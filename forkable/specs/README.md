# ForkRefs — TLA+ spec of the ref-update protocol

Model-checked spec of the git ref-update protocol for forkable sites: one
repo per site, refs updated only by atomic compare-and-swap pushes, with
per-ref permissions and an owner-only merge-proposal action.

Published (passing) generation: https://tlc.proc.io/hub/623f9b12-a08b-4b6d-850a-29d58934eb61/ForkRefs

## What is modeled

- Refs: `main` (the live site, owner-writable only) and `fork_u` per user
  (writable only by user u). Ref values are abstract commit ids; `0`
  (`NoCommit`) means the ref is absent, so fork creation is just a push
  whose `old` is `NoCommit`.
- Pushes: `(user, ref, old, new)` applied by the server iff the ref
  currently equals `old` AND the permission predicate holds; otherwise the
  push fails cleanly with no server-side change and the client may
  re-fetch and retry. The CAS test, permission test, and ref write are one
  atomic action.
- Ancestry: each locally created commit records its parent (the fetched
  base), giving an abstract fast-forward relation.
- `AcceptProposal`: the owner atomically sets `main` to the head of a fork
  ref (merge proposals). Owner-only; reading the fork head and writing
  `main` is a single atomic step.
- Clients: two devices of the same user (`d1`, `d2`) racing the
  fetch → commit → CAS-push loop against that user's fork ref, one owner
  device (`od`) pushing `main`, and one non-owner device (`xd`)
  attempting `main` (always rejected by permissions).
- A history variable `hist` records every successful server-side write
  (ref, writer, old, new, kind); all invariants below are stated over it.

## Invariants checked

- `TypeOK` — state typing.
- `MainWrittenOnlyByOwner` — every write to `main` (push or accept) was by
  the owner.
- `ForkWrittenOnlyByItsUser` — every write to `fork_u` was by user u.
- `NoLostUpdate` — CAS atomicity: per ref, the history of successful
  writes forms an unbroken old/new chain from the initial value, so no
  successful push ever overwrote a value its pusher never saw.
- `PushIsFastForward` — every successful CAS push's new commit has the
  pushed-over value as its parent (accepts are exempt: a merge moves
  `main` to a fork head that need not descend from old `main`).
- `RefsMatchHistory` — live ref values equal what the history implies.

Result: all invariants hold. 97,017 states generated, 39,100 distinct,
depth 17, queue empty (complete search of the bounded model).

## What is abstracted away

- Commit contents, trees, blobs, pack transfer: commits are naturals with
  a parent map, nothing more.
- Merge commits and non-fast-forward pushes: clients only produce
  single-parent fast-forward candidates; `AcceptProposal` is the only
  non-fast-forward ref move.
- Authentication itself: users are trusted identities; only the
  permission predicate is modeled.
- Liveness/termination: the model bounds retries and commits, so runs end;
  deadlock checking is off (`CHECK_DEADLOCK FALSE`) because quiescence is
  expected, not an error.
- Bounds (kept small for tractability): 2 users (owner + one), commit ids
  1..6, device retry budgets 2/1/1/1, at most 1 accept.

## Re-running the check

Validate `ForkRefs.tla` with the `tlc_parse` MCP tool, then run
`tlc_check` with the module source and the contents of `ForkRefs.cfg` as
the config. The files in this directory are byte-for-byte the passing
configuration. Any classic TLA+ toolchain works too:
`tlc -config ForkRefs.cfg ForkRefs.tla` (deadlock checking already
disabled in the cfg).

## What implementers must get right

- The server's push handler must evaluate CAS + permission + ref write in
  one transaction (single-writer per repo, a serialized ref store, or an
  atomic conditional write). A check-then-write gap reintroduces the lost
  update the CAS exists to prevent.
- `AcceptProposal` must read the fork head and write `main` atomically;
  resolving the fork head first and writing later can publish a stale
  head.
- Rejected pushes must leave no partial state; clients recover purely by
  re-fetching.
