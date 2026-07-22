CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,            -- AuthGravity user UUID
  handle TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scripts (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  author_id TEXT NOT NULL REFERENCES users(id),
  forked_from TEXT REFERENCES scripts(id),
  install_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS versions (
  id TEXT PRIMARY KEY,
  script_id TEXT NOT NULL REFERENCES scripts(id),
  version INTEGER NOT NULL,
  code TEXT NOT NULL,
  match_patterns TEXT NOT NULL,   -- JSON array of @match/@include patterns
  changelog TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (script_id, version)
);

CREATE TABLE IF NOT EXISTS scan_reports (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES versions(id),
  reporter_id TEXT NOT NULL REFERENCES users(id),
  verdict TEXT NOT NULL CHECK (verdict IN ('pass','warn','fail')),
  summary TEXT,
  model TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (version_id, reporter_id)
);

CREATE INDEX IF NOT EXISTS idx_scripts_created ON scripts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_versions_script ON versions(script_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_scans_version ON scan_reports(version_id);
