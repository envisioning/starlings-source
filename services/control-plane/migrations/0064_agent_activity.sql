-- Meet-observed agent activity for the Admin dashboard. This stores lifecycle
-- metadata only: never message text, prompts, tool arguments, or credentials.
CREATE TABLE agent_activity_events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT,
  agent_sub TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'handoff', 'accepted', 'rejected', 'delivery_failed', 'reply', 'watchdog_reset', 'watchdog_reset_failed'
  )),
  occurred_at INTEGER NOT NULL,
  duration_ms INTEGER,
  response_status INTEGER
);

CREATE INDEX idx_agent_activity_time ON agent_activity_events (occurred_at DESC);
CREATE INDEX idx_agent_activity_agent_time ON agent_activity_events (agent_sub, occurred_at DESC);
CREATE INDEX idx_agent_activity_run ON agent_activity_events (run_id, occurred_at);

-- Preserve the triggering message for the watchdog's unanswered-run record.
ALTER TABLE agent_handoffs ADD COLUMN request_message_id TEXT;
