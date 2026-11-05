-- Tasks and milestones in D1, for workspaces with WORK_STORE=d1
-- (docs/WORKSPACE_STORE.md slice 4, meet#776). Empty on Envisioning, whose
-- tasks stay in Core until its own fold.
--
-- A task sits on exactly one place: a project, a lead, a partner (its
-- organization) or a meeting, as `SUBJECT_KIND_CAPABILITIES` says. People are
-- person ids (migration 0072). Times are epoch milliseconds; the wire carries
-- ISO strings.

CREATE TABLE milestones (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects (id),
  title       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  due_at      INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX milestones_project ON milestones (project_id);
CREATE INDEX milestones_due ON milestones (due_at) WHERE due_at IS NOT NULL;

CREATE TABLE tasks (
  id                 TEXT PRIMARY KEY,
  title              TEXT NOT NULL,
  notes              TEXT,
  -- crmTaskStatusSchema: pending, in_progress, review, blocked, completed,
  -- cancelled, proposed, declined.
  status             TEXT NOT NULL DEFAULT 'pending',
  -- crmResponsiblePartySchema: team, client, unassigned.
  responsible_party  TEXT NOT NULL DEFAULT 'team',
  priority           TEXT,
  due_at             INTEGER,
  assignee_id        TEXT,
  project_id         TEXT REFERENCES projects (id),
  lead_id            TEXT REFERENCES leads (id),
  organization_id    TEXT REFERENCES organizations (id),
  meeting_id         TEXT,
  milestone_id       TEXT REFERENCES milestones (id),
  goal_id            TEXT,
  created_by         TEXT,
  updated_by         TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  -- When it last became completed or cancelled; the board's finished columns read it.
  finished_at        INTEGER
);
CREATE INDEX tasks_project ON tasks (project_id, status);
CREATE INDEX tasks_lead ON tasks (lead_id, status);
CREATE INDEX tasks_organization ON tasks (organization_id, status);
CREATE INDEX tasks_meeting ON tasks (meeting_id, status);
CREATE INDEX tasks_assignee ON tasks (assignee_id, status);
CREATE INDEX tasks_status ON tasks (status, updated_at);
CREATE INDEX tasks_due ON tasks (due_at) WHERE due_at IS NOT NULL;
