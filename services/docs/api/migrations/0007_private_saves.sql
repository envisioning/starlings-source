-- Owner-private link saves (envisioning/meet#431, meet#487). A loose save
-- belongs to its author: `private_to` holds the author's email, lower case,
-- and every read answers the row only to that address. NULL is the
-- workspace-internal default every other document keeps.
--
-- Additive only, and no CHECK: `documents` is never rebuilt (AGENTS.md, "D1
-- notes"), and `visibility` cannot gain a value. So private is this column,
-- not a visibility.
--
-- Promotion clears it: filing the save on a subject, a share grant, or
-- visibility `link` / `public` (documents.ts `promote`).

ALTER TABLE documents ADD COLUMN private_to TEXT;

CREATE INDEX idx_documents_private_to ON documents(private_to) WHERE private_to IS NOT NULL;

-- Every existing save that no subject files becomes its author's. The author
-- is `link_saves.created_by`, which is NOT NULL, rather than
-- `documents.created_by`, which may be.
UPDATE documents
   SET private_to = (SELECT lower(l.created_by) FROM link_saves l WHERE l.document_id = documents.id)
 WHERE source_system = 'native'
   AND source_kind = 'link'
   AND visibility = 'internal'
   AND EXISTS (SELECT 1 FROM link_saves l WHERE l.document_id = documents.id)
   AND NOT EXISTS (SELECT 1 FROM document_subjects s WHERE s.document_id = documents.id);
