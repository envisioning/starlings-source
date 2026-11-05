-- Self-set intent: the second axis of presence.
--
-- `PEER_STATUSES` is an evidence ladder — every rung is a fact some device
-- proved — and none of it can say "I am at my desk and I do not want to be
-- talked to". That is a statement about a person, not a machine, so it gets
-- its own column rather than a seventh status competing with a room that is
-- provably running. Null means they never set one; evidence is then the whole
-- story, exactly as before this migration.
--
-- `intent_until` has the same shape as `dnd_until` and exists for the same
-- reason: an intent that outlives the afternoon it was set in is how a roster
-- starts lying. Only `heads_down` is ever given one — the other two lapse
-- naturally when the heartbeat does. Expiry is read at roster time rather than
-- swept, like `rings`: no alarm, no cron, no row to clean up.
-- See docs/PRESENCE.md.
ALTER TABLE people ADD COLUMN intent TEXT;
ALTER TABLE people ADD COLUMN intent_until INTEGER;
