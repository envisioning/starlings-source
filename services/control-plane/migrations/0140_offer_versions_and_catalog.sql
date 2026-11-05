-- The offer redesign's data (envisioning/core#221, #222, #223; meet#1282).
-- Decided by MZ, 2026-11-04: the redesign is built on D1, Core's editor is not
-- ported.
--
-- Core has none of these. A new column on a table the group copies is not in
-- `COMMERCIAL_COLUMNS`, so the copy's upsert never names it and the verify never
-- compares it: a copied row takes the default below, and a second copy keeps
-- what D1 wrote. `COMMERCIAL_D1_COLUMNS` in `core-commercial.ts` lists them.
--
-- No new CHECK on `offers.status`: Core's values (draft, sent, viewed, accepted,
-- declined, expired, rejected) are enforced by the member routes. `offers`
-- stays as it is, with no rebuild.

-- Every Send writes one row. A buyer reads the latest row, never live rows
-- (`servedCommercialRows`). `snapshot` holds the header, the lines and the
-- selected links in Core's column names. `totals` holds the server's figures.
CREATE TABLE offer_versions (
  id        TEXT PRIMARY KEY,
  offer_id  TEXT NOT NULL REFERENCES offers (id) ON DELETE CASCADE,
  version   INTEGER NOT NULL,
  sent_at   INTEGER NOT NULL,
  sent_by   TEXT,
  snapshot  TEXT NOT NULL,
  totals    TEXT NOT NULL,
  rate      REAL NOT NULL DEFAULT 1,
  currency  TEXT NOT NULL DEFAULT 'EUR',
  UNIQUE (offer_id, version)
);

-- A draft a member made and has not sent: no buyer reads it. A draft Core's
-- pricing request made, or one copied from Core, has 0: its buyer reads it today
-- (8 of Core's 20 drafts have a logged view, read 2026-11-04).
ALTER TABLE offers ADD COLUMN unsent_draft INTEGER NOT NULL DEFAULT 0;
-- An edit after Send: the row differs from the latest version until Send update.
ALTER TABLE offers ADD COLUMN has_unsent_changes INTEGER NOT NULL DEFAULT 0;
-- The version the buyer accepted. Null on an offer not accepted, and on one accepted before versions existed.
ALTER TABLE offers ADD COLUMN accepted_version INTEGER;
ALTER TABLE offers ADD COLUMN notes TEXT;

-- The catalog (envisioning/core#222). `slug` is the stable id www reads, and it
-- never changes once set. `is_listed` is shown on the public services page.
-- A copied service starts unlisted, with no slug.
ALTER TABLE services ADD COLUMN slug TEXT;
ALTER TABLE services ADD COLUMN is_listed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE services ADD COLUMN name_pt TEXT;
ALTER TABLE services ADD COLUMN summary_pt TEXT;
ALTER TABLE services ADD COLUMN description_pt TEXT;
CREATE UNIQUE INDEX services_slug ON services (slug) WHERE slug IS NOT NULL;

-- A partner's standing discount. A new offer for the organization starts with it.
ALTER TABLE organizations ADD COLUMN default_discount_percentage REAL;
ALTER TABLE organizations ADD COLUMN default_discount_reason TEXT;
