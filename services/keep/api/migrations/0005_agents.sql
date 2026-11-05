-- Agents and machine vaults (ADR 0007 in envisioning/meet, keep#3).
--
-- An agent is a member that is not a person. Its name is its Meet roster
-- address. Meet's exchange creates the row when it brokers the agent's first
-- token. The broker Worker (keep#4) registers the public key. The private
-- half is in the broker, never here: this database still holds no key that
-- opens anything.
CREATE TABLE agents (
  address           TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  suite             TEXT,
  public_key        TEXT,              -- NULL until the broker registers one, and after a Revoke
  key_registered_at TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- A machine vault holds one agent's own service keys. Its only member is that
-- agent. People add and rotate its items and never read them. One per agent.
ALTER TABLE vaults ADD COLUMN machine INTEGER NOT NULL DEFAULT 0;
ALTER TABLE vaults ADD COLUMN agent TEXT;
CREATE UNIQUE INDEX vaults_agent ON vaults (agent) WHERE agent IS NOT NULL;

-- A machine vault item: the body is sealed under its own item key, and this
-- is that item key wrapped to the agent's public key. NULL in a person's vault.
ALTER TABLE items ADD COLUMN wrapped_key TEXT;

-- `person` reaches what its owner reaches. `agent` reaches only /api/agent/*.
ALTER TABLE device_tokens ADD COLUMN scope TEXT NOT NULL DEFAULT 'person';
