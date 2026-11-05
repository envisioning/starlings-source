-- The Board columns a person hides, on every project and every device
-- (docs/BOARD.md, meet#1021). JSON array of WorkStage values; NULL hides
-- none. A view setting only: no card, stage or write depends on it.
ALTER TABLE work_preferences ADD COLUMN board_hidden_stages TEXT;
