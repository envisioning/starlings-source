-- The organization Core drew from a note's guests, kept beside the
-- suggestion (docs/GRANOLA_BRIDGE.md §Suggested filing). A `lead` answer
-- with no listed subject and an organization is a lead that does not exist
-- yet; the list offers to create it there.
ALTER TABLE granola_suggestions ADD COLUMN organization_id TEXT;
