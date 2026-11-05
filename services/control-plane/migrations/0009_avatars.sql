-- A face for each person, alongside the row that already says who they are.
--
-- The bytes live in R2 (`AVATARS`, keyed by `sub`); this is the pointer and
-- the cache key. `avatar_updated_at` is what every client appends to the image
-- URL, so a new picture replaces the old one everywhere on the next roster
-- read instead of waiting out a cache — the object key never changes, only
-- this number does.
--
-- `avatar_source` records whether the picture is the Google one seeded at
-- sign-in or a deliberate upload, because the seed must never overwrite a
-- choice somebody made. Metadata only, exactly like the rest of `people`.
-- See docs/PRIVACY.md.
ALTER TABLE people ADD COLUMN avatar_updated_at INTEGER;
ALTER TABLE people ADD COLUMN avatar_content_type TEXT;
ALTER TABLE people ADD COLUMN avatar_source TEXT;
