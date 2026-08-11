# Backtalk specs

Model-checked design for backtalk's error-event ingestion into error groups
on D1 (SQLite). Multiple stateless workers ingest events concurrently while a
resolver marks groups resolved. There are no cross-statement transactions:
each SQL statement is atomic, and statements from different requests
interleave freely.

Published check: https://tlc.proc.io/hub/623f9b12-a08b-4b6d-850a-29d58934eb61/BacktalkGroups
(the naive-variant save is showcased on the same page under wins).

## What `BacktalkGroups.tla` models

Per-event ingest as three atomic statements:

1. `INSERT OR IGNORE INTO error_events (id, ...)` with a client-generated
   UUID; retries reuse the id, and `changes = 0` stops the request.
2. `INSERT OR IGNORE INTO error_groups (id, status='open', event_count=0)`
   where the group id is the deterministic `hash(project, fingerprint)`, so
   concurrent creators collide harmlessly.
3. One conditional update:

   ```sql
   UPDATE error_groups
   SET event_count = event_count + 1,
       last_seen   = ?,
       status      = CASE WHEN status = 'resolved' THEN 'regressed'
                     ELSE status END
   WHERE id = ?
   ```

The resolver is a single atomic statement setting `status = 'resolved'`,
legal from `open` or `regressed`.

Finite model: 3 event ids over 2 fingerprints, 2 workers whose attempt
queues both start with `e1` (a client retry reusing the same event id), and
a resolver bounded to `MaxResolves = 2` actions. Full state space: 412
states generated, 199 distinct, search depth 13, no errors.

## Invariants

- **TypeOK**: variable domains.
- **OneGroupPerFingerprint**: a fingerprint never has two group rows, even
  when both workers race the group insert (the deterministic group id makes
  the second `INSERT OR IGNORE` a no-op).
- **CountExact**: every group's `event_count` equals the number of distinct
  accepted event ids of that fingerprint whose step-3 update has completed.
  Catches retry double counting and lost counter updates.
- **NoMissedRegression**: via a history variable `dirty[fp]` (set when an
  ingest completes step 3, cleared by a resolve), if any ingest completed
  after the group's most recent resolve, the group does not still read
  `resolved`.

## The race TLC caught

The naive design ran step 3 as two statements: `SELECT status`, then a write
that incremented the counter and decided the `resolved -> regressed` flip
from the value just read. Selecting `Variant = "naive"` in the config, TLC
violates `NoMissedRegression` in 5 steps:

1. Worker w1 accepts event `e1` (fingerprint `f1`).
2. w1 creates the `f1` group with status `open`.
3. w1 reads status: `open`.
4. Resolver marks the group `resolved`.
5. w1's write lands: `event_count` becomes 1, but status stays `resolved`
   because the stale read said `open` and the write leaves status untouched.

An event fully ingested after the resolve, yet the group still shows
`resolved`: the regression is silently swallowed and never resurfaces.

The fix pushes the condition into the database. The single atomic `UPDATE`
with `CASE WHEN status='resolved' THEN 'regressed' ELSE status END`
evaluates against the row's value at write time, and all four invariants
pass. Both variants live in the spec behind the `Variant` constant;
`BacktalkGroups.cfg` is the exact passing configuration (`"atomic"`). To
reproduce the violation, change it to `Variant = "naive"`.

## Implementation notes

- Step 3 must be exactly one `UPDATE` statement; never read status in the
  worker and write a decision based on it.
- The `changes = 0` check after step 1 is load-bearing for `CountExact`:
  it is what stops a retried event id from reaching step 3 twice.
- `event_count` increments must be server-side (`event_count + 1` in SQL),
  never computed in the worker.
