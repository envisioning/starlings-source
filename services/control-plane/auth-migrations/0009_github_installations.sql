-- The GitHub token broker (docs/GITHUB_CONNECTOR.md "One App, one broker").
-- One row per workspace that connected GitHub: the installation the broker
-- mints tokens for when that workspace's GITHUB binding asks. An
-- installation serves one workspace; an uninstall or a suspension deletes
-- the row.
CREATE TABLE github_installations (
  workspace_origin TEXT PRIMARY KEY,
  installation_id INTEGER NOT NULL UNIQUE,
  account TEXT NOT NULL,
  connected_at INTEGER NOT NULL
);

-- A Connect GitHub attempt: ten minutes from begin to the callback, then
-- sixty seconds to redeem. It binds the workspace origin (the binding's
-- props) and the hash of the browser secret in the workspace's cookie. The
-- auth host's own cookie binds the setup step to the callback step.
CREATE TABLE github_attempts (
  ticket TEXT PRIMARY KEY,
  workspace_origin TEXT NOT NULL,
  browser_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  installation_id INTEGER,
  cookie_hash TEXT,
  account TEXT,
  redeem_hash TEXT
);
CREATE INDEX github_attempts_expires ON github_attempts (expires_at);
