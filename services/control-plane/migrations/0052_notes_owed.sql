-- Meetings owed notes (meet#315). `/finalize` writes the row before it
-- enqueues the artifact job; the job sets `done_at` once the summary exists
-- or the meeting is discarded as too short. The five-minute cron re-enqueues
-- a row still open after 15 minutes, three times, then counts a `notes_owed`
-- failure (ops.ts), which mails a person. Meetings from before this table
-- have no row; the delivery ledger covers them.
CREATE TABLE notes_owed (
  room_slug TEXT NOT NULL,
  meeting_id TEXT NOT NULL,
  owed_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  done_at INTEGER,
  PRIMARY KEY (room_slug, meeting_id)
);
CREATE INDEX notes_owed_open ON notes_owed (owed_at) WHERE done_at IS NULL;
