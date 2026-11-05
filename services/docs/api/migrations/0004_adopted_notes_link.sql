-- Notes adopted from Core were readable by anyone holding their uuid, behind
-- www.org.example/private/docs/<uuid> and its email gate. Adoption filed
-- them as `internal`, which closed those links. Reopen them: `link` is what
-- they always were. New documents stay `internal` until someone flips them.

UPDATE documents SET visibility = 'link'
 WHERE source_system = 'core' AND source_kind = 'note' AND visibility = 'internal';
