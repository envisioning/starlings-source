-- Remove draft-only room and anchor kinds while preserving the saved scene's
-- current geometry, labels, and placement points. Boundary types remain: a
-- wall/window/door changes future rendering and movement behavior.
WITH normalized_zones (scene_id, zones_json) AS (
  SELECT office_scene.id,
    json_group_array(
      json_set(
        json_remove(zone.value, '$.type'),
        '$.anchors',
        COALESCE(
          (
            SELECT json_group_array(json_remove(anchor.value, '$.type'))
            FROM json_each(json_extract(zone.value, '$.anchors')) AS anchor
          ),
          json('[]')
        )
      )
    )
  FROM office_scene, json_each(office_scene.scene_json, '$.zones') AS zone
  WHERE office_scene.id = 1
  GROUP BY office_scene.id
)
UPDATE office_scene
SET scene_json = json_set(
  json_remove(scene_json, '$.brand.background', '$.brand.dark'),
  '$.zones',
  json((SELECT zones_json FROM normalized_zones WHERE normalized_zones.scene_id = office_scene.id))
)
WHERE id = 1;
