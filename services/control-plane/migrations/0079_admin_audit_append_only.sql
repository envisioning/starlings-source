-- admin_audit is append-only (meet#313).
--
-- No route deletes or changes a row, but nothing stopped one, and a statement
-- run by hand against D1 could remove the rows that record what an admin did.
-- These triggers refuse UPDATE and DELETE in the database itself: product code
-- cannot do it by mistake, and a hand-written statement fails loudly. Removing
-- a trigger is a schema change, so it shows in a migration and in review.
--
-- The one delete allowed is retention: MZ decided on 2026-10-01 that audit
-- rows are kept 2 years (meet#603), so a row older than that may go. `ts` is
-- milliseconds.
CREATE TRIGGER admin_audit_no_update BEFORE UPDATE ON admin_audit
BEGIN
  SELECT RAISE(ABORT, 'admin_audit is append-only');
END;

CREATE TRIGGER admin_audit_no_delete BEFORE DELETE ON admin_audit
WHEN OLD.ts >= CAST(strftime('%s', 'now', '-2 years') AS INTEGER) * 1000
BEGIN
  SELECT RAISE(ABORT, 'admin_audit is append-only');
END;
