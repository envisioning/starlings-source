-- Help (meet#995, meet#996), on a workspace: who started which conversation
-- with Starlings support, and when they last read it. The conversation
-- itself lives on hq; this row only says whose it is and what is unread.
CREATE TABLE help_conversations (
  conversation_id  TEXT PRIMARY KEY,
  member_sub       TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  seen_at          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX help_conversations_member_idx ON help_conversations(member_sub);
