-- When a note last finished ingesting, as opposed to when the index last saw
-- it (docs/GRANOLA_BRIDGE.md §The index). `seen_at` is stamped by the page
-- walk too, and a walk runs far ahead of the notes it enqueues — counting it
-- as progress would show a history import finished while most of it was still
-- in the queue. This column is written only after Core has taken the note.
ALTER TABLE granola_notes ADD COLUMN ingested_at INTEGER;
