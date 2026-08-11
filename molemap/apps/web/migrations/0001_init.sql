-- molemap: viewer + record system for 3D body reconstructions.
-- The local pipeline uploads only derived artifacts; raw photos never reach
-- the server. Mole positions live in a canonical body frame (body height = 1)
-- reached by applying the per-visit alignment matrix to visit-local points.

CREATE TABLE users (
  id         TEXT PRIMARY KEY,             -- AuthGravity UUID (procauth)
  created_at INTEGER NOT NULL
);

CREATE TABLE api_tokens (
  token_hash   TEXT PRIMARY KEY,           -- sha256 hex; plaintext shown once, never stored
  user_id      TEXT NOT NULL REFERENCES users(id),
  name         TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX idx_tokens_user ON api_tokens (user_id);

CREATE TABLE visits (
  id          TEXT PRIMARY KEY,            -- client-generated UUID: idempotency key
  user_id     TEXT NOT NULL REFERENCES users(id),
  captured_at INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded', 'ready')),
  alignment   TEXT NOT NULL DEFAULT '[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]',  -- column-major 4x4, visit -> canonical
  manifest    TEXT,                        -- pipeline manifest JSON, verbatim
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_visits_user ON visits (user_id, captured_at);

CREATE TABLE artifacts (
  visit_id   TEXT NOT NULL REFERENCES visits(id),
  sha256     TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('splat', 'pointcloud', 'crop', 'preview', 'manifest', 'detections')),
  detection_id TEXT,                       -- crop's source detection (links observations to crops)
  size       INTEGER NOT NULL CHECK (size > 0),
  r2_key     TEXT NOT NULL,                -- always <user_id>/<sha256>: cross-user reads impossible by construction
  label      TEXT NOT NULL DEFAULT '',     -- original file name, e.g. body.sog
  created_at INTEGER NOT NULL,
  PRIMARY KEY (visit_id, sha256)
);
CREATE INDEX idx_artifacts_kind ON artifacts (visit_id, kind);

CREATE TABLE moles (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  label       TEXT NOT NULL DEFAULT '',
  canonical_x REAL NOT NULL,               -- canonical body frame, height = 1
  canonical_y REAL NOT NULL,
  canonical_z REAL NOT NULL,
  source      TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'detected')),
  status      TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'proposed', 'dismissed')),
  created_at  INTEGER NOT NULL,
  retired_at  INTEGER                      -- e.g. removed by a dermatologist
);
CREATE INDEX idx_moles_user ON moles (user_id);

CREATE TABLE mole_observations (
  id          TEXT PRIMARY KEY,
  mole_id     TEXT NOT NULL REFERENCES moles(id),
  visit_id    TEXT NOT NULL REFERENCES visits(id),
  crop_sha256 TEXT,                        -- detection crop artifact, if any
  note        TEXT,
  diameter_mm REAL CHECK (diameter_mm IS NULL OR diameter_mm > 0),
  confidence  REAL,                        -- detector confidence; null for manual entries
  embedding   TEXT,                        -- JSON float array from the detector
  created_at  INTEGER NOT NULL,
  UNIQUE (mole_id, visit_id)
);
CREATE INDEX idx_observations_visit ON mole_observations (visit_id);
