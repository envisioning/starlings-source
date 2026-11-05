-- Add the one zone property that has both visual and functional meaning:
-- enclosed rooms render as walled and can later attenuate spatial audio.
WITH normalized_zones (scene_id, zones_json) AS (
  SELECT office_scene.id,
    json_group_array(
      json_set(
        zone.value,
        '$.walled',
        CASE json_extract(zone.value, '$.id')
          WHEN 'lounge' THEN json('false')
          WHEN 'lobby' THEN json('true')
          WHEN 'kitchen' THEN json('true')
          WHEN 'meet' THEN json('true')
          WHEN 'focus' THEN json('true')
          WHEN 'create' THEN json('true')
          WHEN 'agents' THEN json('true')
          WHEN 'think' THEN json('true')
          ELSE json('false')
        END
      )
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
updated_by = 'system:office-walled-zones'
WHERE id = 1;
