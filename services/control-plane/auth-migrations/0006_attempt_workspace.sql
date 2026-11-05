-- The workspace an attempt signs in as (docs/CENTRAL_AUTH.md "Services"):
-- the slug of a workspace host, or the workspace a service's AUTH binding
-- names. Null for an alias that names none. The auth session answers
-- silently for any origin of a workspace the browser already signed in to.
ALTER TABLE sign_in_attempts ADD COLUMN workspace TEXT;
