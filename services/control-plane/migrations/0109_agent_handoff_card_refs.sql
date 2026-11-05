-- The card an agent was last asked about in a thread (meet#1061).
--
-- `agent_handoffs` already keeps one row per (agent, thread) with the message
-- the agent is answering. A runtime's lines do not always name the card they
-- are about, so the task page could not find them. This column holds the task
-- and issue refs of that message, as JSON, written when a message is accepted
-- (markWorking). The channel-events door gives them to an agent line that
-- names no card. A question's answer keeps the refs of the run it answers.
ALTER TABLE agent_handoffs ADD COLUMN card_refs TEXT;

-- The stage Meet last moved a handed-off card to for this run, or NULL when
-- the run was not a Hand off. A Hand off starts it at `queued`; the agent's
-- lines move the card: a step to Doing, a question to Blocked, the answer to
-- Review. An agent never needs to send `move` for these (meet#1061).
ALTER TABLE agent_handoffs ADD COLUMN auto_stage TEXT;

-- Every line that names a card, so a task's page lists what was said about it:
-- the hand-off, the agent's steps, questions and answers, and the event lines.
-- An index only: the text stays in the thread's Durable Object, and a reader
-- sees a line only where they may read its thread.
CREATE TABLE card_lines (
  ref_kind   TEXT NOT NULL,
  ref_id     TEXT NOT NULL,
  thread_id  TEXT NOT NULL,
  message_id TEXT NOT NULL,
  at         INTEGER NOT NULL,
  PRIMARY KEY (ref_kind, ref_id, message_id)
);

CREATE INDEX idx_card_lines_card_at ON card_lines (ref_kind, ref_id, at DESC);

-- An answer is indexed under its question's cards: found by the question's line.
CREATE INDEX idx_card_lines_line ON card_lines (thread_id, message_id);
