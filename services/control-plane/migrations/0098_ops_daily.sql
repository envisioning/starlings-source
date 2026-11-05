-- How many people use the workspace, one row per UTC day (docs/OPS_CONSOLE.md
-- §History). `people.last_seen_at` keeps only the latest time, so without
-- this table the operator dashboard has no trend, no retention and no
-- day-14 signal (meet#341).
--
-- Counts only, never a person. The cron writes today's row on every tick
-- (ops-history.ts), so the last write of a day holds that day. Kept two years.
CREATE TABLE ops_daily (
  day             TEXT PRIMARY KEY,   -- YYYY-MM-DD, UTC
  members         INTEGER NOT NULL,   -- humans, not revoked
  active_day      INTEGER NOT NULL,   -- members seen on this day
  active_week     INTEGER NOT NULL,   -- members seen on this day or the 6 before
  active_month    INTEGER NOT NULL,   -- members seen on this day or the 29 before
  active_web      INTEGER NOT NULL,   -- members seen on the web on this day
  active_mac      INTEGER NOT NULL,
  active_ios      INTEGER NOT NULL,
  devices_active  INTEGER NOT NULL,   -- native devices renewed in the 30 days to this day
  agents_active   INTEGER NOT NULL,   -- MCP grants with a call in the 30 days to this day
  updated_at      INTEGER NOT NULL
);
