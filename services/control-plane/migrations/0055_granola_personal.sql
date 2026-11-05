-- Two privacy fixes to the Granola index (docs/PRIVACY.md §Personal meetings,
-- §Where things are hosted).
--
-- 1. The index kept every guest's email address, which D1 must never hold.
--    It needs a name to draw and a domain to group a company by; that is all
--    it keeps from now on, and the addresses already stored are reduced here.
--
-- 2. A note filed as personal is marked, and the mark is what every later read
--    obeys: no webhook, backfill or import sends it to Core, Docs or a model
--    again. The ten notes below were imported before personal meant anything;
--    their Core rows and Docs transcripts are removed by hand
--    (docs/GRANOLA_BRIDGE.md §Personal), and the mark keeps them from coming back.

ALTER TABLE granola_notes ADD COLUMN personal_at INTEGER;
ALTER TABLE granola_notes ADD COLUMN personal_by TEXT;

UPDATE granola_notes
   SET attendees = COALESCE((
     SELECT json_group_array(json_object(
       'name', COALESCE(json_extract(person.value, '$.name'), ''),
       'domain', CASE
         WHEN instr(COALESCE(json_extract(person.value, '$.email'), ''), '@') > 0
           THEN lower(substr(json_extract(person.value, '$.email'), instr(json_extract(person.value, '$.email'), '@') + 1))
         ELSE json_extract(person.value, '$.domain')
       END))
       FROM json_each(granola_notes.attendees) AS person
   ), '[]')
 WHERE json_valid(attendees);

UPDATE granola_notes
   SET personal_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
       personal_by = 'rosa@org.example'
 WHERE note_id IN (
   'not_XBVccCTbdXIkIN', 'not_OuenqiQGPIVkYm', 'not_Q3LL0LK9jrfQfa', 'not_9jKTUu1pab5Oko',
   'not_DqMHTQyZMyUwrR', 'not_nGCOVt6AkNCINB', 'not_yEayZdYgu1cnUG', 'not_KVlghb776OQNnG',
   'not_3tIqsyODJINc3h', 'not_fULHgRvdGRbRH6'
 );

-- What the model said about a personal meeting is not calibration data.
DELETE FROM granola_suggestions
 WHERE note_id IN (SELECT note_id FROM granola_notes WHERE personal_at IS NOT NULL);
