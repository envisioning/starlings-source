-- One row per Envisioning human. Upserted on every owner session mint.
-- Metadata only: never transcript text, summaries, or guest emails.
-- See docs/ADMIN.md §6 and docs/PRIVACY.md.
CREATE TABLE people (
  sub                   TEXT PRIMARY KEY,
  email                 TEXT NOT NULL UNIQUE,
  name                  TEXT,
  first_seen_at         INTEGER NOT NULL,
  last_seen_at          INTEGER NOT NULL,
  room_slug             TEXT,
  calendar_connected    INTEGER NOT NULL DEFAULT 0,
  last_client           TEXT
);
