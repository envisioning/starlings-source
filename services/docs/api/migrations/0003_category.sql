-- What a document *is*: a proposal, a brief, an NDA — the axis the Docs
-- sidebar's smart views are made of. One per document, from a closed list
-- the contracts own (zod enforces it; the CHECK here is the belt to those
-- braces). `kind` already means the format (markdown | pdf), so this is
-- `category`. NULL is "not said yet": native documents pick one at creation
-- from now on; the mirror stamps one per Core surface; adopted notes are
-- notes.

ALTER TABLE documents ADD COLUMN category TEXT
  CHECK (category IS NULL OR category IN (
    'proposal', 'brief', 'nda', 'contract', 'transcript', 'note',
    'newsletter', 'report', 'research', 'methodology', 'faq'
  ));

CREATE INDEX idx_documents_category ON documents(category) WHERE category IS NOT NULL;

UPDATE documents SET category = 'note'        WHERE source_kind = 'note';
UPDATE documents SET category = 'newsletter'  WHERE source_kind = 'newsletter_issue';
UPDATE documents SET category = 'report'      WHERE source_kind = 'report';
UPDATE documents SET category = 'research'    WHERE source_kind = 'research';
UPDATE documents SET category = 'methodology' WHERE source_kind = 'methodology';
UPDATE documents SET category = 'brief'       WHERE source_kind = 'signals_brief';
UPDATE documents SET category = 'faq'         WHERE source_kind = 'faq';
UPDATE documents SET category = 'transcript'  WHERE source_kind = 'note' AND slug LIKE '%transcript%';
