-- Sync metadata. PDF bytes live only in R2 (key: <user_id>/<sha256>).
CREATE TABLE records (
  user_id     TEXT NOT NULL,
  id          TEXT NOT NULL,          -- client-generated UUID
  type        TEXT NOT NULL,          -- notebook | document | highlight | link
  notebook_id TEXT NOT NULL,
  data        TEXT NOT NULL,          -- full record JSON (metadata + anchors only)
  updated_at  INTEGER NOT NULL,
  write_id    TEXT NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0,
  seq         INTEGER NOT NULL,       -- per-user monotonic, assigned on accept
  PRIMARY KEY (user_id, id)
);
CREATE INDEX idx_records_seq ON records (user_id, seq);

CREATE TABLE user_state (
  user_id  TEXT PRIMARY KEY,
  next_seq INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE blobs (
  user_id    TEXT NOT NULL,
  sha256     TEXT NOT NULL,
  size       INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, sha256)
);
