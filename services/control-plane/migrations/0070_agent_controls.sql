-- Agent controls (meet#711): pause a Claude, freeze a roster agent.
--
-- Both take effect on the agent's next call with no deploy, because every
-- door they close already reads D1 per request: `getMcpPrincipal` reads the
-- grant row, and the roster agent's three doors (the `/mcp` agent door, the
-- hand-off, the inbound message) read `agent_freezes`.
--
-- `mcp_grants.paused_at` is the member's own switch on one pairing. Null is
-- every row that exists today. Only the grant's owner writes it, so there is
-- no `paused_by`: it is always `mcp_grants.email`. Unlike `revoked_at`, a
-- paused grant keeps its refresh token, so Resume needs no new pairing.
--
-- `agent_freezes` is a table and not a column on `people`, because an agent's
-- `people` row is derived from `AGENT_ROSTER` and rewritten when the roster
-- changes (`ensureAgentPeople`); an admin's decision should not live in a row
-- the deploy owns. A row means frozen; unfreezing deletes it, and the history
-- is `admin_audit` (`agent.freeze`, `agent.unfreeze`). `agent_email` and
-- `frozen_by_email` are stored rather than joined, as `admin_audit` does.
ALTER TABLE mcp_grants ADD COLUMN paused_at INTEGER;

CREATE TABLE agent_freezes (
  agent_sub       TEXT PRIMARY KEY,
  agent_email     TEXT NOT NULL,
  frozen_at       INTEGER NOT NULL,
  frozen_by_email TEXT NOT NULL
);
