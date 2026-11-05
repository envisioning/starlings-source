-- What Envisioning's switch to D1 booking needs from a booking row
-- (docs/CORE_FOLD_PLAN.md §Phase 3d, meet#1008). All times are epoch ms.
--
-- INBOX reads the host's bookings from here (inbox.ts), so a row carries the
-- change stamps Core's `bookings` carries: when it was cancelled, and when
-- it moved and from where. A guest's move cancels the old row and books a
-- new one; `replaced_by` names the new row, so INBOX shows one move and not
-- a cancel and a booking.
ALTER TABLE bookings ADD COLUMN cancelled_at INTEGER;
ALTER TABLE bookings ADD COLUMN rescheduled_at INTEGER;
ALTER TABLE bookings ADD COLUMN previous_starts_at INTEGER;
ALTER TABLE bookings ADD COLUMN previous_ends_at INTEGER;
ALTER TABLE bookings ADD COLUMN replaced_by TEXT;

-- The guest asked to meet under the workspace's NDA (booking-nda.ts). The
-- NDA is a Docs document; the guest signs it through a Docs signature
-- request, and Docs keeps the signature and the certificate. The row keeps
-- which document and which request, so a later change of NDA leaves this
-- booking's request readable.
ALTER TABLE bookings ADD COLUMN nda_required INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN nda_document_id TEXT;
ALTER TABLE bookings ADD COLUMN nda_request_id TEXT;

-- The join card's token (the room link's `?b=`), and on a workspace that
-- files bookings in Core, the token of Core's row for the same booking. The
-- meeting log sends Core its own token, so the call merges into the
-- booking's interaction instead of filing a second one.
ALTER TABLE bookings ADD COLUMN join_token TEXT;
ALTER TABLE bookings ADD COLUMN core_token TEXT;
CREATE INDEX bookings_join_token ON bookings (join_token) WHERE join_token IS NOT NULL;

-- A host who moves or deletes the event in Starlings' calendar finds the row by its event.
CREATE INDEX bookings_owner_event ON bookings (owner_sub, google_event_id) WHERE google_event_id IS NOT NULL;
