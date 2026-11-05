-- Transcripts are staff-only (AGENTS.md §Invariants). 0004 reopened every
-- adopted Core note as `link`, and some of those notes were meeting
-- transcripts: readable through www's /private/docs/<uuid> by anyone holding
-- the id. They close here, and the Worker now refuses to share one again.

-- Four adopted transcripts carried the fallback summariser's refusal as a
-- title ("I can't fulfill that request…") and were filed as notes. They are
-- transcripts; say so first, so the next statement closes them too.
UPDATE documents
   SET category = 'transcript'
 WHERE source_system = 'core' AND source_kind = 'note'
   AND path LIKE '/work/contact/%'
   AND title LIKE '% — transcript';

UPDATE documents SET visibility = 'internal'
 WHERE category = 'transcript' AND visibility <> 'internal';

-- The adopted ones are titled "**Summary** — transcript" or with a model's
-- refusal. Name them by the contact folder and the day instead.
UPDATE documents
   SET title = COALESCE(
         (SELECT f.title FROM folders f WHERE f.id = documents.folder_id AND f.title <> ''),
         substr(path, 15, instr(substr(path, 15), '/') - 1)
       ) || ' — transcript ' || substr(created_at, 1, 10)
 WHERE source_system = 'core' AND source_kind = 'note'
   AND category = 'transcript'
   AND path LIKE '/work/contact/%'
   AND (title LIKE '**Summary**%' OR title LIKE 'I can%' OR title LIKE 'It seems%');
