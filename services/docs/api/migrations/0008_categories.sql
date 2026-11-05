-- Categories are data, not code. A workspace starts with none and its
-- people add, rename, reorder and delete their own, in Docs and in Starlings.
-- 0003 put a closed list of eleven in the contracts and in a CHECK on
-- `documents.category`; a new install inherited Envisioning's vocabulary.
--
-- `documents` is never rebuilt (AGENTS.md, "D1 notes"), so the CHECK stays
-- and the old column changes meaning: it now holds only the transcript
-- marker ('transcript' or NULL), which keeps a transcript staff-only whatever
-- category it is in, or none. The category a person picks is `category_id`,
-- with no CHECK, pointing at a row here. Deleting a category leaves its
-- documents uncategorized.
--
-- `id` is a slug fixed at creation; renaming changes `label` only, so a
-- bookmark (`?category=<id>`) survives a rename.

CREATE TABLE categories (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT
);

CREATE UNIQUE INDEX idx_categories_label ON categories(lower(label));

ALTER TABLE documents ADD COLUMN category_id TEXT REFERENCES categories(id) ON DELETE SET NULL;

CREATE INDEX idx_documents_category_id ON documents(category_id) WHERE category_id IS NOT NULL;

-- An install that already uses categories keeps them, as ordinary rows: only
-- the ones its documents carry, in the order and with the labels 0003 used.
-- A new install has no documents, so it gets no rows.
INSERT INTO categories (id, label, position, created_at, updated_at, created_by)
SELECT category,
       CASE category
         WHEN 'proposal' THEN 'Proposals'
         WHEN 'brief' THEN 'Briefs'
         WHEN 'nda' THEN 'NDAs'
         WHEN 'contract' THEN 'Contracts'
         WHEN 'transcript' THEN 'Transcripts'
         WHEN 'note' THEN 'Notes'
         WHEN 'newsletter' THEN 'Newsletters'
         WHEN 'report' THEN 'Reports'
         WHEN 'research' THEN 'Research'
         WHEN 'methodology' THEN 'Methodology'
         WHEN 'faq' THEN 'FAQ'
         ELSE category
       END,
       CASE category
         WHEN 'proposal' THEN 0
         WHEN 'brief' THEN 1
         WHEN 'nda' THEN 2
         WHEN 'contract' THEN 3
         WHEN 'transcript' THEN 4
         WHEN 'note' THEN 5
         WHEN 'newsletter' THEN 6
         WHEN 'report' THEN 7
         WHEN 'research' THEN 8
         WHEN 'methodology' THEN 9
         WHEN 'faq' THEN 10
         ELSE 11
       END,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       'migration:0008'
  FROM documents
 WHERE category IS NOT NULL
 GROUP BY category;

-- One statement, so the FTS update trigger re-indexes each row once.
-- From here `category` is the transcript marker and nothing else.
UPDATE documents
   SET category_id = category,
       category = CASE WHEN category = 'transcript' THEN 'transcript' END
 WHERE category IS NOT NULL;
