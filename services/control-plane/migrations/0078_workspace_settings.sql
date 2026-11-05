-- Settings that belong to the workspace, not to one person, set by an admin.
--
-- One row per setting, its value JSON. The first is `visitor_home`: what a
-- signed-out visitor sees at the root (packages/contracts/src/visitor-home.ts).
-- No row is the contract's default, so a workspace that never saved reads
-- exactly as before this migration.
CREATE TABLE workspace_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by TEXT NOT NULL,           -- people.sub
  updated_at INTEGER NOT NULL
);
