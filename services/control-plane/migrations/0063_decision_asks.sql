-- Open decisions: questions waiting on one member (docs/help/howto/answer-a-decision.md).
-- An agent files one through MCP `ask_decision`; the member answers it from
-- INBOX; the agent reads the answer back. Meet owns the row until it is
-- answered; an answer on a subject is then written once to Core's decisions
-- and `core_decision_id` keeps the pointer. Additive only.
CREATE TABLE decision_asks (
  id                 TEXT PRIMARY KEY,
  waits_on_email     TEXT NOT NULL,
  question           TEXT NOT NULL,
  context            TEXT,
  options            TEXT NOT NULL CHECK (json_valid(options)),
  recommendation     TEXT NOT NULL,
  default_by         TEXT NOT NULL,
  subject_kind       TEXT,
  subject_id         TEXT,
  subject_title      TEXT,
  links              TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(links)),
  asked_by_email     TEXT NOT NULL,
  asked_by_label     TEXT NOT NULL,
  created_at         INTEGER NOT NULL,
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'defaulted', 'withdrawn')),
  answer             TEXT,
  answer_note        TEXT,
  answered_at        INTEGER,
  answered_by_email  TEXT,
  core_decision_id   TEXT,
  -- The last Core write failure, kept until a retry succeeds. Never shown as a lost answer.
  core_error         TEXT,
  updated_at         INTEGER NOT NULL
);

CREATE INDEX decision_asks_waits_on ON decision_asks (waits_on_email, status);
CREATE INDEX decision_asks_asked_by ON decision_asks (asked_by_email, updated_at);
CREATE INDEX decision_asks_subject ON decision_asks (subject_kind, subject_id);
