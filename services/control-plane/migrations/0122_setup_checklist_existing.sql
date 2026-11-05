-- The setup checklist (docs/ONBOARDING.md §The setup checklist, meet#875)
-- is for a new workspace. A workspace that already has people when this
-- runs (Envisioning, hq) was set up long ago: its checklist starts off, the
-- same row an admin writes with "Turn off for everyone". A freshly
-- provisioned workspace has no people yet, writes nothing here, and keeps
-- the card. INSERT OR IGNORE: a saved choice is never overwritten, and a
-- second run changes nothing.
INSERT OR IGNORE INTO workspace_settings (key, value, updated_by, updated_at)
SELECT 'setup_checklist', '{"on":false}', 'migration-0122', CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE EXISTS (SELECT 1 FROM people WHERE kind = 'human');
