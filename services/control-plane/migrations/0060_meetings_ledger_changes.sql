-- The member-facing MCP change feed reads only finalized meetings in the
-- owner's room, ordered by (ended_at, meeting_id).
CREATE INDEX meetings_ledger_changes_idx
  ON meetings_ledger (room_slug, ended_at, meeting_id)
  WHERE ended_at IS NOT NULL;
