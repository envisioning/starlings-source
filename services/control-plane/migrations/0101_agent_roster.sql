-- The agent roster moves from the `AGENT_ROSTER` var into D1 (2026-10-06).
--
-- Any agent runtime can now join a workspace's Team without a deploy: it
-- enrolls itself (`POST /api/agents/enroll`), a workspace admin approves it in
-- Admin › Agents, and the runtime collects its own two keys once
-- (`POST /api/agents/enroll/poll`). See docs/AGENTS_SURFACE.md §Enrollment and
-- docs/help/howto/connect-an-agent-as-a-team-member.md.
--
-- `agents` is the roster. One row per agent this workspace has ever had;
-- `removed_at` retires one without losing who it was. Both keys are per agent
-- and sealed with `GOOGLE_TOKEN_ENCRYPTION_KEY` (the Worker's at-rest key, as
-- for `support_line`): `webhook_secret` signs what Starlings sends the agent,
-- `inbound_key` verifies what the agent sends Starlings. `source` is
-- `enrolled`, or `config` for a row imported from the old var together with
-- its env secrets, once, by the Worker itself.
--
-- `agent_enrollments` is a request waiting for an admin. The runtime holds the
-- poll token; only its hash is stored. `user_code` is what the admin sees and
-- types or follows. On approval the keys are sealed here as well until the
-- runtime collects them; collecting clears them, so a poll token is good for
-- one delivery.
CREATE TABLE agents (
  email                    TEXT PRIMARY KEY,
  sub                      TEXT NOT NULL UNIQUE,
  name                     TEXT NOT NULL,
  endpoint                 TEXT,
  reset_endpoint           TEXT,
  writes_json              TEXT NOT NULL DEFAULT '[]',
  webhook_secret_iv        TEXT,
  webhook_secret_sealed    TEXT,
  inbound_key_iv           TEXT,
  inbound_key_sealed       TEXT,
  source                   TEXT NOT NULL DEFAULT 'enrolled',
  created_at               INTEGER NOT NULL,
  approved_by_email        TEXT,
  removed_at               INTEGER,
  removed_by_email         TEXT
);

CREATE TABLE agent_enrollments (
  id                       TEXT PRIMARY KEY,
  user_code                TEXT NOT NULL,
  poll_token_hash          TEXT NOT NULL UNIQUE,
  requested_name           TEXT NOT NULL,
  description              TEXT,
  runtime                  TEXT,
  endpoint                 TEXT NOT NULL,
  reset_endpoint           TEXT,
  status                   TEXT NOT NULL DEFAULT 'pending',
  created_at               INTEGER NOT NULL,
  expires_at               INTEGER NOT NULL,
  decided_at               INTEGER,
  decided_by_email         TEXT,
  agent_email              TEXT,
  webhook_secret_iv        TEXT,
  webhook_secret_sealed    TEXT,
  inbound_key_iv           TEXT,
  inbound_key_sealed       TEXT,
  collected_at             INTEGER
);

CREATE INDEX agent_enrollments_user_code ON agent_enrollments (user_code, status);
CREATE INDEX agent_enrollments_expires ON agent_enrollments (expires_at);
