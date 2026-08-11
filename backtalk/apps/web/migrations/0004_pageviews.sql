-- Pageview counters: privacy-light (no cookies, no IPs, no visitor ids),
-- one row per project/day/path incremented via UPSERT.

CREATE TABLE pageviews_daily (
  project_id TEXT NOT NULL,
  day        TEXT NOT NULL, -- 'YYYY-MM-DD' UTC
  path       TEXT NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, day, path)
);
