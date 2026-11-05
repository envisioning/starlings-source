-- Meet's own index of the Granola notes it has seen (docs/GRANOLA_BRIDGE.md
-- §The index). Granola answers thirty notes a page at five requests a second,
-- so a list of seven hundred took twenty-three reads on every open. Now every
-- read of Granola — the walk, the backfill, the webhook's note — writes the
-- row here, and the list opens from this table. A refresh reads only the
-- pages newer than the newest row. No note content: title, when, who, link.
CREATE TABLE granola_notes (
  note_id      TEXT PRIMARY KEY,
  title        TEXT,
  started_at   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  owner_email  TEXT,
  attendees    TEXT NOT NULL,
  web_url      TEXT,
  seen_at      INTEGER NOT NULL
);
CREATE INDEX granola_notes_started ON granola_notes (started_at DESC);
