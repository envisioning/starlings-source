-- destructive: work_group_moves is rebuilt to widen its CHECK, and its rows are copied; only an admin's move reads that table, and no move runs during a deploy.
-- The commercial group's tables (meet#1229, docs/CORE_FOLD_PLAN.md §The group
-- move). Decided by MZ, 2026-11-04: commercial moves from Core to D1, after the
-- four-group window. Nothing reads or writes these until WORK_STORE_COMMERCIAL
-- is d1; the group copy fills them.
--
-- Every table and column keeps Core's name, so the moved-table guard in
-- core-web names the same tables and Core reads one row shape from either
-- store (`packages/contracts/src/core-commercial.ts`). Times are epoch ms,
-- booleans 0/1, `numeric` is REAL, `jsonb` is JSON text with sorted keys
-- (§Postgres to D1). A `date` stays YYYY-MM-DD text: a day, with no time zone.
-- A column is NOT NULL only where Core's is. Core's generated `search_vector`
-- is not kept. `currency_settings` and `exchange_rates_cache` exist since 0132.
--
-- Foreign keys follow Core's actions. `offers.creator_token_id` has no foreign
-- key: `offer_creator_tokens` stays out of the group.

CREATE TABLE corporate_entities (
  id               TEXT PRIMARY KEY,
  created_at       INTEGER,
  name             TEXT NOT NULL,
  legal_name       TEXT,
  address          TEXT,
  postcode         TEXT,
  city             TEXT,
  country          TEXT,
  vat_id           TEXT,
  tax_id           TEXT,
  logo_url         TEXT,
  is_default       INTEGER DEFAULT 0,
  billing_iban     TEXT,
  signatory_name   TEXT,
  signatory_title  TEXT
);

