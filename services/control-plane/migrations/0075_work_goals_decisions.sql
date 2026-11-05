-- Goals, decisions, favorites and project repository links in D1, for
-- workspaces with WORK_STORE=d1 (docs/WORKSPACE_STORE.md slice 5, meet#776).
-- Empty on Envisioning, whose rows stay in Core until its own fold.
--
-- The columns follow the wire (`packages/contracts/src/goals-decisions.ts`,
-- `favorites.ts`, `crm.ts`), so Envisioning's later flip is a backfill and not
-- a remodel. People are person ids (migration 0072). Times are epoch
-- milliseconds; the wire carries ISO strings.

-- A goal sits on one project (crmGoalSchema).
CREATE TABLE goals (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects (id),
  title        TEXT NOT NULL,
  -- goalStatusSchema: open, met, dropped.
  status       TEXT NOT NULL DEFAULT 'open',
  -- A civil day, YYYY-MM-DD, or null.
  target_date  TEXT,
  owner        TEXT,
  created_by   TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX goals_project ON goals (project_id, status);
CREATE INDEX goals_status ON goals (status, updated_at);

-- A decision belongs to one subject of any kind (crmDecisionSchema). It is
-- written once and never changed.
CREATE TABLE decisions (
  id            TEXT PRIMARY KEY,
  subject_kind  TEXT NOT NULL,
  subject_id    TEXT NOT NULL,
  body          TEXT NOT NULL,
  -- decisionSourceSchema: message, meeting, manual, agent.
  source        TEXT NOT NULL DEFAULT 'manual',
  source_ref    TEXT,
  goal_id       TEXT REFERENCES goals (id),
  decided_by    TEXT,
  decided_at    INTEGER NOT NULL
);
CREATE INDEX decisions_subject ON decisions (subject_kind, subject_id, decided_at);
CREATE INDEX decisions_decided ON decisions (decided_at);

-- One member's favorites, as Core's member_favorites. The key is the wire's
-- (kind, target_ref): a favorite names a subject, a task, a document, a
-- person or a conversation, not only a subject.
CREATE TABLE favorites (
  person_id   TEXT NOT NULL,
  kind        TEXT NOT NULL,
  target_ref  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (person_id, kind, target_ref)
);

-- A GitHub repository linked to a project (crmGithubRepoSchema).
CREATE TABLE project_github_repos (
  project_id  TEXT NOT NULL REFERENCES projects (id),
  owner       TEXT NOT NULL,
  repo        TEXT NOT NULL,
  label       TEXT,
  milestone   TEXT,
  is_primary  INTEGER NOT NULL DEFAULT 0,
  linked_by   TEXT,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (project_id, owner, repo)
);
CREATE INDEX project_github_repos_repo ON project_github_repos (owner, repo);
