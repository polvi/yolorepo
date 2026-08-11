-- Release tracking on error groups. resolved_in_release is captured at
-- resolve time; ingest regresses a resolved group only when the incoming
-- event's release differs (plain inequality, no semver ordering — lean
-- trade-off), or always when no release info is sent.

ALTER TABLE error_groups ADD COLUMN first_release TEXT;
ALTER TABLE error_groups ADD COLUMN last_release TEXT;
ALTER TABLE error_groups ADD COLUMN resolved_in_release TEXT;
