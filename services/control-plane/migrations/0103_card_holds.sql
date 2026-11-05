-- Who handed each card to an agent, for the Review row in INBOX
-- (docs/OWNERSHIP.md decision 12).
--
-- One row per card, overwritten on every move an agent makes through the
-- channel-events door. `holder_email` is the person the move borrowed its
-- authority from: the human whose message the agent answered. The stage is
-- never stored here. INBOX reads it live from the card, so a row whose card
-- moved on raises nothing, and nothing has to clear it.
--
-- An index of who asked, not a store of work: no card, run or column lives
-- here (docs/BOARD.md §What must not happen).
CREATE TABLE card_holds (
  ref_kind     TEXT NOT NULL,     -- 'task' | 'issue'
  ref_id       TEXT NOT NULL,     -- a task id, or owner/repo#number
  holder_email TEXT NOT NULL,     -- lower-case
  agent_email  TEXT NOT NULL,
  subject_kind TEXT,              -- the subject the move named, when it named one
  subject_id   TEXT,
  at           INTEGER NOT NULL,  -- epoch ms of the last move
  PRIMARY KEY (ref_kind, ref_id)
);

CREATE INDEX card_holds_holder ON card_holds (holder_email, at);
