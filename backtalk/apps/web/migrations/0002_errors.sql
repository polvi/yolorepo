-- Error capture. Group ids are DETERMINISTIC — sha256(project_id ':'
-- fingerprint) truncated — so two workers ingesting the same new error
-- concurrently collide harmlessly on INSERT OR IGNORE instead of racing a
-- read-then-create. event_count on the group is the source of truth
-- (single-statement increment); error_events rows are samples only, pruned
-- to the newest 10 per group. The resolved->regressed transition happens
-- ONLY inside the ingest UPDATE's CASE, never via read-modify-write
-- (model-checked in specs/BacktalkGroups.tla).

CREATE TABLE error_groups (
  id              TEXT PRIMARY KEY, -- sha256(project_id + ':' + fingerprint)[:32]
  project_id      TEXT NOT NULL REFERENCES projects(id),
  fingerprint     TEXT NOT NULL,
  title           TEXT NOT NULL, -- normalized message, truncated
  status          TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','resolved','regressed')),
  resolution_note TEXT,
  resolved_at     INTEGER,
  event_count     INTEGER NOT NULL DEFAULT 0,
  first_seen      INTEGER NOT NULL,
  last_seen       INTEGER NOT NULL,
  UNIQUE (project_id, fingerprint)
);
CREATE INDEX idx_groups ON error_groups (project_id, status, last_seen DESC);

CREATE TABLE error_events (
  id          TEXT PRIMARY KEY, -- client UUID = idempotency key
  group_id    TEXT NOT NULL REFERENCES error_groups(id),
  message     TEXT,
  stack       TEXT,
  page_url    TEXT,
  ua          TEXT,
  release     TEXT,
  breadcrumbs TEXT, -- JSON array
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_events_group ON error_events (group_id, created_at DESC);
