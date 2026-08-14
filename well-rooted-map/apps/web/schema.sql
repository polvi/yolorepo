-- Veggie-tagging game. Player totals are always derived from claims
-- (SUM(points)), never stored. Apply with:
--   bunx wrangler d1 execute well-rooted-map --remote --file schema.sql

CREATE TABLE IF NOT EXISTS veggies (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  label TEXT NOT NULL,
  spec INTEGER NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  first_player TEXT NOT NULL,
  last_player TEXT NOT NULL,
  confirmations INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_veggies_category ON veggies (category);

CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  player TEXT NOT NULL,
  veggie_id TEXT,
  action TEXT NOT NULL,
  label TEXT NOT NULL,
  points INTEGER NOT NULL,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_claims_player ON claims (player, created);

-- Optional display names for player keys (device UUIDs, Shortcuts Device
-- Names, or typed names). Keys without a row display as Player-xxxx.
CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);
