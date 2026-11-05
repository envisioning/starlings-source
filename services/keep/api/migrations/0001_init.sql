-- keep.org.example — the whole schema.
--
-- Read this with one fact in mind: every column named *_key, ciphertext or
-- wrapped_* holds bytes the Worker cannot decrypt. There is no key on the
-- server. A dump of this database plus every Worker secret yields wrapped
-- blobs and an audit trail, nothing else.

-- One keypair per person. The private half is sealed client-side under a
-- key derived from a passkey (PRF) or a passphrase; `wrap_params` says which
-- and carries the salts. Re-enrolling replaces the row and orphans every
-- vault membership wrapped to the old public key — see keys.ts.
CREATE TABLE staff_keys (
  email               TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  suite               TEXT NOT NULL,
  public_key          TEXT NOT NULL,
  wrapped_private_key TEXT NOT NULL,   -- JSON Sealed
  wrap_params         TEXT NOT NULL,   -- JSON WrapParams
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- The org recovery key. Public half here; the private half is XOR-split into
-- two shares held by two people, off this system. Single row, replaced on
-- purpose only: every vault's recovery copy is wrapped to this key, so a new
-- one means every vault must be re-wrapped by a member (vaults.ts refuses
-- creation and rotation without a recovery wrap once this row exists).
CREATE TABLE recovery_key (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  suite       TEXT NOT NULL,
  public_key  TEXT NOT NULL,
  holders     TEXT NOT NULL,           -- JSON string[]
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE vaults (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  project_id  TEXT,                    -- Core project uuid; a link out, never resolved here
  key_version INTEGER NOT NULL DEFAULT 1,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX vaults_project ON vaults (project_id);

-- Membership is the vault key wrapped to the member's public key. No row, no
-- key, no access — the server enforces nothing the maths does not.
CREATE TABLE vault_members (
  vault_id    TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  wrapped_key TEXT NOT NULL,           -- JSON WrappedToPublicKey
  granted_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (vault_id, email)
);
CREATE INDEX vault_members_email ON vault_members (email);

-- The same vault key wrapped to the recovery key, one row per key version
-- so an old backup can still be opened after a rotation.
CREATE TABLE vault_recovery_keys (
  vault_id    TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  key_version INTEGER NOT NULL,
  wrapped_key TEXT NOT NULL,           -- JSON WrappedToPublicKey
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (vault_id, key_version)
);

-- Name and kind in the clear so a list can be drawn; everything else is one
-- sealed JSON body under the vault key with the row's ids as AAD.
CREATE TABLE items (
  id          TEXT PRIMARY KEY,
  vault_id    TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  iv          TEXT NOT NULL,
  ciphertext  TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  rotated_at  TEXT
);
CREATE INDEX items_vault ON items (vault_id, name);

-- Deliberately no foreign keys: the trail must outlive the vault and the
-- item it describes. `item_name` is a snapshot for the same reason.
CREATE TABLE audit_events (
  id          TEXT PRIMARY KEY,
  vault_id    TEXT,
  item_id     TEXT,
  item_name   TEXT,
  actor       TEXT NOT NULL,
  kind        TEXT NOT NULL,
  ip          TEXT,
  user_agent  TEXT,
  detail      TEXT,                    -- JSON
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX audit_events_vault ON audit_events (vault_id, created_at DESC);
CREATE INDEX audit_events_actor ON audit_events (actor, created_at DESC);
