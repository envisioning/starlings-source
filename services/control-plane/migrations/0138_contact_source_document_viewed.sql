-- destructive: contact_source_events is rebuilt to widen its CHECK, and its rows are copied.
-- Core's contact_source_events holds `document_viewed` rows, and the group move
-- copies them (meet#757). SQLite cannot alter a CHECK, so the table is rebuilt.
-- It has no rows yet on Envisioning: its group has not moved. A D1 workspace
-- keeps its rows through the copy below.
CREATE TABLE contact_source_events_new (
  id                  TEXT PRIMARY KEY,
  contact_id          TEXT NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  event_type          TEXT NOT NULL CHECK (event_type IN (
                        'created', 'imported', 'subscribed', 'meeting_booked',
                        'form_submitted', 'event_registered', 'inbound_contact',
                        'document_viewed')),
  source_key          TEXT NOT NULL REFERENCES contact_source_definitions (key) ON UPDATE CASCADE,
  occurred_at         INTEGER NOT NULL,
  external_id         TEXT,
  import_batch_id     TEXT,
  source_record_type  TEXT,
  source_record_id    TEXT,
  -- JSON object, keys sorted; null when empty.
  metadata            TEXT,
  created_by          TEXT,
  dedupe_key          TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  UNIQUE (contact_id, dedupe_key)
);
INSERT INTO contact_source_events_new SELECT id, contact_id, event_type, source_key, occurred_at, external_id, import_batch_id, source_record_type, source_record_id, metadata, created_by, dedupe_key, created_at FROM contact_source_events;
DROP TABLE contact_source_events;
ALTER TABLE contact_source_events_new RENAME TO contact_source_events;
CREATE INDEX contact_source_events_contact ON contact_source_events (contact_id, occurred_at, id);
CREATE INDEX contact_source_events_source ON contact_source_events (source_key, occurred_at DESC);
