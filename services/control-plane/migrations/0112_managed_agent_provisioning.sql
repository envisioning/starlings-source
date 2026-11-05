-- Durable installer progress and resource ids. Keys remain sealed in agents.
CREATE TABLE managed_agent_provisioning (
  installation_id TEXT PRIMARY KEY REFERENCES built_in_agent_installations(id),
  accountable_email TEXT NOT NULL,
  accountable_sub TEXT,
  stage TEXT NOT NULL CHECK(stage IN ('reserved', 'runtime', 'verifying', 'awaiting_admin', 'ready', 'failed', 'removed')),
  project_id TEXT UNIQUE,
  runtime_origin TEXT UNIQUE,
  runtime_version TEXT,
  verified_at INTEGER,
  failed_step TEXT,
  probe_run_id TEXT,
  probe_runtime_run_id TEXT,
  probe_deadline INTEGER,
  probe_receipt TEXT,
  updated_at INTEGER NOT NULL,
  erase_requested_at INTEGER,
  erased_at INTEGER
);
