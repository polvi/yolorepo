-- backtalk core: users (AuthGravity UUIDs), projects (one per embedding
-- site, identified by a non-secret pk_ ingest key), feedback items keyed by
-- CLIENT-generated UUIDs so widget retries are idempotent (INSERT OR
-- IGNORE), api_tokens (bt_ bearer tokens for the MCP server, sha256-hashed),
-- and ingest_daily (per-project per-kind daily counters that double as the
-- rate limiter).

CREATE TABLE users (
  id         TEXT PRIMARY KEY, -- AuthGravity UUID (procauth)
  created_at INTEGER NOT NULL
);

CREATE TABLE projects (
  id              TEXT PRIMARY KEY, -- UUID
  owner_id        TEXT NOT NULL REFERENCES users(id),
  name            TEXT NOT NULL,
  public_key      TEXT NOT NULL UNIQUE, -- 'pk_' + base64url(12 bytes); not a secret
  allowed_origins TEXT NOT NULL DEFAULT '', -- comma-separated exact origins; '' = allow any
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_projects_owner ON projects (owner_id);
CREATE INDEX idx_projects_key ON projects (public_key);

CREATE TABLE feedback (
  id              TEXT PRIMARY KEY, -- client UUID = idempotency key
  project_id      TEXT NOT NULL REFERENCES projects(id),
  kind            TEXT NOT NULL CHECK (kind IN ('bug','idea','feedback')),
  message         TEXT NOT NULL,
  page_url        TEXT,
  viewport        TEXT,
  ua              TEXT,
  tz              TEXT,
  metadata        TEXT,  -- JSON from window.backtalk.set({...})
  breadcrumbs     TEXT,  -- JSON array, <=20 entries
  release         TEXT,
  status          TEXT NOT NULL DEFAULT 'new'
                    CHECK (status IN ('new','seen','planned','done','declined')),
  resolution_note TEXT,  -- shown to the submitter once done/declined
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_feedback ON feedback (project_id, status, created_at DESC);

CREATE TABLE api_tokens (
  token_hash   TEXT PRIMARY KEY, -- sha256 hex of the bt_ plaintext
  user_id      TEXT NOT NULL REFERENCES users(id),
  name         TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX idx_tokens_user ON api_tokens (user_id);

CREATE TABLE ingest_daily (
  project_id TEXT NOT NULL,
  day        TEXT NOT NULL, -- 'YYYY-MM-DD' UTC
  kind       TEXT NOT NULL, -- 'feedback'|'error'|'vital'|'pageview'
  count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, day, kind)
);
