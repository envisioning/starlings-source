-- Follow is gone (2026-09-15): every open subject is on the rail, and mute is
-- the only way to take one off. Star and mute stay. A row that said only
-- "followed" or "not followed" now says nothing, so it goes with the column.
DELETE FROM subject_state WHERE starred = 0 AND muted = 0;
ALTER TABLE subject_state DROP COLUMN followed;
