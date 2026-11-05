-- The event page (meet#993, docs/SESSIONS.md §0): the cover image and the
-- long text. `image_url` is an https image; `body` is Markdown and the page
-- shows it under About. Core's CMS event has the same two columns, so the
-- fold copies them as they are.
ALTER TABLE events ADD COLUMN image_url TEXT;
ALTER TABLE events ADD COLUMN body TEXT;
