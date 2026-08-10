-- Ghost members: people added to a group by name only, so expenses can be
-- split with friends who haven't signed in yet. A ghost is a users row with
-- is_ghost = 1 and no session; claiming merges the ghost's ledger rows into
-- the claiming account atomically.
ALTER TABLE users ADD COLUMN is_ghost INTEGER NOT NULL DEFAULT 0;
