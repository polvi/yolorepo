-- tabby: group expense ledger settled in Monero.
-- All normalized amounts are integer µTAB (100,000 per TAB; 1 TAB = 10 USD).
-- Balances are always derived from expenses + payments, never stored.

CREATE TABLE users (
  id           TEXT PRIMARY KEY,          -- AuthGravity UUID (procauth)
  display_name TEXT,
  xmr_address  TEXT,
  created_at   INTEGER NOT NULL
);

CREATE TABLE groups (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  invite_token TEXT NOT NULL UNIQUE,
  created_by   TEXT NOT NULL REFERENCES users(id),
  created_at   INTEGER NOT NULL
);

CREATE TABLE group_members (
  group_id  TEXT NOT NULL REFERENCES groups(id),
  user_id   TEXT NOT NULL REFERENCES users(id),
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX idx_members_user ON group_members (user_id);

CREATE TABLE expenses (
  id                 TEXT PRIMARY KEY,    -- client-generated UUID: idempotency key
  group_id           TEXT NOT NULL REFERENCES groups(id),
  description        TEXT NOT NULL,
  paid_by            TEXT NOT NULL REFERENCES users(id),
  currency           TEXT NOT NULL CHECK (currency IN ('USD', 'CAD', 'TAB')),
  amount_minor       INTEGER NOT NULL CHECK (amount_minor > 0),
  tab_micro_per_unit INTEGER NOT NULL CHECK (tab_micro_per_unit > 0),
  amount_tab_micro   INTEGER NOT NULL CHECK (amount_tab_micro > 0),
  created_by         TEXT NOT NULL,
  created_at         INTEGER NOT NULL,
  deleted_at         INTEGER              -- soft delete; edit = delete + re-add
);
CREATE INDEX idx_expenses_group ON expenses (group_id, created_at);

CREATE TABLE expense_shares (
  expense_id      TEXT NOT NULL REFERENCES expenses(id),
  user_id         TEXT NOT NULL REFERENCES users(id),
  share_tab_micro INTEGER NOT NULL CHECK (share_tab_micro >= 0),
  PRIMARY KEY (expense_id, user_id)
);

CREATE TABLE payments (
  id                  TEXT PRIMARY KEY,   -- client-generated UUID: idempotency key
  group_id            TEXT NOT NULL REFERENCES groups(id),
  from_user           TEXT NOT NULL REFERENCES users(id),
  to_user             TEXT NOT NULL REFERENCES users(id),
  amount_tab_micro    INTEGER NOT NULL CHECK (amount_tab_micro > 0),
  xmr_amount_piconero INTEGER NOT NULL,
  xmr_rate_tab_micro  INTEGER NOT NULL,   -- µTAB per XMR at view time
  created_at          INTEGER NOT NULL
);
CREATE INDEX idx_payments_group ON payments (group_id, created_at);

CREATE TABLE rate_cache (
  key        TEXT PRIMARY KEY,            -- 'xmr_usd' | 'cad_usd'
  value      INTEGER NOT NULL,            -- micro-units of the target per source unit
  fetched_at INTEGER NOT NULL
);
