-- The Android app signs in as its own client (docs/ANDROID_PORT_PLAN.md §3):
-- its last-seen time and reported version, beside the Mac, iOS and web ones.
ALTER TABLE people ADD COLUMN last_seen_android INTEGER;
ALTER TABLE people ADD COLUMN version_android TEXT;
