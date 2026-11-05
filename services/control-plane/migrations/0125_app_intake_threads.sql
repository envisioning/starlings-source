-- The app channel door (envisioning/starlings#1176, docs/SUPPORT.md): one
-- private intake thread per app user, sent in by the workspace's own
-- backend. The row links the thread to the reporter, so a member's reply in
-- the thread goes back to that user, and only threads with a row send one.
CREATE TABLE app_intake_threads (
  thread_id     TEXT PRIMARY KEY,
  reporter_ref  TEXT NOT NULL UNIQUE,
  handle        TEXT,
  name          TEXT,
  created_at    INTEGER NOT NULL
);
