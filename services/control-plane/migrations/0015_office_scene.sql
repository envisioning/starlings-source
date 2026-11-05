-- One shared structured Office scene for the web workspace.
--
-- The scene contains layout and brand metadata only. Live people, Pictures,
-- agents, and waiting-room visitors remain in their existing member/room
-- surfaces and are never copied into this configuration row.
CREATE TABLE office_scene (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  scene_json   TEXT NOT NULL,
  updated_at   INTEGER NOT NULL,
  updated_by   TEXT NOT NULL
);
