-- KOReader progress-sync (kosync protocol) support.

-- Credentials for the kosync endpoint. KOReader authenticates with
-- x-auth-user / x-auth-key headers where the key is md5(password) computed on
-- the device, so auth is a lookup by username. Password stored plaintext
-- deliberately (same reasoning as opds_credentials): a random, revocable
-- token the UI re-displays so it can be typed into a device.
CREATE TABLE kosync_credentials (
  user_id    TEXT PRIMARY KEY,
  username   TEXT NOT NULL UNIQUE,
  password   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Cache of KOReader "partial MD5" digests, the kosync document identifier.
-- A pure function of the blob bytes, so keyed by sha256 alone and shared
-- across users. Filled eagerly on blob upload and backfilled lazily from R2
-- ranged reads when a kosync lookup misses.
CREATE TABLE kosync_digests (
  sha256 TEXT PRIMARY KEY,
  digest TEXT NOT NULL
);
CREATE INDEX idx_kosync_digests_digest ON kosync_digests (digest);

-- Progress pushed by KOReader for books that match no happybook document
-- (sideloaded files). Kept so KOReader-to-KOReader sync through happybook
-- still works; if the book is later imported, the digest starts matching and
-- the records-stream path takes over.
CREATE TABLE kosync_orphan_progress (
  user_id    TEXT NOT NULL,
  document   TEXT NOT NULL,
  progress   TEXT NOT NULL,
  percentage REAL NOT NULL,
  device     TEXT NOT NULL,
  device_id  TEXT,
  timestamp  INTEGER NOT NULL,
  PRIMARY KEY (user_id, document)
);
