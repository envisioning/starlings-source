-- Attended releases (ADR 0007 decisions 5 and 10 to 12 in envisioning/meet, keep#5).
--
-- One item of a person's vault, released to one agent for one task, until an
-- expiry. The approving member's device opened the item and sealed its body
-- under a one-time key, wrapped to a public key the agent made for this one
-- request. This table holds that sealed body and that wrap, never a value and
-- never a key that opens one. The agent fetches them once; the fetch, an end
-- and the expiry each close the release, and the first two clear the payload.
--
-- `id` is the request id the agent chose in its Meet card. It is in the
-- body's AAD, so the payload cannot pass for another release.
CREATE TABLE releases (
  id                 TEXT PRIMARY KEY,
  vault_id           TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  item_id            TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  item_name          TEXT NOT NULL,     -- snapshot, for the list and the trail
  agent              TEXT NOT NULL,     -- the agent's Meet roster address
  approver           TEXT NOT NULL,     -- the member who approved on their device
  task               TEXT NOT NULL,
  reason             TEXT,
  session_public_key TEXT NOT NULL,     -- raw P-256 point, base64url
  iv                 TEXT,              -- the sealed body; NULL once fetched or ended
  ciphertext         TEXT,
  wrapped_key        TEXT,              -- JSON WrappedToPublicKey; NULL once fetched or ended
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at         TEXT NOT NULL,     -- same format as created_at, so text order is time order
  fetched_at         TEXT,
  ended_at           TEXT,
  ended_by           TEXT
);

CREATE INDEX releases_vault ON releases (vault_id, expires_at);
CREATE INDEX releases_agent ON releases (agent);