CREATE TABLE settings_payment_terms (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL,
  is_active    INTEGER NOT NULL DEFAULT 1,
  is_default   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE settings_delivery_conditions (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL,
  is_active    INTEGER NOT NULL DEFAULT 1,
  is_default   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE settings_offer_links (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  url         TEXT NOT NULL,
  icon        TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  is_default  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE services (
  id                          TEXT PRIMARY KEY,
  created_at                  INTEGER,
  name                        TEXT NOT NULL,
  description                 TEXT NOT NULL,
  price                       REAL NOT NULL,
  is_recurring                INTEGER DEFAULT 0,
  recurring_interval          TEXT,
  summary                     TEXT NOT NULL,
  url                         TEXT,
  icon                        TEXT,
  group_type                  TEXT DEFAULT 'Optional',
  is_public                   INTEGER NOT NULL DEFAULT 0,
  allow_multiple              INTEGER NOT NULL DEFAULT 0,
  is_default                  INTEGER NOT NULL DEFAULT 0,
  category                    TEXT,
  allow_description_override  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX services_public ON services (is_public, group_type, name);

CREATE TABLE offers (
  id                          TEXT PRIMARY KEY,
  created_at                  INTEGER,
  organization_id             TEXT REFERENCES organizations (id) ON DELETE SET NULL,
  corporate_entity_id         TEXT REFERENCES corporate_entities (id) ON DELETE SET NULL,
  valid_until                 INTEGER,
  status                      TEXT NOT NULL,
  total_amount                REAL NOT NULL,
  updated_at                  INTEGER,
  currency                    TEXT DEFAULT 'EUR',
  global_discount_percentage  REAL,
  title                       TEXT,
  lead_id                     TEXT REFERENCES leads (id) ON DELETE SET NULL,
  is_self_submitted           INTEGER DEFAULT 0,
  exchange_rate               REAL DEFAULT 1,
  payment_term_id             TEXT REFERENCES settings_payment_terms (id) ON DELETE SET NULL,
  delivery_condition_id       TEXT REFERENCES settings_delivery_conditions (id) ON DELETE SET NULL,
  payment_terms_text          TEXT,
  delivery_conditions_text    TEXT,
  accepted_at                 INTEGER,
  accepted_by_name            TEXT,
  accepted_by_email           TEXT,
  accepted_ip                 TEXT,
  accepted_user_agent         TEXT,
  accepted_metadata           TEXT,
  creator_token_id            TEXT,
  discount_reason             TEXT,
  is_accepted                 INTEGER DEFAULT 0,
  tax_percentage              REAL DEFAULT 0,
  tax_reason                  TEXT,
  agreement_date              TEXT,
  agreement_start_date        TEXT,
  agreement_end_date          TEXT,
  agreement_terms_override    TEXT,
  agreement_notice_email      TEXT,
  agreement_include_annex     INTEGER DEFAULT 1,
  billing_contact_email       TEXT,
  billing_po_number           TEXT,
  service_inputs              TEXT,
  billing_vat_id              TEXT,
  recipient_email             TEXT
);
CREATE INDEX offers_organization ON offers (organization_id, created_at DESC);
CREATE INDEX offers_lead ON offers (lead_id, created_at DESC);
CREATE INDEX offers_expiring ON offers (valid_until) WHERE is_accepted IS NOT 1;

CREATE TABLE offer_services (
  id                     TEXT PRIMARY KEY,
  offer_id               TEXT NOT NULL REFERENCES offers (id) ON DELETE CASCADE,
  service_id             TEXT REFERENCES services (id) ON DELETE SET NULL,
  quantity               INTEGER NOT NULL,
  price                  REAL NOT NULL,
  custom_description     TEXT,
  discount               INTEGER,
  discount_percentage    REAL,
  custom_title           TEXT,
  is_custom              INTEGER DEFAULT 0,
  hide_description       INTEGER NOT NULL DEFAULT 0,
  snapshot_name          TEXT,
  snapshot_description   TEXT,
  snapshot_group_type    TEXT,
  snapshot_is_recurring  INTEGER,
  is_optional            INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX offer_services_offer ON offer_services (offer_id, id);
CREATE INDEX offer_services_service ON offer_services (service_id);

CREATE TABLE offer_selected_links (
  id          TEXT PRIMARY KEY,
  offer_id    TEXT NOT NULL REFERENCES offers (id) ON DELETE CASCADE,
  link_id     TEXT NOT NULL REFERENCES settings_offer_links (id) ON DELETE CASCADE,
  is_enabled  INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  UNIQUE (offer_id, link_id)
);

CREATE TABLE offer_access_logs (
  id              TEXT PRIMARY KEY,
  created_at      INTEGER NOT NULL,
  offer_id        TEXT NOT NULL REFERENCES offers (id) ON DELETE CASCADE,
  accessed_email  TEXT,
  accessed_at     INTEGER NOT NULL,
  ip_address      TEXT,
  user_agent      TEXT,
  referer         TEXT,
  metadata        TEXT
);
CREATE INDEX offer_access_logs_offer ON offer_access_logs (offer_id, accessed_email);

CREATE TABLE licenses (
  id                TEXT PRIMARY KEY,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  organization_id   TEXT REFERENCES organizations (id) ON DELETE SET NULL,
  lead_id           TEXT REFERENCES leads (id) ON DELETE SET NULL,
  offer_id          TEXT REFERENCES offers (id) ON DELETE SET NULL,
  start_date        TEXT NOT NULL,
  renewal_date      TEXT NOT NULL,
  is_active         INTEGER NOT NULL DEFAULT 1,
  notes             TEXT,
  amount_eur        REAL NOT NULL DEFAULT 0,
  product           TEXT NOT NULL DEFAULT 'other',
  plan_type         TEXT,
  seats             INTEGER,
  payment_type      TEXT,
  billing_interval  TEXT
);
-- Core's rule: one license per offer.
CREATE UNIQUE INDEX licenses_offer ON licenses (offer_id) WHERE offer_id IS NOT NULL;
CREATE INDEX licenses_organization ON licenses (organization_id, start_date DESC);
CREATE INDEX licenses_lead ON licenses (lead_id, start_date DESC);

CREATE TABLE license_offers (
  license_id  TEXT NOT NULL REFERENCES licenses (id) ON DELETE CASCADE,
  offer_id    TEXT NOT NULL REFERENCES offers (id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (license_id, offer_id)
);
-- Core's rule: an offer links to one license.
CREATE UNIQUE INDEX license_offers_offer ON license_offers (offer_id);

CREATE TABLE policies (
  id               TEXT PRIMARY KEY,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  title            TEXT NOT NULL,
  description      TEXT,
  effective_date   TEXT,
  organization_id  TEXT REFERENCES organizations (id) ON DELETE SET NULL,
  url              TEXT
);
CREATE INDEX policies_organization ON policies (organization_id);

CREATE TABLE milestone_services (
  id                   TEXT PRIMARY KEY,
  created_at           INTEGER NOT NULL,
  milestone_id         TEXT NOT NULL REFERENCES milestones (id) ON DELETE CASCADE,
  service_id           TEXT REFERENCES services (id) ON DELETE SET NULL,
  is_custom            INTEGER NOT NULL DEFAULT 0,
  custom_title         TEXT,
  quantity             INTEGER NOT NULL DEFAULT 1,
  price                REAL NOT NULL DEFAULT 0,
  discount_percentage  REAL NOT NULL DEFAULT 0
);
CREATE INDEX milestone_services_milestone ON milestone_services (milestone_id);
CREATE INDEX milestone_services_service ON milestone_services (service_id);

-- A move's record takes the new group. SQLite cannot change a CHECK in place.
CREATE TABLE work_group_moves_new (
  work_group   TEXT PRIMARY KEY CHECK (work_group IN ('subjects', 'tasks', 'goals', 'interactions', 'commercial')),
  frozen       INTEGER NOT NULL DEFAULT 0,
  frozen_at    INTEGER,
  copied_at    INTEGER,
  verified_at  INTEGER,
  verified_ok  INTEGER,
  report       TEXT,
  updated_at   INTEGER NOT NULL
);
INSERT INTO work_group_moves_new SELECT work_group, frozen, frozen_at, copied_at, verified_at, verified_ok, report, updated_at FROM work_group_moves;
DROP TABLE work_group_moves;
ALTER TABLE work_group_moves_new RENAME TO work_group_moves;
