-- Who an event takes away for the day (booking pages). The same two fields
-- as the CMS `events` row on Envisioning (core-web
-- migrations/20261007_120000_events_host_emails.sql), so the fold copies them
-- as they are.
--
-- attendance   in_person | online | hybrid; NULL = not said.
-- host_emails  JSON array of lowercase member emails; '[]' = nobody.
--
-- An in-person or hybrid event closes the day to 1:1 bookings for the
-- members in host_emails, and for nobody else (booking-public.ts hostEvents).
ALTER TABLE events ADD COLUMN attendance TEXT CHECK (attendance IN ('in_person', 'online', 'hybrid'));
ALTER TABLE events ADD COLUMN host_emails TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(host_emails) AND json_type(host_emails) = 'array');
