-- Agent-reported wins: cases where model checking caught a real design or
-- architecture bug. A win belongs to a published spec and points at the
-- generation that captures the corrected design (generations are immutable,
-- so the reference stays valid as later generations land).
CREATE TABLE wins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  spec_id INTEGER NOT NULL REFERENCES specs(id),
  gen INTEGER NOT NULL,
  title TEXT NOT NULL,
  story TEXT NOT NULL,
  invariant TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX wins_spec ON wins(spec_id);
