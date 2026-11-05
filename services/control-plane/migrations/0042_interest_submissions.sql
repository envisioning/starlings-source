-- The interest form (/interest, services/control-plane/src/interest.ts).
--
-- Meet's own copy of every submission: the GitHub issue is a notification
-- and can fail without losing the answer. `body` is the validated input as
-- JSON, so a question added later needs no column; the three columns beside
-- it are what a list or a dedupe reads. `issue_filed_at` says whether the
-- issue went out. `mailed_at` is unused: the mail was dropped before the
-- first row, and the column stays because the migration had already run.
CREATE TABLE IF NOT EXISTS interest_submissions (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  email TEXT NOT NULL,
  company TEXT NOT NULL,
  body TEXT NOT NULL,
  issue_filed_at INTEGER,
  mailed_at INTEGER
);
CREATE INDEX IF NOT EXISTS interest_submissions_created ON interest_submissions (created_at DESC);
