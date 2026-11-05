-- MCP: a Claude uses the company (docs/MCP.md).
--
-- Three tables, one per noun in the OAuth pairing and one for the record.
--
-- `mcp_clients` is RFC 7591 dynamic registration: a row anyone can create,
-- worth nothing until a person allows it. `mcp_grants` is that allowance —
-- one per (client, person), with the scope the person saw on /connect and
-- the refresh token that is current for it. Revocation is a column, never a
-- delete, because `mcp_calls` keys on the grant and a record that loses its
-- key is not a record.
--
-- `mcp_calls` is the record itself: every tools/call, resources/read and
-- prompts/get, written after the call, best-effort, bounded. The actor's
-- email and the client's name are stored rather than joined for the same
-- reason `admin_audit` stores them — a row must still read after the rows it
-- points at are gone. `args` is the tool's input, never a tool's output:
-- the text a Claude read is not copied into a table Admin renders.

CREATE TABLE mcp_clients (
  client_id     TEXT PRIMARY KEY,
  client_name   TEXT NOT NULL,
  client_uri    TEXT,
  redirect_uris TEXT NOT NULL,             -- JSON array
  created_at    INTEGER NOT NULL
);

CREATE TABLE mcp_codes (
  code_hash       TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL,
  sub             TEXT NOT NULL,
  email           TEXT NOT NULL,
  name            TEXT NOT NULL,
  scope           TEXT NOT NULL,
  code_challenge  TEXT NOT NULL,
  redirect_uri    TEXT NOT NULL,
  expires_at      INTEGER NOT NULL,
  used_at         INTEGER
);

CREATE TABLE mcp_grants (
  id                   TEXT PRIMARY KEY,
  client_id            TEXT NOT NULL,
  sub                  TEXT NOT NULL,
  email                TEXT NOT NULL,
  scope                TEXT NOT NULL,
  refresh_jti          TEXT NOT NULL,
  previous_refresh_jti TEXT,
  renewed_at           INTEGER NOT NULL,
  created_at           INTEGER NOT NULL,
  last_call_at         INTEGER,
  revoked_at           INTEGER,
  UNIQUE (client_id, sub)
);

CREATE INDEX mcp_grants_sub ON mcp_grants (sub);

CREATE TABLE mcp_calls (
  id            TEXT PRIMARY KEY,
  ts            INTEGER NOT NULL,
  principal     TEXT NOT NULL,             -- 'session' | 'agent'
  actor_sub     TEXT NOT NULL,
  actor_email   TEXT NOT NULL,
  grant_id      TEXT,
  client_name   TEXT,
  method        TEXT NOT NULL,             -- 'tools/call' | 'resources/read' | 'prompts/get'
  name          TEXT NOT NULL,
  args          TEXT,                      -- JSON, bounded
  outcome       TEXT NOT NULL,             -- 'ok' | 'refused' | 'failed'
  detail        TEXT,
  duration_ms   INTEGER NOT NULL
);

CREATE INDEX mcp_calls_ts ON mcp_calls (ts DESC);
CREATE INDEX mcp_calls_actor_ts ON mcp_calls (actor_sub, ts DESC);
