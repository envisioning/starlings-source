-- D1 interactions keep every column Core holds for them (meet#1223, meet#1204,
-- docs/CORE_FOLD_PLAN.md §Before each group moves). Without these columns the
-- `interactions` copy drops Core's data and the verify still passes, because
-- it digests only the copied columns.
--
-- Read from core-web DATABASE.md, 2026-10-22. How Core's columns land in D1:
-- - `lead_id`, `project_id` and `event_id` file the row on a subject. Core's
--   mirror trigger keeps an `interaction_subjects` row (source `mirror`) for
--   each, so D1 keeps them there, not twice.
-- - `organization_id` is "the organization this concerns", not a filing: an
--   organization's History reads it. `contact_id` is the contact of a row
--   older than `interaction_contacts`. No foreign key on either: a merge
--   repoints them (record-merges.ts), and the copy maps a merged id.
-- - `is_personal` keeps Core's meaning: the row is its owner's
--   (`owner_email`) and no list, count or feed reads it.
-- - `interaction_kind` is Core's own kind (`signals_demo`); `meeting_kind` is
--   the meeting log's filing kind, which Core keeps in `metadata`.
-- - `created_by` is `host_person_id` (migration 0076).
-- Not copied: the generated `search_vector`, and Core's surrogate `id` on the
-- two junction tables, whose D1 key is the pair.
ALTER TABLE interactions ADD COLUMN organization_id TEXT;
ALTER TABLE interactions ADD COLUMN contact_id TEXT;
ALTER TABLE interactions ADD COLUMN is_personal INTEGER NOT NULL DEFAULT 0;
ALTER TABLE interactions ADD COLUMN owner_email TEXT;
ALTER TABLE interactions ADD COLUMN interaction_kind TEXT;
ALTER TABLE interactions ADD COLUMN gmail_email_id TEXT;
ALTER TABLE interactions ADD COLUMN support_case_id TEXT;
ALTER TABLE interactions ADD COLUMN signals_evaluation_id TEXT;

CREATE INDEX interactions_organization ON interactions (organization_id) WHERE organization_id IS NOT NULL;
CREATE INDEX interactions_contact ON interactions (contact_id) WHERE contact_id IS NOT NULL;

-- Core's junction columns: which link is primary, how it was made (`filed`,
-- `auto`, `mirror`, `inherited`), and, on an `auto` link, the contact whose
-- memberships made it.
ALTER TABLE interaction_subjects ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 0;
ALTER TABLE interaction_subjects ADD COLUMN source TEXT NOT NULL DEFAULT 'filed';
ALTER TABLE interaction_subjects ADD COLUMN created_at INTEGER;
ALTER TABLE interaction_subjects ADD COLUMN created_by TEXT;
ALTER TABLE interaction_subjects ADD COLUMN via_contact_id TEXT;

ALTER TABLE interaction_contacts ADD COLUMN created_at INTEGER;

-- Partner agreements move with this group (MZ, 2026-10-10, meet#722). One
-- signature per contact and agreement; `agreement_id` names the agreement
-- text on www, not a row here. `metadata` is a JSON object (the signer's
-- address, agent and governing law).
CREATE TABLE partner_agreement_signatures (
  id                 TEXT PRIMARY KEY,
  agreement_id       TEXT NOT NULL,
  contact_id         TEXT NOT NULL REFERENCES contacts (id),
  signer_name        TEXT NOT NULL,
  signer_email       TEXT NOT NULL,
  signing_for        TEXT NOT NULL,
  organization_name  TEXT,
  signed_at          INTEGER NOT NULL,
  metadata           TEXT NOT NULL DEFAULT '{}',
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  UNIQUE (agreement_id, contact_id)
);
CREATE INDEX partner_agreement_signatures_contact ON partner_agreement_signatures (contact_id);
