-- What each destination still owes a meeting (meet#187).
--
-- One row per meeting and destination: the room's revision when delivery
-- was last asked for, and the revision the destination last confirmed. A
-- row is due while requested > delivered. Rows are written before any
-- dispatch, so a queue, Core or Docs outage leaves recoverable state, and
-- a sweep re-enqueues what the queue lost. Never holds transcript text:
-- `last_error` is a message, the material stays in the room.
CREATE TABLE meeting_deliveries (
  meeting_id TEXT NOT NULL,
  room_slug TEXT NOT NULL,
  destination TEXT NOT NULL,
  requested_revision INTEGER NOT NULL,
  delivered_revision INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  requested_at INTEGER NOT NULL,
  delivered_at INTEGER,
  updated_at INTEGER NOT NULL,
  -- One delivery at a time per meeting: two at once could file two documents.
  leased_until INTEGER,
  PRIMARY KEY (meeting_id, destination)
);
CREATE INDEX meeting_deliveries_due ON meeting_deliveries (updated_at) WHERE requested_revision > delivered_revision;
