-- gpubnb marketplace: directory + verifier + reputation. Prompts and money
-- never touch this database; the only secrets here are hashed gb_ tokens.

CREATE TABLE users (
  id         TEXT PRIMARY KEY,             -- AuthGravity user id
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

CREATE TABLE hosts (
  user_id      TEXT PRIMARY KEY REFERENCES users(id),
  display_name TEXT NOT NULL DEFAULT '',
  contact      TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL
);

CREATE TABLE listings (
  id                  TEXT PRIMARY KEY,     -- random, public; never the host's user id
  host_id             TEXT NOT NULL REFERENCES users(id),
  slug                TEXT NOT NULL,        -- host-chosen, stable across re-registration
  endpoint_url        TEXT NOT NULL,
  gpu_model           TEXT NOT NULL,
  cpu_tee             TEXT NOT NULL,        -- 'snp' (TDX later)
  model_id            TEXT NOT NULL,
  model_digest        TEXT,                 -- hex32, from the attested doc
  ctx_len             INTEGER NOT NULL,
  price_in_piconero   INTEGER NOT NULL,     -- per 1,000,000 input tokens
  price_out_piconero  INTEGER NOT NULL,     -- per 1,000,000 output tokens
  region              TEXT NOT NULL DEFAULT '',
  simulated           INTEGER NOT NULL DEFAULT 0,
  trust_status        TEXT NOT NULL DEFAULT 'offline'
                      CHECK (trust_status IN ('verified', 'simulated', 'stale', 'failed', 'offline')),
  runner_version      TEXT,
  hpke_pub            TEXT,                 -- b64u32, from the attested doc
  sign_pub            TEXT,                 -- b64u32, from the attested doc
  attestation_doc     TEXT,                 -- JSON SignedBlob, latest received
  verdict             TEXT,                 -- JSON {status, checks}, latest
  verified_at         INTEGER,              -- last successful attestation
  last_heartbeat      INTEGER,
  challenge           TEXT,                 -- hex32 pending re-attest challenge
  challenge_issued_at INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  UNIQUE (host_id, slug)
);
CREATE INDEX idx_listings_host ON listings (host_id);
CREATE INDEX idx_listings_public ON listings (simulated, trust_status, last_heartbeat);
CREATE INDEX idx_listings_gpu ON listings (gpu_model);
CREATE INDEX idx_listings_model ON listings (model_id);

CREATE TABLE attestations (
  id          TEXT PRIMARY KEY,
  listing_id  TEXT NOT NULL REFERENCES listings(id),
  received_at INTEGER NOT NULL,
  status      TEXT NOT NULL,                -- verdict status: verified | simulated | failed
  checks      TEXT NOT NULL,                -- JSON [{id, ok, detail}]
  doc         TEXT NOT NULL                 -- JSON SignedBlob as received
);
CREATE INDEX idx_attestations_listing ON attestations (listing_id, received_at);

CREATE TABLE heartbeats (
  listing_id       TEXT NOT NULL REFERENCES listings(id),
  at               INTEGER NOT NULL,
  sessions_open    INTEGER NOT NULL,
  tokens_in_total  INTEGER NOT NULL,
  tokens_out_total INTEGER NOT NULL,
  uptime_s         INTEGER NOT NULL,
  PRIMARY KEY (listing_id, at)
);

CREATE TABLE disputes (
  id         TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES listings(id),
  offer      TEXT NOT NULL,                 -- JSON SignedBlob (runner-signed session offer)
  tx_proof   TEXT NOT NULL,                 -- renter-supplied tx key / proof text
  note       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_disputes_listing ON disputes (listing_id, created_at);

CREATE TABLE rate_cache (
  key        TEXT PRIMARY KEY,
  value      INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL
);
