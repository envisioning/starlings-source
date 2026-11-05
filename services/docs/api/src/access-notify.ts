// Tell the workspace that a guest opened a document or a link inside it
//. Docs records the access event; the workspace's
// Starlings Worker files it on the document's subjects and notifies the owner.
//
// Only guests: a grant guest, or a visitor www records over the internal
// route. Staff and agents are never sent, and neither is an address on this
// deployment's identity domains, whatever principal carried it.
//
// Best effort, after the response: `ctx.waitUntil`, and every failure is a
// logged warning. A deployment without the `MEET` binding sends nothing. An
// older Starlings Worker without `documentAccessed` throws on the call, and
// that must never fail the request that was recorded.

import { COUNTRY_CODE, type DocumentAccessedInput } from '@docs/contracts';
import type { RecordedAccess } from './audit';
import type { MemberBinding } from './central-auth';
import type { DocumentRow } from './documents';
import { isIdentityEmail } from './identity';

export interface AccessNotice {
  recorded: RecordedAccess | null;
  document: Pick<DocumentRow, 'id' | 'title' | 'created_by'>;
  kind: 'view' | 'click';
  actor: string;
  via: 'grant' | 'www';
  grantId: string | null;
  city: string | null;
  country: string | null;
  href: string | null;
}

/** Where a request came from, as Cloudflare saw it. Country only when it is ISO alpha-2. */
export function requestPlace(request: Request): { city: string | null; country: string | null } {
  const cf = request.cf as { city?: unknown; country?: unknown } | undefined;
  return {
    city: typeof cf?.city === 'string' && cf.city.trim() ? cf.city.trim().slice(0, 120) : null,
    country: normalizeCountry(cf?.country),
  };
}

export function normalizeCountry(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const upper = value.trim().toUpperCase();
  return COUNTRY_CODE.test(upper) ? upper : null;
}

export function notifyDocumentAccessed(env: Env, ctx: ExecutionContext, notice: AccessNotice): void {
  const binding = env.MEET as MemberBinding | undefined;
  if (!binding || !notice.recorded) return;
  if (isIdentityEmail(env, notice.actor)) return;
  const recorded = notice.recorded;
  ctx.waitUntil(
    (async () => {
      try {
        const { results } = await env.DB.prepare(
          `SELECT kind, subject_id FROM document_subjects
            WHERE document_id = ? AND system = 'core'
            ORDER BY kind, subject_id`,
        )
          .bind(notice.document.id)
          .all<{ kind: string; subject_id: string }>();
        const owner = notice.document.created_by?.trim().toLowerCase() ?? '';
        const input: DocumentAccessedInput = {
          v: 1,
          event_id: recorded.id,
          document_id: notice.document.id,
          title: notice.document.title,
          owner: owner.includes('@') ? owner : null,
          subjects: results.map((row) => ({ kind: row.kind, subject_id: row.subject_id })),
          kind: notice.kind,
          actor: notice.actor.toLowerCase(),
          via: notice.via,
          grant_id: notice.grantId,
          city: notice.city,
          country: notice.country,
          href: notice.kind === 'click' ? notice.href : null,
          at: recorded.at,
        };
        await binding.documentAccessed(input);
      } catch (error) {
        console.warn(
          JSON.stringify({
            level: 'warn',
            message: 'access.notify_failed',
            kind: notice.kind,
            documentId: notice.document.id,
            eventId: recorded.id,
            error: error instanceof Error ? error.message : 'Unknown error',
          }),
        );
      }
    })(),
  );
}
