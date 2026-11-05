-- The Office is rendered as one image later. Keep qualitative art direction
-- here, but do not duplicate the product's exact accent palette.
UPDATE office_scene
SET scene_json = json_remove(
  scene_json,
  '$.brand.accentPrimary',
  '$.brand.accentSecondary'
),
updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000,
updated_by = 'system:office-remove-exact-palette'
WHERE id = 1;
