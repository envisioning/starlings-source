-- Who somebody is, beyond which device beat last.
--
-- Every column in `people` until now described a *session*: when it started,
-- which client it came from, what room it maps to. A person surface asks a
-- different question — can I reach this human right now, and who are they —
-- and none of it can be answered from a heartbeat.
--
-- `timezone` is the load-bearing one. A roster that says "Available" and a
-- roster that says "Available, and it is 23:10 where they are" lead to
-- different behaviour from the person reading it, and only the second one
-- stops a ring at midnight. It is an IANA identifier ('Europe/Lisbon'), never
-- an offset: an offset is wrong twice a year and cannot be corrected without
-- knowing the zone it came from.
--
-- `timezone_source` exists for the same reason `avatar_source` does. The
-- client reports its own zone on every check-in, which is right for somebody
-- who moved and wrong for somebody who set theirs deliberately — 'self' wins
-- over 'client' and the check-in must not overwrite it.
--
-- Working hours are what make the zone actionable rather than trivia. Minutes
-- from local midnight, so no date arithmetic and no zone conversion is needed
-- to draw "done for the day"; `work_days` is a bitmask, bit 0 Monday through
-- bit 6 Sunday, because a list of days is one more table for seven bits.
-- NULL throughout means "never said", which is not the same as "works no
-- days" — a surface reads the null and says nothing rather than guessing.
--
-- Metadata only, exactly like the rest of `people`: a working pattern and a
-- job title are what a colleague already knows about a colleague, and nothing
-- here approaches a transcript. See docs/PRIVACY.md.
ALTER TABLE people ADD COLUMN timezone TEXT;
ALTER TABLE people ADD COLUMN timezone_source TEXT;
ALTER TABLE people ADD COLUMN work_start_minute INTEGER;
ALTER TABLE people ADD COLUMN work_end_minute INTEGER;
ALTER TABLE people ADD COLUMN work_days INTEGER;

-- What they do and what to call them. Both are drawn beside a name on every
-- surface that has room for a second line, and neither has anywhere to live
-- today: the roster row invents "Available · mz · Desktop" because a title is
-- the thing it would rather have said.
ALTER TABLE people ADD COLUMN title TEXT;
ALTER TABLE people ADD COLUMN pronouns TEXT;
