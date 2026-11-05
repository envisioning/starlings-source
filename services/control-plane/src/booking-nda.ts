// The NDA a guest can ask to meet under when booking (docs/CORE_FOLD_PLAN.md
// §Phase 3d). The agreement is a document in the workspace's
// Docs, chosen by an admin; a guest who asks for it gets a Docs signature
// request on that document, sent as the host. Docs mails the signing link,
// keeps the sealed audit and draws the certificate. Meet keeps only the
// request's id on the booking.

import type { BookingNdaAdminResponse, BookingNdaUpdate } from '@starlings/contracts/booking-settings';
import { recordAdminAction } from './admin-audit';
import type { OwnerSession } from './contracts';
import {
  cancelDocsSignatureRequest,
  createDocsSignatureRequest,
  docsEnabled,
  getDocsDocument,
  listDocsSignatureRequests,
} from './docs';
import { ControlError } from './errors';

const KEY = 'booking_nda';
/** Long enough to sign before the meeting; Docs expires the link after. */
const NDA_EXPIRES_IN_DAYS = 60;

/** The NDA document's id, or null when the workspace offers none or has no Docs. */
export async function bookingNdaDocument(env: Env): Promise<string | null> {
  if (!docsEnabled(env)) return null;
  const row = await env.USAGE.prepare('SELECT value FROM workspace_settings WHERE key = ?1')
    .bind(KEY)
    .first<{ value: string }>();
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as { document_id?: unknown };
    return typeof parsed.document_id === 'string' && parsed.document_id ? parsed.document_id : null;
  } catch {
    return null;
  }
}

/** The admin's read: the chosen document and its title, as `actor` can see it. */
export async function readBookingNdaSetting(env: Env, actor: OwnerSession): Promise<BookingNdaAdminResponse> {
  const row = await env.USAGE.prepare('SELECT updated_at FROM workspace_settings WHERE key = ?1')
    .bind(KEY)
    .first<{ updated_at: number }>();
  const documentId = await bookingNdaDocument(env);
  let title: string | null = null;
  if (documentId) {
    title = await getDocsDocument(env, actor.email, documentId).then((document) => document.title).catch(() => null);
  }
  return { docs: docsEnabled(env), document_id: documentId, document_title: title, updated_at: row?.updated_at ?? null };
}

export async function writeBookingNda(env: Env, actor: OwnerSession, setting: BookingNdaUpdate): Promise<BookingNdaAdminResponse> {
  if (!docsEnabled(env)) throw new ControlError('This workspace has no Docs.', 503, 'not_configured');
  // Refuse a document the admin cannot read, rather than offer guests an NDA that does not open.
  if (setting.document_id) await getDocsDocument(env, actor.email, setting.document_id);
  await env.USAGE.prepare(
    `INSERT INTO workspace_settings (key, value, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).bind(KEY, JSON.stringify(setting), actor.sub, Date.now()).run();
  await recordAdminAction(env, actor, 'workspace.booking_nda', setting.document_id, setting.document_id ? 'set' : 'cleared');
  return readBookingNdaSetting(env, actor);
}

/**
 * Send the NDA to a guest who asked for it: one signer, the guest. Sent as
 * the host, so the request reads as theirs in Docs. The id, or null when
 * Docs refused: the booking stands either way, and the host sees in INBOX
 * that the guest asked for an NDA.
 */
export async function sendBookingNda(
  env: Env,
  documentId: string,
  host: OwnerSession,
  guest: { name: string; email: string },
): Promise<string | null> {
  try {
    const request = await createDocsSignatureRequest(env, host.email, documentId, {
      subject: `NDA for your meeting with ${host.name}`,
      message: `You asked to meet ${host.name} under NDA. Please read and sign it before the meeting.`,
      ordered: false,
      expires_in_days: NDA_EXPIRES_IN_DAYS,
      parties: [{ email: guest.email, name: guest.name, role: 'signer' }],
    });
    return request.id;
  } catch (error) {
    console.warn(`booking.nda.send_failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** The guest's side of the request: `pending` until they sign, then `signed`; null when Docs cannot say. */
export async function bookingNdaStatus(
  env: Env,
  documentId: string,
  host: OwnerSession,
  requestId: string,
): Promise<'pending' | 'signed' | 'closed' | null> {
  try {
    const request = (await listDocsSignatureRequests(env, host.email, documentId)).find((row) => row.id === requestId);
    if (!request) return null;
    if (request.status === 'completed') return 'signed';
    return request.status === 'pending' ? 'pending' : 'closed';
  } catch {
    return null;
  }
}

/** A cancelled booking takes its unsigned NDA with it. A signed one stands. */
export async function withdrawBookingNda(env: Env, host: OwnerSession, requestId: string): Promise<void> {
  await cancelDocsSignatureRequest(env, host.email, requestId).catch(() => undefined);
}
