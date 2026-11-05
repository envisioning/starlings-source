-- The email link works only in the browser that asked for it (meet#901).
-- The request sets a random browser cookie and keeps its SHA-256 here; the
-- spend needs both. A link from before this column has none and is refused,
-- which costs one new request inside its 15 minutes.
ALTER TABLE email_sign_in_links ADD COLUMN browser_hash TEXT;
