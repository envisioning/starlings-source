// Access log. Every guest view, download, comment and signature lands here —
// it is what replaces (and extends) the `/api/private/docs/[id]/visit` ping
// that www does today, and it is the evidence half of the signature story.

import { uuid } from './crypto';

export interface AccessInput {
  documentId: string | null;
  grantId?: string | null;
  actor: string | null;
  actorKind: 'staff' | 'guest' | 'agent' | 'system';
  kind: 'view' | 'download' | 'annotate' | 'sign' | 'decline' | 'edit' | 'share' | 'click';
  request?: Request;
  timezone?: string | null;
  language?: string | null;
  referrer?: string | null;
  detail?: Record<string, unknown> | null;
}

/** The row written: its id and time, which a notice about it repeats. */
export interface RecordedAccess {
  id: string;
  at: string;
}

export async function recordAccess(env: Env, input: AccessInput): Promise<RecordedAccess> {
  const headers = input.request?.headers;
  const recorded = { id: uuid(), at: new Date().toISOString() };
  await env.DB.prepare(
    `INSERT INTO access_events
       (id, document_id, grant_id, actor, actor_kind, kind, ip, user_agent, referrer, timezone, language, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      recorded.id,
      input.documentId,
      input.grantId ?? null,
      input.actor,
      input.actorKind,
      input.kind,
      headers?.get('cf-connecting-ip') ?? null,
      headers?.get('user-agent')?.slice(0, 500) ?? null,
      input.referrer ?? headers?.get('referer')?.slice(0, 2000) ?? null,
      input.timezone ?? null,
      input.language ?? null,
      input.detail ? JSON.stringify(input.detail) : null,
      recorded.at,
    )
    .run();
  return recorded;
}

/** Never let an audit write fail the thing being audited. Null when the write failed. */
export async function recordAccessQuietly(env: Env, input: AccessInput): Promise<RecordedAccess | null> {
  try {
    return await recordAccess(env, input);
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        message: 'audit.failed',
        kind: input.kind,
        documentId: input.documentId,
        error: error instanceof Error ? error.message : 'Unknown error',
      }),
    );
    return null;
  }
}

/** The log, newest first. `detail` is parsed: a click's `href`, a www visit's `city` and `country`. */
export async function listAccessEvents(env: Env, documentId: string, limit = 200): Promise<unknown[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, actor, actor_kind, kind, ip, referrer, timezone, language, detail, created_at
       FROM access_events
      WHERE document_id = ?
      ORDER BY created_at DESC
      LIMIT ?`,
  )
    .bind(documentId, limit)
    .all<Record<string, unknown> & { detail: string | null }>();
  return results.map((row) => ({ ...row, detail: parseDetail(row.detail) }));
}

function parseDetail(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
