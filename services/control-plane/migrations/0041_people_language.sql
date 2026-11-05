-- The language the interface is drawn in, per person (meet#245, step 1).
-- NULL is "follow the device". A column on `people` rather than a table of
-- its own because it is one scalar, and every signed-in person already has
-- a row here from sign-in.
ALTER TABLE people ADD COLUMN language TEXT;
ALTER TABLE people ADD COLUMN language_updated_at INTEGER;
