// The trail behind every admin write. See `migrations/0026_admin_audit.sql`.

import type { OwnerSession } from './contracts';

export interface AdminAuditEntry {
  ts: number;
  actor_email: string;
  action: string;
  subject: string | null;
  detail: string | null;
}

/**
 * Append one audit row.
 *
 * Best-effort by construction: a write that already succeeded must not be
 * reported as failed because its trail could not be recorded — the person
 * would retry an action that has already happened. A lost row is logged and
 * the caller carries on, the same non-fatal rule the ledger writes follow
 * (docs/ADMIN.md decision 3).
 *
 * Called *after* the write it describes, so the trail never claims something
 * that did not happen.
 */
export async function recordAdminAction(
  env: Env,
  actor: OwnerSession,
  action: string,
  subject: string | null,
  detail: string | null,
): Promise<void> {
  try {
    await env.USAGE.prepare(
      `INSERT INTO admin_audit (ts, actor_sub, actor_email, action, subject, detail)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(Date.now(), actor.sub, actor.email, action, subject, detail).run();
  } catch (error) {
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'admin.audit.write.failed',
      action,
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
  }
}

/**
 * The last run of each one-off job, by action.
 *
 * The same rows as the trail, read the other way round: the trail answers
 * "what has been done lately", and `/admin/jobs` answers "when was this last
 * run" for one job that may have run months ago and fallen off the tail. A
 * job that has never run is absent rather than zero — never is a different
 * answer from long ago, and the page says so.
 */
export async function lastJobRuns(env: Env): Promise<Record<string, AdminAuditEntry>> {
  try {
    const { results } = await env.USAGE.prepare(
      `SELECT a.ts, a.actor_email, a.action, a.subject, a.detail
       FROM admin_audit a
       JOIN (SELECT action, MAX(ts) AS ts FROM admin_audit
             WHERE action LIKE 'job.%' GROUP BY action) latest
         ON latest.action = a.action AND latest.ts = a.ts`,
    ).all<AdminAuditEntry>();
    return Object.fromEntries(results.map((row) => [row.action, row]));
  } catch (error) {
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'admin.audit.jobs.failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
    return {};
  }
}

/** The tail of the trail, newest first. Rendered on `/admin`. */
export async function recentAdminActions(env: Env, limit = 50): Promise<AdminAuditEntry[]> {
  try {
    const { results } = await env.USAGE.prepare(
      `SELECT ts, actor_email, action, subject, detail
       FROM admin_audit ORDER BY ts DESC LIMIT ?1`,
    ).bind(limit).all<AdminAuditEntry>();
    return results;
  } catch (error) {
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'admin.audit.query.failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
    return [];
  }
}

/**
 * Audit rows are kept 2 years (MZ, 2026-10-01). The cutoff is the
 * same SQL expression as the trigger in migration 0079, evaluated in the same
 * statement, so the prune never asks for a row the trigger refuses: one row
 * past the line would abort the whole delete.
 */
export async function pruneAdminAudit(env: Env): Promise<number> {
  const result = await env.USAGE.prepare(
    "DELETE FROM admin_audit WHERE ts < CAST(strftime('%s', 'now', '-2 years') AS INTEGER) * 1000",
  ).run();
  return result.meta.changes ?? 0;
}
