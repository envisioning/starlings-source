-- Subjects: what a document is about, independent of where it lives.
--
-- A proposal is filed under /work/organization/acme because that is a sensible
-- shelf; the question every surface asks is "everything about Acme", and that
-- must survive the document being moved. Kinds are the CRM registry's entity
-- kinds. `system` is here so a second registry can join without a migration.
--
-- The `meet` / `meeting` values in the documents CHECKs are retired at the
-- contract layer (meetings are CRM interactions, not documents). SQLite cannot
-- alter a CHECK without rebuilding the table and its FTS triggers, so the DDL
-- keeps the wider set and the zod schemas are the enforcement.

CREATE TABLE document_subjects (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  system      TEXT NOT NULL DEFAULT 'core',
  kind        TEXT NOT NULL
                CHECK (kind IN ('organization', 'contact', 'offer', 'lead', 'project')),
  subject_id  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (document_id, system, kind, subject_id)
);

CREATE INDEX idx_document_subjects_subject ON document_subjects(system, kind, subject_id);
