-- A workspace's public forms (docs/FORMS.md §Step 2, meet#978,
-- services/control-plane/src/forms.ts). One row per submission of any form
-- in the registry (`packages/contracts/src/forms.ts`). `body` is the
-- validated answers as JSON, ids not labels; labels resolve on read. `email`,
-- `name` and `organization` are what a list or a dedupe reads. `lead_id` and
-- `contact_id` are what the submission filed, or null. `interest` keeps its
-- own table on hq until it moves into the registry.
CREATE TABLE IF NOT EXISTS form_submissions (
  id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  organization TEXT NOT NULL,
  body TEXT NOT NULL,
  lead_id TEXT,
  contact_id TEXT
);
CREATE INDEX IF NOT EXISTS form_submissions_form_created ON form_submissions (form_id, created_at DESC);
CREATE INDEX IF NOT EXISTS form_submissions_created ON form_submissions (created_at DESC);
CREATE INDEX IF NOT EXISTS form_submissions_lead ON form_submissions (lead_id);
