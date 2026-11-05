-- MetricKit reports from signed-in devices (meet#320): a crash, a hang, or a
-- daily metric payload. Apple's JSON as delivered, capped at 64 KB. Call
-- stacks and device facts, never meeting content. The cron deletes rows
-- older than 30 days.
CREATE TABLE diagnostics (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  sub TEXT NOT NULL,
  email TEXT NOT NULL,
  platform TEXT NOT NULL,
  app_version TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX diagnostics_ts ON diagnostics (ts DESC);
