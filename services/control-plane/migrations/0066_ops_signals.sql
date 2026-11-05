-- Failures that reach somebody (meet#601). Three signals the alert mail
-- (ops_failures, 0051) could not see before.
--
-- `ops_inbound`: one row per caller of a signed inbound route. Two facts,
-- both for the hourly cron and the refusal rate limit: when the route last
-- accepted a call from this caller (Core's events go quiet without a word if
-- a secret drifts), and when it last counted a refusal (one `ops_failures`
-- row per caller per ten minutes, so a flood of bad signatures cannot fill
-- the table). `first_seen_at` is the baseline for silence before the first
-- accepted call after this migration.
CREATE TABLE ops_inbound (
  caller TEXT PRIMARY KEY,
  first_seen_at INTEGER NOT NULL,
  last_accepted_at INTEGER,
  last_refused_at INTEGER
);

-- A 5xx counted against the route *pattern* (`/api/threads/:id/messages`),
-- never the raw path, per UTC hour. The cron reads the last two hours and
-- counts `route_5xx` in `ops_failures` when one pattern passes the threshold;
-- rows older than two days are deleted by the same tick.
CREATE TABLE ops_route_5xx_hourly (
  hour INTEGER NOT NULL,
  route TEXT NOT NULL,
  count INTEGER NOT NULL CHECK (count > 0),
  PRIMARY KEY (hour, route)
);

-- The daily aggregate says which route too. Null for every event a client
-- uploads and for rows before this migration.
ALTER TABLE operational_error_daily ADD COLUMN route TEXT;
