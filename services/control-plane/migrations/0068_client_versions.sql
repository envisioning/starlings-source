-- The app version each device last reported on its heartbeat. One column per
-- client, like `last_seen_*`: a beat from the phone must not overwrite what
-- the Mac reported. Rosters draw it as "Desktop (5.8.1)".
ALTER TABLE people ADD COLUMN version_mac TEXT;
ALTER TABLE people ADD COLUMN version_ios TEXT;
ALTER TABLE people ADD COLUMN version_web TEXT;
