-- The rest of a project's and a lead's fields, on a D1 workspace (meet#721).
--
-- The Fields pane on Mac and iOS writes through the Worker's subject PATCH,
-- and that route answers the same on Core and on D1. These are Core's
-- columns of the same names, so a group moved by meet#757 copies them as
-- they are. They belong to the `spec_fields` and `licenses` work modules
-- (docs/WORK_MODEL.md): a workspace with those off never shows them.
--
--   license_id       Core's license, an external reference (no foreign key:
--                    licenses stay in Core, CORE_FOLD_PLAN.md phase 3b).
--   characteristics  the lead qualification checklist, a JSON object of booleans.
ALTER TABLE projects ADD COLUMN evid TEXT;
ALTER TABLE projects ADD COLUMN license_id TEXT;
ALTER TABLE projects ADD COLUMN specs TEXT;
ALTER TABLE projects ADD COLUMN technical TEXT;
ALTER TABLE projects ADD COLUMN research TEXT;
ALTER TABLE projects ADD COLUMN design TEXT;
ALTER TABLE projects ADD COLUMN contract TEXT;
ALTER TABLE projects ADD COLUMN analytics TEXT;
ALTER TABLE projects ADD COLUMN authentication TEXT;
ALTER TABLE leads ADD COLUMN characteristics TEXT;
