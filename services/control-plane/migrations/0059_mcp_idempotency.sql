-- MCP writes reserve a scoped key before the side effect and retain the
-- original tool result for one day, so a timed-out client can safely retry.
ALTER TABLE mcp_calls ADD COLUMN replayed INTEGER NOT NULL DEFAULT 0;

CREATE TABLE mcp_idempotency (
  key            TEXT NOT NULL,
  principal_email TEXT NOT NULL,
  tool           TEXT NOT NULL,
  result_json    TEXT,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (principal_email, tool, key)
);

CREATE INDEX mcp_idempotency_created_at ON mcp_idempotency (created_at);
