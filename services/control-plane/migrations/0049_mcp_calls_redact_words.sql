-- The record keeps the size of what a Claude wrote, never the words
-- (docs/MCP.md §The record, 2026-09-22). Rows written before that rule still
-- hold a DM's text, a document body, an invite's description, readable on
-- Admin. This blanks those keys in place; ids, names and outcomes stay.
-- A row cut at 4 KB is not valid JSON and cannot be edited key by key, so
-- its args go whole.
UPDATE mcp_calls
SET args = CASE
  WHEN json_valid(args) THEN json_replace(
    args,
    '$.text', '[redacted]',
    '$.notes', '[redacted]',
    '$.body', '[redacted]',
    '$.body_md', '[redacted]',
    '$.description', '[redacted]',
    '$.frontmatter', '[redacted]',
    '$.message', '[redacted]'
  )
  ELSE NULL
END
WHERE args IS NOT NULL;
