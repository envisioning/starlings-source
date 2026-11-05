-- Per-thread accepted/answered timestamps for an agent hand-off.
--
-- `people.agent_busy_until` (migration 0007) says an agent is busy
-- *somewhere*, but collapses every thread it might be working into one row —
-- enough to draw a roster badge, not enough to act on. A run that dies
-- mid-turn just lets that badge quietly expire on AGENT_BUSY_TTL_MILLISECONDS
-- and nothing more; the person waiting on an answer never gets one and has
-- no way to know the runtime gave up without a word. See docs/AGENTS_SURFACE.md.
--
-- This table is the same fact, kept per (agent, thread) instead of collapsed,
-- so a watchdog can find the specific hand-off nobody answered and reset it —
-- see resetStuckAgents in agents.ts and the `scheduled` handler in index.ts.
--
-- Written the same way agent_busy_until is: accepted_at on a 2xx hand-off
-- (markWorking), replied_at on the agent's next message in that thread
-- (clearWorking). reset_at is stamped once the watchdog has already fired a
-- reset for this pending row, so a run that ignores the reset is not reset
-- again every five minutes.
CREATE TABLE agent_handoffs (
  agent_sub TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  accepted_at INTEGER NOT NULL,
  replied_at INTEGER,
  reset_at INTEGER,
  PRIMARY KEY (agent_sub, thread_id)
);

-- The watchdog's whole query: pending rows (replied_at IS NULL), oldest first.
CREATE INDEX idx_agent_handoffs_pending ON agent_handoffs (replied_at, accepted_at);
