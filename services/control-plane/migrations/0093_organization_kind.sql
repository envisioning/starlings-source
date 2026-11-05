-- ADR 0006: the `partner` subject kind is now `organization`. Every stored
-- subject kind moves to the new name. Derived ids do not change: thread and
-- guest-thread ids still hash the old name (`idKind` in src/crm.ts). Kept as
-- they are: the meeting filing kind `partner` (Core's value), favorite kinds
-- such as `crm.partner`, and inbound-mail prefixes (`pt`).
UPDATE threads SET kind = 'organization' WHERE kind = 'partner';
UPDATE threads SET parent_id = 'organization:' || substr(parent_id, 9)
  WHERE kind = 'guest' AND parent_id LIKE 'partner:%';
UPDATE subject_state SET kind = 'organization' WHERE kind = 'partner';
UPDATE subject_visibility SET kind = 'organization' WHERE kind = 'partner';
UPDATE subject_grants SET kind = 'organization' WHERE kind = 'partner';
UPDATE decision_asks SET subject_kind = 'organization' WHERE subject_kind = 'partner';
UPDATE decisions SET subject_kind = 'organization' WHERE subject_kind = 'partner';
UPDATE interaction_subjects SET subject_kind = 'organization' WHERE subject_kind = 'partner';
UPDATE granola_suggestions SET subject_kind = 'organization' WHERE subject_kind = 'partner';
UPDATE import_mappings SET subject_kind = 'organization' WHERE subject_kind = 'partner';
-- A person's hidden kinds (0089) are a JSON array of kind names.
UPDATE work_preferences SET hidden_kinds = replace(hidden_kinds, '"partner"', '"organization"')
  WHERE hidden_kinds LIKE '%"partner"%';
