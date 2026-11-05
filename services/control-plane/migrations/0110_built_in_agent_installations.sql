-- Empty until the managed onboarding installer (#1084) provisions a roster agent.
-- Identity and keys remain in agents/people; this table binds a lifecycle to a role.
CREATE TABLE built_in_agent_installations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  agent_sub TEXT NOT NULL REFERENCES agents(sub),
  role TEXT NOT NULL CHECK (role = 'meeting_follow_through'),
  state TEXT NOT NULL CHECK (state IN ('provisioning', 'ready', 'paused', 'frozen', 'removed')),
  created_at INTEGER NOT NULL,
  removed_at INTEGER
);
CREATE UNIQUE INDEX built_in_agent_active_role
  ON built_in_agent_installations(workspace_id, role) WHERE removed_at IS NULL;
