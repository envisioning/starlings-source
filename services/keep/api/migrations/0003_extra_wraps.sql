-- One private key, several ways to unwrap it. A person enrolled with a
-- passkey on the phone adds a passphrase from there, and a client that
-- cannot use passkeys (Meet for Mac, today) unwraps with that instead.
-- Same key, same public half, same vault memberships.
ALTER TABLE staff_keys ADD COLUMN extra_wraps TEXT NOT NULL DEFAULT '[]';
