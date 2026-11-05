-- Images a person attaches to a document (envisioning/meet#345 slice 2):
-- screenshots on a link save first, any native document after. The bytes
-- are in R2 at `documents/<document_id>/images/<id>`; this table is the list.
--
-- Additive, and no CHECK on any column: the contracts' zod enums are the
-- lists (AGENTS.md, "Never rebuild `documents`").
--
-- Removing an image sets `deleted_at` and keeps the object, like every other
-- delete here: nothing a person could see is hard-deleted.

CREATE TABLE document_images (
  id            TEXT PRIMARY KEY,
  document_id   TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  r2_key        TEXT NOT NULL,
  -- image/png | image/jpeg | image/webp | image/gif, from the bytes' magic.
  content_type  TEXT NOT NULL,
  byte_size     INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  -- Optional words for a screen reader and for search.
  caption       TEXT,
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at    TEXT
);

CREATE INDEX idx_document_images_document ON document_images(document_id, created_at) WHERE deleted_at IS NULL;
