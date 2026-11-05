-- Events in the work model and their sign-ups (meet#966, docs/EVENTS.md
-- §An event on a `d1` workspace, docs/SESSIONS.md §0).
--
-- `events` is a plain work record. The session columns serve its sign-up
-- page on the workspace host: an event with `public_slug` and `room_slug`
-- has a page at /event/<public_slug>. `time_zone` names the zone the host
-- wrote the time in; the page shows the visitor's own.
--
-- `event_registrations` has the same columns as Core's CRM table, so
-- Envisioning's move to D1 copies each row as it is (fold rules F3 to F6, F9):
-- ids come from the caller when given, and tokens, calendar ids, sequences
-- and sent-at stamps are plain columns. A `luma` row has no token. No foreign
-- key to `events`: a Luma row can name an event that has no work record.
--
-- Times are milliseconds since the epoch, as in every work table; dates are
-- YYYY-MM-DD.
CREATE TABLE IF NOT EXISTS events (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  starts_on       TEXT NOT NULL,
  ends_on         TEXT,
  location        TEXT,
  url             TEXT,
  organization_id TEXT,
  notes           TEXT,
  public_slug     TEXT,
  starts_at       INTEGER,
  ends_at         INTEGER,
  time_zone       TEXT,
  room_slug       TEXT,
  cta_url         TEXT,
  cta_label       TEXT,
  follow_up_note  TEXT,
  created_by      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS events_public_slug ON events(public_slug) WHERE public_slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_room_starts ON events(room_slug, starts_at) WHERE room_slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_starts_on ON events(starts_on);

CREATE TABLE IF NOT EXISTS event_registrations (
  id                   TEXT PRIMARY KEY,
  event_id             TEXT NOT NULL,
  name                 TEXT NOT NULL DEFAULT '',
  email                TEXT,
  join_token           TEXT,
  source               TEXT NOT NULL DEFAULT 'meet' CHECK (source IN ('meet', 'luma')),
  status               TEXT NOT NULL DEFAULT 'registered' CHECK (status IN ('registered', 'cancelled')),
  ics_uid              TEXT,
  ics_sequence         INTEGER NOT NULL DEFAULT 0,
  confirmation_sent_at INTEGER,
  reminder_sent_at     INTEGER,
  follow_up_sent_at    INTEGER,
  created_at           INTEGER NOT NULL,
  CHECK (source <> 'meet' OR (email IS NOT NULL AND join_token IS NOT NULL AND ics_uid IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS event_registrations_token ON event_registrations(join_token) WHERE join_token IS NOT NULL;
-- The dedupe key: one Meet registration per address per event. The address is stored lower case.
CREATE UNIQUE INDEX IF NOT EXISTS event_registrations_email ON event_registrations(event_id, email) WHERE source = 'meet';
CREATE INDEX IF NOT EXISTS event_registrations_event ON event_registrations(event_id, status);
