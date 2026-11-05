-- The last run of a once-a-day cron job (meet#317). The five-minute cron
-- claims the day with a conditional upsert before it runs the job, so the job
-- runs once per UTC day even when two ticks overlap.
CREATE TABLE ops_runs (
  job TEXT PRIMARY KEY,
  last_day TEXT NOT NULL,
  last_at INTEGER NOT NULL
);
