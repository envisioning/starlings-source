-- Reconstructible event metadata, not a second conversation or task store.
-- Threads remain the authority. The feed reads this index without per-subject RPCs.
CREATE TABLE subject_activity (
  thread_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  text TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, message_id)
);
CREATE INDEX subject_activity_at ON subject_activity(at DESC, thread_id, message_id);
-- Each existing thread is rebuilt once, bounded to its newest 100 event lines.
CREATE TABLE subject_activity_index (
  thread_id TEXT PRIMARY KEY,
  since INTEGER NOT NULL
);
