-- A daily budget of machine-written lines per guest thread (docs/ACCESS.md;
-- FEDERATION.md decision 10).
--
-- A guest thread is where another company's Claude and our agents can meet.
-- Two machines that answer each other are a loop by construction. A line
-- from a guest or a peer never wakes our agents, and this caps what is left:
-- lines a peer organization or one of our agents writes into one guest
-- thread in one UTC day. People are never counted.
CREATE TABLE machine_turns (
  thread_id TEXT NOT NULL,
  day TEXT NOT NULL,                  -- YYYY-MM-DD, UTC
  count INTEGER NOT NULL,
  PRIMARY KEY (thread_id, day)
);
