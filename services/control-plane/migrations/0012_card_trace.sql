-- The last thing that happened to a card, for the board to draw on its face.
--
-- A card is a Core task or a GitHub issue; what happens to it is written as
-- event lines in its subject's channel, and those live in one Durable Object
-- per thread. The board draws every open card at once, and "the last event
-- naming this card" would be one DO round trip per card — so the answer is
-- kept here, one row per card, overwritten on every event that names it.
--
-- An index, not a store, in exactly the sense `threads.last_message_preview`
-- is one: reconstructible from the DOs, read by nothing that decides a stage,
-- and absent for a card nothing has happened to. It holds event text only —
-- what the work graph or an agent said about a card, never what a person
-- typed — which is metadata under docs/PRIVACY.md. See docs/BOARD.md.
CREATE TABLE card_trace (
  ref_kind    TEXT NOT NULL,       -- 'task' | 'issue'
  ref_id      TEXT NOT NULL,       -- a Core task id, or owner/repo#number
  thread_id   TEXT NOT NULL,       -- the channel the line is in
  message_id  TEXT NOT NULL,       -- where a card's door into the channel lands
  text        TEXT NOT NULL,       -- the event line
  at          INTEGER NOT NULL,
  PRIMARY KEY (ref_kind, ref_id)
);
