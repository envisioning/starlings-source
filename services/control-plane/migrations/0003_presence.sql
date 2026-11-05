-- Presence detail: per-device check-in, self-set do not disturb, and the ring.
--
-- `last_client` alone could only ever answer "which device beat last", which
-- reads as a person being on their phone the moment they glance at it. One
-- column per client answers "where are they, right now" — a Mac on the desk
-- and a phone in the pocket are both true at once.
--
-- `kind` is groundwork, not a feature: nothing writes 'agent' yet. It is here
-- because the alternative is adding it after the first agent exists, which
-- means changing every client at the same time as the server.
-- See docs/WORK_SURFACE.md and docs/PRIVACY.md.
ALTER TABLE people ADD COLUMN kind TEXT NOT NULL DEFAULT 'human';
ALTER TABLE people ADD COLUMN dnd_until INTEGER;
ALTER TABLE people ADD COLUMN last_seen_mac INTEGER;
ALTER TABLE people ADD COLUMN last_seen_ios INTEGER;
ALTER TABLE people ADD COLUMN last_seen_web INTEGER;

-- One outstanding ring per person: the newest replaces the older one rather
-- than queueing. A ring is a nudge with a 45s life, and a stack of them is a
-- missed-call list nobody asked for — that is what messages are for.
CREATE TABLE rings (
  callee_sub            TEXT PRIMARY KEY,
  caller_email          TEXT NOT NULL,
  caller_name           TEXT,
  caller_room_slug      TEXT,
  created_at            INTEGER NOT NULL,
  expires_at            INTEGER NOT NULL
);

CREATE INDEX rings_expires_idx ON rings(expires_at);
