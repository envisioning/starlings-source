-- Thread index. The messages themselves live in a per-thread Durable Object
-- (ThreadCoordinator); this is the cross-thread aggregate that answers "what
-- conversations am I in" and "is there anything new" without fanning out.
--
-- Same split as rooms: the DO is the ordered truth for one conversation, D1 is
-- the account-level index. Message text appears here only as a short preview
-- for the list — never the full body, and never a transcript.
-- See docs/PRIVACY.md.
CREATE TABLE threads (
  id                    TEXT PRIMARY KEY,
  -- Polymorphic parent from day one: a DM has no parent, a thread on a meeting
  -- or a calendar event carries one. Retrofitting this later would mean
  -- rewriting every row and every client.
  kind                  TEXT NOT NULL,
  parent_id             TEXT,
  created_at            INTEGER NOT NULL,
  last_message_at       INTEGER,
  last_message_preview  TEXT,
  last_sender_email     TEXT
);

CREATE TABLE thread_members (
  thread_id             TEXT NOT NULL,
  member_sub            TEXT NOT NULL,
  member_email          TEXT NOT NULL,
  last_read_at          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (thread_id, member_sub)
);

CREATE INDEX thread_members_sub_idx ON thread_members(member_sub);
CREATE INDEX threads_last_message_idx ON threads(last_message_at);
