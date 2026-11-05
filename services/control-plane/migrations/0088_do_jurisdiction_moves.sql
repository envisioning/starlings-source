-- Which of Envisioning's rooms and Quick Notes inboxes have moved to the EU
-- jurisdiction (meet#312, docs/ROOM_JURISDICTION_PLAN.md step 2).
--
-- A Durable Object cannot change jurisdiction, so a move is a copy into a new
-- object. `roomStub` and `quickNotesStub` read this table when the workspace
-- is `DO_JURISDICTION=legacy`: `moved` means the EU object, anything else the
-- old one. A workspace set to `eu` never reads it.
--
-- `purged_at` is when the old, frozen object's storage was deleted, 14 days
-- or more after the move. After that, a rollback is no longer possible.
CREATE TABLE do_jurisdiction_moves (
  namespace   TEXT NOT NULL CHECK (namespace IN ('rooms', 'quick_notes')),
  name        TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('moving', 'moved', 'rolled_back')),
  rows_copied INTEGER,
  moved_at    INTEGER,
  purged_at   INTEGER,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (namespace, name)
);
