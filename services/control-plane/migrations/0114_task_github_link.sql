-- A D1 task filed on GitHub keeps its issue (meet#1109).
--
-- File on GitHub (Mac, iPhone, web) and MCP `create_issue` with a task send
-- `task_id`. Core stored the link on its task; a D1 workspace had nowhere to
-- put it, so the task and its issue stayed two cards. The issue the task was
-- filed as: while both exist they are one card, and the task's status sets
-- its column (packages/contracts/src/work-items.ts, `githubRef`).
ALTER TABLE tasks ADD COLUMN github_owner TEXT;
ALTER TABLE tasks ADD COLUMN github_repo TEXT;
ALTER TABLE tasks ADD COLUMN github_issue_number INTEGER;
