-- The work model's subjects in D1, for workspaces with WORK_STORE=d1
-- (docs/WORKSPACE_STORE.md slice 3, meet#776). Envisioning's subjects stay in
-- Core until its own fold; on Envisioning these tables stay empty.
--
-- Columns follow Core's tables where the wire (`packages/contracts/src/crm.ts`)
-- reads them, and ids are UUIDs, so Envisioning's later flip is a backfill and
-- not a remodel (CORE_FOLD_PLAN principle 1). Envisioning-only columns (license,
-- evid, characteristics, the project spec fields) are not here (principle 7).
-- Times are epoch milliseconds. `created_by` is a person id (migration 0072).

-- A client. A partner is an organization with is_partner = 1.
CREATE TABLE organizations (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  is_partner  INTEGER NOT NULL DEFAULT 0,
  industry    TEXT,
  url         TEXT,
  logo_url    TEXT,
  created_by  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX organizations_name ON organizations (name COLLATE NOCASE);

CREATE TABLE contacts (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT REFERENCES organizations (id),
  name             TEXT,
  email            TEXT,
  title            TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX contacts_organization ON contacts (organization_id);

CREATE TABLE leads (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT REFERENCES organizations (id),
  contact_id       TEXT REFERENCES contacts (id),
  title            TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'Conversations',
  start_date       TEXT,
  notes            TEXT,
  created_by       TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX leads_organization ON leads (organization_id);
CREATE INDEX leads_status ON leads (status, updated_at);

CREATE TABLE projects (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT REFERENCES organizations (id),
  lead_id          TEXT REFERENCES leads (id),
  title            TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'Active',
  description      TEXT,
  url              TEXT,
  start_date       TEXT,
  end_date         TEXT,
  -- The workspace's own work, as Core's projects.is_internal.
  internal         INTEGER NOT NULL DEFAULT 0,
  -- The one agent that works on this project (unique when set), as Core's projects.agent_email.
  agent_email      TEXT,
  created_by       TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX projects_organization ON projects (organization_id);
CREATE INDEX projects_status ON projects (status, updated_at);
CREATE UNIQUE INDEX projects_agent_email ON projects (agent_email) WHERE agent_email IS NOT NULL;

CREATE TABLE project_contacts (
  project_id  TEXT NOT NULL REFERENCES projects (id),
  contact_id  TEXT NOT NULL REFERENCES contacts (id),
  PRIMARY KEY (project_id, contact_id)
);
