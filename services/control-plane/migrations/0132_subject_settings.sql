-- The settings tables that move with the subjects group (meet#1228,
-- docs/CORE_FOLD_PLAN.md §Before each group moves). Decided by MZ,
-- 2026-10-22: they are D1 config that an admin edits in Starlings Admin,
-- because contacts and leads need them.
--
-- Each table keeps Core's name, so the moved-table guard in core-web refuses
-- a write to it after the flip with the same list. Times are epoch ms and
-- booleans 0/1 (§Postgres to D1). The group copy writes Core's rows over the
-- rows seeded here.

-- The vocabulary of the characteristics flags on a lead and on a contact
-- (`leads.characteristics`, `contacts.characteristics`, JSON keyed by name).
CREATE TABLE lead_characteristics_config (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL
);

CREATE TABLE contact_characteristics_config (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL
);

-- Where a contact came from: the vocabulary, then one row per fact.
-- A system source keeps its key and category; an admin edits its label and
-- its flags only.
CREATE TABLE contact_source_definitions (
  key                TEXT PRIMARY KEY CHECK (length(key) BETWEEN 2 AND 80 AND key = lower(key)),
  label              TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 100),
  category           TEXT NOT NULL CHECK (category IN ('manual', 'website', 'import', 'integration', 'inbound', 'legacy')),
  description        TEXT,
  is_active          INTEGER NOT NULL DEFAULT 1,
  manual_selectable  INTEGER NOT NULL DEFAULT 0,
  import_selectable  INTEGER NOT NULL DEFAULT 0,
  is_system          INTEGER NOT NULL DEFAULT 0,
  sort_order         INTEGER NOT NULL DEFAULT 100,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

-- The sources the Worker writes itself. Core holds the same rows; the copy
-- writes Core's values over these.
INSERT INTO contact_source_definitions
  (key, label, category, description, is_active, manual_selectable, import_selectable, is_system, sort_order, created_at, updated_at)
VALUES
  ('crm_manual', 'Added manually', 'manual', 'Contact created directly in the CRM.', 1, 1, 0, 1, 10, 0, 0),
  ('agent_api', 'Agent/API', 'integration', 'Contact created through the authenticated Agent API.', 1, 0, 0, 1, 20, 0, 0),
  ('website_contact', 'Website contact form', 'website', 'Contact form submitted on the website.', 1, 0, 0, 1, 70, 0, 0);

-- One fact about how a contact entered or engaged with the CRM. The pair
-- (contact, dedupe key) is the fact's identity: recording it twice is one row.
CREATE TABLE contact_source_events (
  id                  TEXT PRIMARY KEY,
  contact_id          TEXT NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  event_type          TEXT NOT NULL CHECK (event_type IN (
                        'created', 'imported', 'subscribed', 'meeting_booked',
                        'form_submitted', 'event_registered', 'inbound_contact')),
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
CREATE INDEX contact_source_events_contact ON contact_source_events (contact_id, occurred_at, id);
CREATE INDEX contact_source_events_source ON contact_source_events (source_key, occurred_at DESC);

-- The currencies an offer can be priced in, and the rates between them.
-- Offers stay in Core until the commercial group moves; then they read these.
CREATE TABLE currency_settings (
  id                    TEXT PRIMARY KEY,
  currency_code         TEXT NOT NULL,
  symbol                TEXT NOT NULL,
  is_enabled            INTEGER NOT NULL DEFAULT 1,
  surcharge_percentage  REAL NOT NULL DEFAULT 5,
  created_at            INTEGER NOT NULL
);

CREATE TABLE exchange_rates_cache (
  id               TEXT PRIMARY KEY,
  base_currency    TEXT NOT NULL DEFAULT 'EUR',
  target_currency  TEXT NOT NULL,
  rate             REAL NOT NULL,
  last_updated     INTEGER NOT NULL,
  created_at       INTEGER NOT NULL
);
