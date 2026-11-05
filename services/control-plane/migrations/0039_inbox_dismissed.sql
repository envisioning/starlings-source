-- INBOX items resolved by hand (docs/WORK.md §INBOX).
--
-- Most inbox items resolve where they live: a thread is read, a task is
-- decided, a touch is dismissed in Core. A booking has no such home on the
-- Meet side — Core owns the row and the guest owns its life — so "I have
-- seen this" is reader state, kept here beside star and mute. One row per
-- owner per item key (`booking:<id>`); deleting the row undoes the dismiss.
CREATE TABLE IF NOT EXISTS inbox_dismissed (
  sub TEXT NOT NULL,
  key TEXT NOT NULL,
  dismissed_at INTEGER NOT NULL,
  PRIMARY KEY (sub, key)
);
