-- The workspace's accent on the central sign-in screen (MZ, 2026-10-04): the
-- button takes the workspace's colour, or a neutral fill when it has none,
-- never Envisioning's. Optional in the begin request, so a workspace on an
-- older release still begins.
ALTER TABLE sign_in_attempts ADD COLUMN accent TEXT;
