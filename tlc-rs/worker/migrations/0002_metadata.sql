-- Agent-supplied hub metadata: what a spec models (per spec, latest wins)
-- and what changed (per generation).
ALTER TABLE specs ADD COLUMN description TEXT;
ALTER TABLE generations ADD COLUMN changelog TEXT;
