-- The first furniture migration made every chair and stool a clickable anchor.
-- Keep the saved geometry, but make anchors sparse: they are for major fixtures
-- and intentional overlay points, while natural seating belongs in the image.
WITH normalized_zones (scene_id, zones_json) AS (
  SELECT office_scene.id,
    json_group_array(
      json_set(
        zone.value,
        '$.anchors',
        json(COALESCE((
          SELECT json_group_array(json(anchor.value))
          FROM json_each(zone.value, '$.anchors') AS anchor
          WHERE lower(COALESCE(json_extract(anchor.value, '$.id'), '')) NOT LIKE '%chair%'
            AND lower(COALESCE(json_extract(anchor.value, '$.id'), '')) NOT LIKE '%stool%'
            AND lower(COALESCE(json_extract(anchor.value, '$.label'), '')) NOT LIKE '%chair%'
            AND lower(COALESCE(json_extract(anchor.value, '$.label'), '')) NOT LIKE '%stool%'
        ), '[]'))
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
updated_by = 'system:office-sparse-points'
WHERE id = 1;
