-- OPDS catalog credentials: one machine-generated password per user.
-- The password is the whole credential (Basic-auth username is ignored),
-- so it must be UNIQUE — auth is a lookup by password. Stored plaintext
-- deliberately: it is a random, revocable token the UI re-displays so it
-- can be typed into an e-reader.
CREATE TABLE opds_credentials (
  user_id    TEXT PRIMARY KEY,
  password   TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
