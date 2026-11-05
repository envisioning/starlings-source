-- Which subject kinds a person hides for themselves (docs/WORK_MODEL.md rule 3,
-- meet#975). JSON array of `project`, `partner` and `event`; NULL hides none.
-- Leads stay in `sales_enabled` (0 hides them), so no row changes here and
-- nobody's view moves: the Worker reads the two as one `hidden_kinds` list.
ALTER TABLE work_preferences ADD COLUMN hidden_kinds TEXT;
