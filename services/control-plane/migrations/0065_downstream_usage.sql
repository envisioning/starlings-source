-- Approximate LiveKit downstream usage from client-side RTP receive counters.
-- One cumulative row per client session and UTC month; never stores identity or
-- media content. Admin reads the current month's totals.
CREATE TABLE downstream_usage_reports (
  reporter_id TEXT NOT NULL,
  month_start INTEGER NOT NULL,
  received_bytes INTEGER NOT NULL CHECK (received_bytes >= 0),
  reported_at INTEGER NOT NULL,
  PRIMARY KEY (reporter_id, month_start)
) WITHOUT ROWID;

CREATE INDEX idx_downstream_usage_month ON downstream_usage_reports (month_start, reported_at);
