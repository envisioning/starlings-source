// The access log. Every reveal lands here, and so does every change to who
// can open what. The server cannot read a secret, so this table is the only
// answer to "who could have seen it" — treat a failed write as a failed
// request, not a warning.

import type { AuditEvent, AuditKind } from '@keep/contracts';
import { uuid } from './crypto';

export interface AuditInput {
  vaultId: string | null;
  itemId?: string | null;
  itemName?: string | null;
  actor: string;
  kind: AuditKind;
  request: Request;
  detail?: Record<string, unknown> | null;
}

export function auditStatement(env: Env, input: AuditInput): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO audit_events (id, vault_id, item_id, item_name, actor, kind, ip, user_agent, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    uuid(),
    input.vaultId,
    input.itemId ?? null,
    input.itemName ?? null,
    input.actor,
    input.kind,
    input.request.headers.get('cf-connecting-ip'),
    input.request.headers.get('user-agent')?.slice(0, 500) ?? null,
    input.detail ? JSON.stringify(input.detail) : null,
  );
}

export async function recordAudit(env: Env, input: AuditInput): Promise<void> {
  await auditStatement(env, input).run();
}

interface AuditRow {
  id: string;
  vault_id: string | null;
  item_id: string | null;
  item_name: string | null;
  actor: string;
  kind: AuditKind;
  ip: string | null;
  detail: string | null;
  created_at: string;
}

export async function listAuditEvents(env: Env, vaultId: string, limit = 200): Promise<AuditEvent[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, vault_id, item_id, item_name, actor, kind, ip, detail, created_at
       FROM audit_events
      WHERE vault_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?`,
  )
    .bind(vaultId, limit)
    .all<AuditRow>();
  return results.map(toEvent);
}

export async function listRecentAuditEvents(env: Env, limit = 200): Promise<AuditEvent[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, vault_id, item_id, item_name, actor, kind, ip, detail, created_at
       FROM audit_events
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?`,
  )
    .bind(limit)
    .all<AuditRow>();
  return results.map(toEvent);
}

function toEvent(row: AuditRow): AuditEvent {
  let detail: Record<string, unknown> | null = null;
  if (row.detail) {
    try {
      detail = JSON.parse(row.detail) as Record<string, unknown>;
    } catch {
      detail = null;
    }
  }
  return { ...row, detail };
}
