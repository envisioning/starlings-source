-- Appear offline: a self-set, sticky flag that makes the roster report this
-- person as `offline` to everyone but themselves, whatever heartbeat, room or
-- calendar evidence would otherwise show. Distinct from `dnd_until` on purpose:
-- DND turns a ring away and says so; this only removes somebody from the "who's
-- around" read and blocks nothing — a message still lands, a ring still rings.
-- Sticky like `stepped_out`: it lapses when the person turns it off, not by
-- clock, because "invisible until 15:30" is a promise the roster cannot keep
-- without lying at 15:31. See docs/PRESENCE.md and envisioning/meet#57.
ALTER TABLE people ADD COLUMN invisible INTEGER NOT NULL DEFAULT 0;
