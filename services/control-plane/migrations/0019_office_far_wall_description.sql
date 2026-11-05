-- Keep the saved layout while making the far wall's visual direction explicit.
-- Boundary type was a draft discriminator; the stable id, label, and
-- description are the metadata the future renderer needs.
WITH normalized_boundaries (scene_id, boundaries_json) AS (
  SELECT office_scene.id,
    json_group_array(
      CASE
        WHEN json_extract(boundary.value, '$.id') = 'far-wall' THEN json_set(
          json_remove(boundary.value, '$.type'),
          '$.visible', json('true'),
          '$.blocksMovement', json('true'),
          '$.visualDescription', 'Window view of São Paulo skyline'
        )
        ELSE json_remove(boundary.value, '$.type')
      END
    )
  FROM office_scene, json_each(office_scene.scene_json, '$.boundaries') AS boundary
  WHERE office_scene.id = 1
  GROUP BY office_scene.id
)
UPDATE office_scene
SET scene_json = json_set(
  scene_json,
  '$.boundaries',
  json((SELECT boundaries_json FROM normalized_boundaries WHERE normalized_boundaries.scene_id = office_scene.id))
),
updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
updated_by = 'system:office-far-wall-art-direction'
WHERE id = 1;
