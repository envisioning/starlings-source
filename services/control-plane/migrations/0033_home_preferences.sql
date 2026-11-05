-- What Home is made of, per person: the order of its modules and which of
-- them show. One row per owner, the resolved list as JSON
-- (packages/contracts/src/home-layout.ts, pinned by fixtures/home-layout.json).
-- JSON rather than a column per module because the list is ordered and the
-- module set grows; every read resolves it again, so a module that ships
-- after a row was written still lands in its default place.
CREATE TABLE home_preferences (
  sub TEXT PRIMARY KEY,
  modules TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
