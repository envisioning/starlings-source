-- A glyph per vault, chosen from the client's short list. Plaintext, like the name.
ALTER TABLE vaults ADD COLUMN icon TEXT;
