-- Purpose-built, content-free error aggregates (meet#414). Request ids are a
-- small UUID sample for log correlation; no user or room identity is retained.
CREATE TABLE operational_error_daily (
  day TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  source TEXT NOT NULL,
  platform TEXT NOT NULL,
  release TEXT NOT NULL,
  code TEXT NOT NULL,
  operation TEXT NOT NULL,
  error_class TEXT NOT NULL,
  http_status INTEGER,
  server_code TEXT,
  count INTEGER NOT NULL CHECK (count > 0),
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  max_retry_count INTEGER NOT NULL DEFAULT 0 CHECK (max_retry_count BETWEEN 0 AND 10),
  request_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(request_ids)),
  PRIMARY KEY (day, fingerprint)
);
CREATE INDEX operational_error_daily_day ON operational_error_daily (day DESC);
CREATE INDEX operational_error_daily_last_at ON operational_error_daily (last_at DESC);
