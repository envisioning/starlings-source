-- Expose the first useful furniture layer in the saved Office map.
-- Chairs and stools remain named placement items rather than a new type or
-- rendering enum. Positions are relative to each zone so this migration does
-- not disturb the saved room layout if a zone has already moved or resized.
WITH normalized_zones (scene_id, zones_json) AS (
  SELECT office_scene.id,
    json_group_array(
      CASE json_extract(zone.value, '$.id')
        WHEN 'lounge' THEN json_set(zone.value, '$.anchors', json_insert(json_extract(zone.value, '$.anchors'), '$[#]', json_object(
          'id', 'lounge-chair',
          'position', json_array(
            min(json_extract(zone.value, '$.position[0]') + 4, json_extract(zone.value, '$.position[0]') + json_extract(zone.value, '$.size[0]') - 1),
            min(json_extract(zone.value, '$.position[1]') + 2, json_extract(zone.value, '$.position[1]') + json_extract(zone.value, '$.size[1]') - 1)
          ),
          'label', 'Lounge chair'
        )))
        WHEN 'lobby' THEN json_set(zone.value, '$.anchors', json_insert(json_extract(zone.value, '$.anchors'), '$[#]', json_object(
          'id', 'waiting-seat',
          'position', json_array(
            min(json_extract(zone.value, '$.position[0]') + 1, json_extract(zone.value, '$.position[0]') + json_extract(zone.value, '$.size[0]') - 1),
            min(json_extract(zone.value, '$.position[1]') + 1, json_extract(zone.value, '$.position[1]') + json_extract(zone.value, '$.size[1]') - 1)
          ),
          'label', 'Waiting chair'
        )))
        WHEN 'kitchen' THEN json_set(zone.value, '$.anchors', json_insert(json_extract(zone.value, '$.anchors'),
          '$[#]', json_object('id', 'kitchen-stool-1', 'position', json_array(
            min(json_extract(zone.value, '$.position[0]') + 1, json_extract(zone.value, '$.position[0]') + json_extract(zone.value, '$.size[0]') - 1),
            min(json_extract(zone.value, '$.position[1]') + 1, json_extract(zone.value, '$.position[1]') + json_extract(zone.value, '$.size[1]') - 1)
          ), 'label', 'Stool 1'),
          '$[#]', json_object('id', 'kitchen-stool-2', 'position', json_array(
            min(json_extract(zone.value, '$.position[0]') + 2, json_extract(zone.value, '$.position[0]') + json_extract(zone.value, '$.size[0]') - 1),
            min(json_extract(zone.value, '$.position[1]') + 1, json_extract(zone.value, '$.position[1]') + json_extract(zone.value, '$.size[1]') - 1)
          ), 'label', 'Stool 2'),
          '$[#]', json_object('id', 'kitchen-stool-3', 'position', json_array(
            min(json_extract(zone.value, '$.position[0]') + 4, json_extract(zone.value, '$.position[0]') + json_extract(zone.value, '$.size[0]') - 1),
            min(json_extract(zone.value, '$.position[1]') + 1, json_extract(zone.value, '$.position[1]') + json_extract(zone.value, '$.size[1]') - 1)
          ), 'label', 'Stool 3')
        ))
        WHEN 'meet' THEN json_set(zone.value, '$.anchors', json_insert(json_extract(zone.value, '$.anchors'),
          '$[#]', json_object('id', 'meet-chair-1', 'position', json_array(
            min(json_extract(zone.value, '$.position[0]') + 1, json_extract(zone.value, '$.position[0]') + json_extract(zone.value, '$.size[0]') - 1),
            json_extract(zone.value, '$.position[1]')
          ), 'label', 'Chair 1'),
          '$[#]', json_object('id', 'meet-chair-2', 'position', json_array(
            min(json_extract(zone.value, '$.position[0]') + 3, json_extract(zone.value, '$.position[0]') + json_extract(zone.value, '$.size[0]') - 1),
            json_extract(zone.value, '$.position[1]')
          ), 'label', 'Chair 2'),
          '$[#]', json_object('id', 'meet-chair-3', 'position', json_array(
            min(json_extract(zone.value, '$.position[0]') + 1, json_extract(zone.value, '$.position[0]') + json_extract(zone.value, '$.size[0]') - 1),
            min(json_extract(zone.value, '$.position[1]') + 2, json_extract(zone.value, '$.position[1]') + json_extract(zone.value, '$.size[1]') - 1)
          ), 'label', 'Chair 3'),
          '$[#]', json_object('id', 'meet-chair-4', 'position', json_array(
            min(json_extract(zone.value, '$.position[0]') + 3, json_extract(zone.value, '$.position[0]') + json_extract(zone.value, '$.size[0]') - 1),
            min(json_extract(zone.value, '$.position[1]') + 2, json_extract(zone.value, '$.position[1]') + json_extract(zone.value, '$.size[1]') - 1)
          ), 'label', 'Chair 4')
        ))
        WHEN 'focus' THEN json_set(zone.value, '$.anchors', json_insert(json_extract(zone.value, '$.anchors'),
          '$[#]', json_object('id', 'focus-chair-1', 'position', json_array(
            min(json_extract(zone.value, '$.position[0]') + 1, json_extract(zone.value, '$.position[0]') + json_extract(zone.value, '$.size[0]') - 1),
            min(json_extract(zone.value, '$.position[1]') + 1, json_extract(zone.value, '$.position[1]') + json_extract(zone.value, '$.size[1]') - 1)
          ), 'label', 'Chair 1'),
          '$[#]', json_object('id', 'focus-chair-2', 'position', json_array(
            min(json_extract(zone.value, '$.position[0]') + 3, json_extract(zone.value, '$.position[0]') + json_extract(zone.value, '$.size[0]') - 1),
            min(json_extract(zone.value, '$.position[1]') + 1, json_extract(zone.value, '$.position[1]') + json_extract(zone.value, '$.size[1]') - 1)
          ), 'label', 'Chair 2'),
          '$[#]', json_object('id', 'focus-chair-3', 'position', json_array(
            min(json_extract(zone.value, '$.position[0]') + 1, json_extract(zone.value, '$.position[0]') + json_extract(zone.value, '$.size[0]') - 1),
            min(json_extract(zone.value, '$.position[1]') + 3, json_extract(zone.value, '$.position[1]') + json_extract(zone.value, '$.size[1]') - 1)
          ), 'label', 'Chair 3'),
          '$[#]', json_object('id', 'focus-chair-4', 'position', json_array(
            min(json_extract(zone.value, '$.position[0]') + 3, json_extract(zone.value, '$.position[0]') + json_extract(zone.value, '$.size[0]') - 1),
            min(json_extract(zone.value, '$.position[1]') + 3, json_extract(zone.value, '$.position[1]') + json_extract(zone.value, '$.size[1]') - 1)
          ), 'label', 'Chair 4')
        ))
        WHEN 'create' THEN json_set(zone.value, '$.anchors', json_insert(json_extract(zone.value, '$.anchors'),
          '$[#]', json_object('id', 'create-chair-1', 'position', json_array(
            min(json_extract(zone.value, '$.position[0]') + 1, json_extract(zone.value, '$.position[0]') + json_extract(zone.value, '$.size[0]') - 1),
            min(json_extract(zone.value, '$.position[1]') + 1, json_extract(zone.value, '$.position[1]') + json_extract(zone.value, '$.size[1]') - 1)
          ), 'label', 'Chair 1'),
          '$[#]', json_object('id', 'create-chair-2', 'position', json_array(
            min(json_extract(zone.value, '$.position[0]') + 3, json_extract(zone.value, '$.position[0]') + json_extract(zone.value, '$.size[0]') - 1),
            min(json_extract(zone.value, '$.position[1]') + 1, json_extract(zone.value, '$.position[1]') + json_extract(zone.value, '$.size[1]') - 1)
          ), 'label', 'Chair 2'),
          '$[#]', json_object('id', 'create-chair-3', 'position', json_array(
            min(json_extract(zone.value, '$.position[0]') + 1, json_extract(zone.value, '$.position[0]') + json_extract(zone.value, '$.size[0]') - 1),
            min(json_extract(zone.value, '$.position[1]') + 3, json_extract(zone.value, '$.position[1]') + json_extract(zone.value, '$.size[1]') - 1)
          ), 'label', 'Chair 3')
        ))
        WHEN 'agents' THEN json_set(zone.value, '$.anchors', json_insert(json_extract(zone.value, '$.anchors'),
          '$[#]', json_object('id', 'agent-chair-1', 'position', json_array(
            min(json_extract(zone.value, '$.position[0]') + 1, json_extract(zone.value, '$.position[0]') + json_extract(zone.value, '$.size[0]') - 1),
            min(json_extract(zone.value, '$.position[1]') + 1, json_extract(zone.value, '$.position[1]') + json_extract(zone.value, '$.size[1]') - 1)
          ), 'label', 'Chair 1'),
          '$[#]', json_object('id', 'agent-chair-2', 'position', json_array(
            min(json_extract(zone.value, '$.position[0]') + 4, json_extract(zone.value, '$.position[0]') + json_extract(zone.value, '$.size[0]') - 1),
            min(json_extract(zone.value, '$.position[1]') + 1, json_extract(zone.value, '$.position[1]') + json_extract(zone.value, '$.size[1]') - 1)
          ), 'label', 'Chair 2')
        ))
        WHEN 'think' THEN json_set(zone.value, '$.anchors', json_insert(json_extract(zone.value, '$.anchors'),
          '$[#]', json_object('id', 'think-chair-1', 'position', json_array(
            min(json_extract(zone.value, '$.position[0]') + 1, json_extract(zone.value, '$.position[0]') + json_extract(zone.value, '$.size[0]') - 1),
            min(json_extract(zone.value, '$.position[1]') + 1, json_extract(zone.value, '$.position[1]') + json_extract(zone.value, '$.size[1]') - 1)
          ), 'label', 'Chair 1'),
          '$[#]', json_object('id', 'think-chair-2', 'position', json_array(
            min(json_extract(zone.value, '$.position[0]') + 3, json_extract(zone.value, '$.position[0]') + json_extract(zone.value, '$.size[0]') - 1),
            min(json_extract(zone.value, '$.position[1]') + 1, json_extract(zone.value, '$.position[1]') + json_extract(zone.value, '$.size[1]') - 1)
          ), 'label', 'Chair 2'),
          '$[#]', json_object('id', 'think-chair-3', 'position', json_array(
            min(json_extract(zone.value, '$.position[0]') + 2, json_extract(zone.value, '$.position[0]') + json_extract(zone.value, '$.size[0]') - 1),
            min(json_extract(zone.value, '$.position[1]') + 2, json_extract(zone.value, '$.position[1]') + json_extract(zone.value, '$.size[1]') - 1)
          ), 'label', 'Chair 3')
        ))
        ELSE zone.value
      END
    )
  FROM office_scene, json_each(office_scene.scene_json, '$.zones') AS zone
  WHERE office_scene.id = 1
  GROUP BY office_scene.id
)
UPDATE office_scene
SET scene_json = json_set(
  scene_json,
  '$.zones',
  json((SELECT zones_json FROM normalized_zones WHERE normalized_zones.scene_id = office_scene.id))
),
updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
updated_by = 'system:office-chairs'
WHERE id = 1;
