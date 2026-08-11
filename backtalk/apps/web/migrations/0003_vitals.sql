-- Web Vitals daily rollups. Raw samples are never stored: one row per
-- project/day/path/metric, incremented via UPSERT. good/needs/poor use the
-- web.dev thresholds as a cheap p75 substitute; avg = sum_value / count.

CREATE TABLE vitals_daily (
  project_id TEXT NOT NULL,
  day        TEXT NOT NULL, -- 'YYYY-MM-DD' UTC
  path       TEXT NOT NULL,
  metric     TEXT NOT NULL CHECK (metric IN ('LCP','INP','CLS')),
  count      INTEGER NOT NULL DEFAULT 0,
  sum_value  REAL NOT NULL DEFAULT 0,
  good       INTEGER NOT NULL DEFAULT 0,
  needs      INTEGER NOT NULL DEFAULT 0,
  poor       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, day, path, metric)
);
