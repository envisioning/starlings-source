-- Events proposed from mail forwarded to calendar@ (meet#234).
--
-- One row per event the extractor found, per owner, until Add writes it to
-- the calendar or Discard drops it; `expires_at` sweeps the rest. Only the
-- extracted fields live here: the mail's body is read once and not kept,
-- and no .eml is attached (docs/PRIVACY.md). `source_hash` is a digest of
-- the forwarded mail's headers and text, so forwarding it twice is a no-op
-- while the first rows are pending.
CREATE TABLE pending_calendar_events (
  id TEXT PRIMARY KEY,
  owner_sub TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  title TEXT NOT NULL,
  start TEXT NOT NULL,
  end TEXT NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0,
  time_zone TEXT,
  location TEXT,
  notes TEXT,
  attendees TEXT NOT NULL DEFAULT '[]',
  source_subject TEXT,
  source_from TEXT,
  confidence REAL NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX pending_calendar_events_owner ON pending_calendar_events(owner_sub, expires_at);
CREATE INDEX pending_calendar_events_source ON pending_calendar_events(owner_sub, source_hash);
