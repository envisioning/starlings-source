-- Who answers for a project or a lead, on a D1 workspace (docs/OWNERSHIP.md).
--
-- The twin of Core's columns (core#155, Core migration
-- 20261006_190000_subject_responsible.sql), so a D1 workspace and a Core
-- workspace answer the same subject read and a later move is a backfill.
-- A name, never a permission: no route reads it to decide access.
--
--   responsible_email   the chosen person, lowercased. Null: nobody chose.
--   responsible_set_by  who chose them (the signed-in member).
--   responsible_set_at  when, epoch ms.
ALTER TABLE projects ADD COLUMN responsible_email TEXT;
ALTER TABLE projects ADD COLUMN responsible_set_by TEXT;
ALTER TABLE projects ADD COLUMN responsible_set_at INTEGER;
ALTER TABLE leads ADD COLUMN responsible_email TEXT;
ALTER TABLE leads ADD COLUMN responsible_set_by TEXT;
ALTER TABLE leads ADD COLUMN responsible_set_at INTEGER;

-- A departure clears the person's choices in one statement per table.
CREATE INDEX projects_responsible ON projects (responsible_email) WHERE responsible_email IS NOT NULL;
CREATE INDEX leads_responsible ON leads (responsible_email) WHERE responsible_email IS NOT NULL;
