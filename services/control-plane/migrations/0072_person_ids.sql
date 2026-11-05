-- A Meet person id (docs/WORKSPACE_STORE.md slice 2, meet#776; the new-workspace
-- half of meet#720).
--
-- Every record in a D1 workspace's work model names a person by `person_id`,
-- never by Google `sub` or address: an assignee, a creator, a favorite. A D1
-- workspace mints a random UUID the first time it sees a person
-- (`person-ids.ts`). Envisioning's rows stay null here: meet#720 seeds them
-- from Core's `auth.users`, so the ids already on Core's rows become Meet's
-- (CORE_FOLD_PLAN principle 2) and nothing has to be remapped.
--
-- Nullable, with a unique index over the set values only.
ALTER TABLE people ADD COLUMN person_id TEXT;
CREATE UNIQUE INDEX people_person_id ON people (person_id) WHERE person_id IS NOT NULL;
