-- Users are keyed by the AuthGravity UUID; nothing else about them is stored.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  publish INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- API keys are stored as SHA-256 hashes only; the plaintext is shown once.
CREATE TABLE api_keys (
  key_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);
CREATE INDEX api_keys_user ON api_keys(user_id);

-- One row per (user, module name); generations hang off it.
CREATE TABLE specs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  latest_gen INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, name)
);

-- Immutable snapshots. content_hash dedupes: republishing identical
-- content touches specs.updated_at instead of minting a generation.
CREATE TABLE generations (
  spec_id INTEGER NOT NULL REFERENCES specs(id),
  gen INTEGER NOT NULL,
  tla TEXT NOT NULL,
  cfg TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  distinct_states INTEGER,
  depth INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (spec_id, gen)
);
