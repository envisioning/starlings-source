-- Channels: a conversation on a CRM subject, and one company-wide channel.
--
-- No new table. A channel is a thread whose `kind` names what it is about and
-- whose `audience` says who may read it — the shape `0002_threads.sql` left
-- room for on purpose. See docs/CHANNELS.md.

-- What the conversation is called, denormalized from Core when the channel is
-- created. Without it, drawing the conversation list costs one CRM round trip
-- per row. Null for a DM, which is named after the other person instead.
ALTER TABLE threads ADD COLUMN title TEXT;

-- `members` = a DM: the membership row is the authorization, exactly as before.
-- `everyone` = a channel: any Envisioning member may read it, and the
-- membership row degrades to read state, written the first time somebody opens
-- it. Defaulting to `members` leaves every existing DM as it was.
ALTER TABLE threads ADD COLUMN audience TEXT NOT NULL DEFAULT 'members';

-- Every member's conversation list reads the open channels on every poll.
CREATE INDEX threads_audience_idx ON threads(audience);
