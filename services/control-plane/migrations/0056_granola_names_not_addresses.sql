-- 0055 dropped the address field, but Granola names a guest by their address
-- when it has no name, and 412 of those names survived. The name goes; the
-- domain beside it stays.
UPDATE granola_notes
   SET attendees = (
     SELECT json_group_array(json_object(
       'name', CASE WHEN instr(COALESCE(json_extract(person.value, '$.name'), ''), '@') > 0 THEN '' ELSE json_extract(person.value, '$.name') END,
       'domain', json_extract(person.value, '$.domain')))
       FROM json_each(granola_notes.attendees) AS person
   )
 WHERE json_valid(attendees) AND attendees LIKE '%@%';
