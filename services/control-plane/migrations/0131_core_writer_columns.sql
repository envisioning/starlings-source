-- The Core columns of leads and projects that D1 did not keep (meet#1220,
-- the follow-up of meet#1209 for the other two subjects tables). Without them
-- the `subjects` copy drops Core's data and the verify still passes, because
-- it digests only the copied columns. Read from core-web DATABASE.md and its
-- write allowlist (`src/lib/meet-crm-writes-contract.ts`), 2026-10-21.
--
-- Core's own writers set three of them through `/api/internal/core-writes`,
-- which writes D1 after the flip: `leads.source` (the website contact form)
-- and `projects.last_viewed_at` (the public project page). Booleans are
-- INTEGER 0/1 and times epoch milliseconds (docs/CORE_FOLD_PLAN.md §Postgres
-- to D1). Not copied: the generated `search_vector`.

-- Leads: where the lead came from, and the qualification checklist.
ALTER TABLE leads ADD COLUMN source TEXT;
ALTER TABLE leads ADD COLUMN event_timeline INTEGER NOT NULL DEFAULT 0;
ALTER TABLE leads ADD COLUMN budget_availability INTEGER NOT NULL DEFAULT 0;
ALTER TABLE leads ADD COLUMN stakeholder_buy_in INTEGER NOT NULL DEFAULT 0;
ALTER TABLE leads ADD COLUMN previous_engagement INTEGER NOT NULL DEFAULT 0;
ALTER TABLE leads ADD COLUMN project_fit INTEGER NOT NULL DEFAULT 0;

-- Projects: the last credited view of the public page, the monthly revenue,
-- and the CMS event a project belongs to.
ALTER TABLE projects ADD COLUMN last_viewed_at INTEGER;
ALTER TABLE projects ADD COLUMN mrr INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN event_id TEXT;
