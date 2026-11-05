-- Contacts on every workspace (docs/RELATIONSHIPS.md slice 2, meet#947).
--
-- A contact has several addresses. Each address belongs to one contact in the
-- workspace: the address is the key, so the same person typed twice is found,
-- not filed again. `contacts.email` stays the primary address, which is the
-- one Core holds; the Core fold maps Core's email to the primary row
-- (MZ, 2026-10-05). Addresses are stored lower case.
CREATE TABLE contact_emails (
  email       TEXT PRIMARY KEY,
  contact_id  TEXT NOT NULL REFERENCES contacts (id),
  created_at  INTEGER NOT NULL
);
CREATE INDEX contact_emails_contact ON contact_emails (contact_id);

-- Every primary address a contact already has. Two contacts with the same
-- address keep their rows; the older one takes the address.
INSERT OR IGNORE INTO contact_emails (email, contact_id, created_at)
  SELECT lower(trim(email)), id, created_at FROM contacts
  WHERE email IS NOT NULL AND trim(email) <> ''
  ORDER BY created_at;

-- The calls a contact was in. A filed call links each participant whose
-- address is a contact's; it never creates a contact (that is slice 4, with a
-- member's confirmation).
CREATE TABLE interaction_contacts (
  interaction_id  TEXT NOT NULL REFERENCES interactions (id),
  contact_id      TEXT NOT NULL REFERENCES contacts (id),
  PRIMARY KEY (interaction_id, contact_id)
);
CREATE INDEX interaction_contacts_contact ON interaction_contacts (contact_id);
