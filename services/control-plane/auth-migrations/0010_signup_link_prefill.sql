-- What a signup link carries from the interest request it answers:
-- the /start form opens with these filled in. JSON in the shape of
-- signupPrefillSchema (packages/contracts/src/signup.ts); NULL for a link the
-- operator minted by address alone. The console reads it from hq when it
-- mints, never from the form.
ALTER TABLE signup_links ADD COLUMN prefill TEXT;
