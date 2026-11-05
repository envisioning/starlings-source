-- Operational alerts (meet#318). Cloudflare samples logs per request, not per
-- level, so an error line is kept one time in a hundred. The Worker counts
-- its own failures here instead, and the cron mails a person from these rows.
--
-- One row per failure kind and UTC day. `last_detail` is an id or a short
-- reason, at most 200 characters, never personal data.
CREATE TABLE ops_failures (
  kind TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  last_at INTEGER NOT NULL,
  last_detail TEXT,
  PRIMARY KEY (kind, day)
);

-- When the last alert mail for a kind went out. At most one mail per kind
-- per six hours.
CREATE TABLE ops_alerts (
  kind TEXT PRIMARY KEY,
  sent_at INTEGER NOT NULL
);

-- Queue messages that failed every retry. The dead-letter consumer writes
-- each body here and acks it, so a dead job is kept until an admin replays
-- it, not for the queue's four-day retention.
CREATE TABLE dead_jobs (
  id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX dead_jobs_received ON dead_jobs (received_at);
