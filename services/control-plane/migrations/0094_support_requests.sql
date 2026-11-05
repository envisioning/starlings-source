-- Support requests (docs/SUPPORT.md). `last_origin` says where a thread's
-- last line came from: `guest` or `peer` for an outside line, null for a
-- member or an agent of this workspace. A guest thread whose last line is
-- from outside is unanswered, and INBOX shows it.
ALTER TABLE threads ADD COLUMN last_origin TEXT;

-- A card a member made from one outside line: the task, and the line it
-- came from. One card per task; a line can have more than one card.
CREATE TABLE support_requests (
  task_id       TEXT PRIMARY KEY,
  thread_id     TEXT NOT NULL,
  message_id    TEXT NOT NULL,
  subject_kind  TEXT NOT NULL,
  subject_id    TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX support_requests_thread_idx ON support_requests(thread_id);
