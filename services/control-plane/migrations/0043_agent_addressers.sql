-- Who has addressed which agent (docs/AGENTS_SURFACE.md §Authority,
-- docs/MCP.md §The agent principal).
--
-- An agent reads Meet only as somebody who actually spoke to it. Until now
-- "spoke to it" was a shared `thread_members` row, which a DM has and a
-- channel never does — so an @mention in Everyone or a project channel
-- woke nothing, and could not have let the agent read for the person even
-- if it had. This table is the durable fact itself, written on every
-- accepted hand-off whatever the thread kind: one row per (agent, person),
-- the time of the latest hand-off. Nothing else is stored; the transcript
-- is the record of what was said.
CREATE TABLE agent_addressers (
  agent_sub  TEXT NOT NULL,
  actor_sub  TEXT NOT NULL,
  last_at    INTEGER NOT NULL,
  PRIMARY KEY (agent_sub, actor_sub)
);
