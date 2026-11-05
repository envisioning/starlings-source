-- The event's description (meet#991, docs/SESSIONS.md §0): one or two
-- sentences, at most 500 characters. The sign-up page and the confirmation
-- mail show it. Core's CMS event has the same field as `description`.
ALTER TABLE events ADD COLUMN description TEXT;
