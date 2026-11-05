-- The lead an interest submission filed (docs/FORMS.md step 1).
--
-- `fileInterestLead` stores the lead's id here, so an INBOX row about the
-- submission opens its lead. Null when no lead was filed: a Core workspace,
-- Work turned off, or a lead that failed. The backfill finds the lead by the
-- line `fileInterestLead` writes at the end of its notes,
-- "Early-access request <id>."
ALTER TABLE interest_submissions ADD COLUMN lead_id TEXT;

UPDATE interest_submissions
SET lead_id = (
  SELECT leads.id FROM leads
  WHERE leads.notes LIKE '%Early-access request ' || interest_submissions.id || '.%'
  ORDER BY leads.created_at
  LIMIT 1
)
WHERE lead_id IS NULL;
