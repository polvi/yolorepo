-- Settle-up gate: transfers stay hidden while a group is still collecting
-- expenses; any member can flip the group to settling (and back).
ALTER TABLE groups ADD COLUMN settling INTEGER NOT NULL DEFAULT 0;
