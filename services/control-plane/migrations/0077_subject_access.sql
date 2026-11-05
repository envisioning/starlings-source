-- Who reaches which subject (docs/ACCESS.md, slice 1).
--
-- Overrides only, as `subject_state` is. A subject with no
-- `subject_visibility` row is `workspace`: every member reads and writes it,
-- exactly as before this migration. A row says `restricted`, and then only
-- admins and the subject's grants reach it. Setting a subject back to
-- `workspace` deletes its row.
--
-- Keyed by (kind, subject_id) like `subject_state`: Core's id on a Core
-- workspace, the D1 row id on a d1 workspace. Nothing here joins Core.
CREATE TABLE subject_visibility (
  kind TEXT NOT NULL,                 -- project | lead | partner | event
  subject_id TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility = 'restricted'),
  updated_by TEXT NOT NULL,           -- people.sub
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (kind, subject_id)
);

-- One grant per principal per subject while live. A revoke stamps
-- `revoked_at`, so the trail of who could reach a subject survives.
-- `principal_id` is `people.sub` for a member. Agent, guest and peer
-- workspace grants (slices 2, 4, 5) use the same table.
CREATE TABLE subject_grants (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  principal_kind TEXT NOT NULL CHECK (principal_kind IN ('member', 'agent', 'guest', 'peer_workspace')),
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('read', 'write', 'manage')),
  granted_by TEXT NOT NULL,           -- people.sub
  granted_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE UNIQUE INDEX subject_grants_live
  ON subject_grants (kind, subject_id, principal_kind, principal_id)
  WHERE revoked_at IS NULL;
CREATE INDEX subject_grants_principal
  ON subject_grants (principal_kind, principal_id)
  WHERE revoked_at IS NULL;
