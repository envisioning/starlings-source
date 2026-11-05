-- After the call (meet#756): which meetings have a follow-up waiting on
-- their host, so INBOX finds them without opening every room.
--
-- A pointer, not the draft. The draft is text derived from the transcript and
-- stays beside it, in the meeting's room (docs/PRIVACY.md); INBOX reads it
-- from there. Written by the delivery ledger's `followup` destination once a
-- call is filed on a lead, project or partner and had outside attendees with
-- an address, so a call filed later gets its row then.
CREATE TABLE meeting_follow_ups (
  meeting_id    TEXT PRIMARY KEY,
  room_slug     TEXT NOT NULL,
  host_email    TEXT NOT NULL,     -- lowercased; only the host sees it
  subject_kind  TEXT NOT NULL,     -- 'lead' | 'project' | 'organization'
  subject_id    TEXT NOT NULL,
  subject_title TEXT NOT NULL,
  created_at    INTEGER NOT NULL,  -- epoch ms
  expires_at    INTEGER NOT NULL,  -- unanswered, it leaves INBOX then
  state         TEXT NOT NULL DEFAULT 'open'  -- 'open' | 'approved' | 'dismissed'
);

CREATE INDEX meeting_follow_ups_host ON meeting_follow_ups (host_email, state, expires_at);
