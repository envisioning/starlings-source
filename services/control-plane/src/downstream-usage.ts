import type { AdminDownstreamUsage, DownstreamUsageReport } from './contracts';

const RETENTION_MONTHS = 13;

/** The month's downstream reading, as Admin shows it (`adminDownstreamUsageSchema`). */
export type DownstreamUsageSummary = AdminDownstreamUsage;

/**
 * Stores the newest cumulative reading. Replayed and out-of-order reports do
 * not inflate the total; counters are scoped to one client session and month.
 */
export async function recordDownstreamUsage(
  env: Env,
  report: DownstreamUsageReport,
  now = Date.now(),
): Promise<void> {
  await env.USAGE.prepare(
    `INSERT INTO downstream_usage_reports (reporter_id, month_start, received_bytes, reported_at)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (reporter_id, month_start) DO UPDATE SET
       received_bytes = MAX(downstream_usage_reports.received_bytes, excluded.received_bytes),
       reported_at = MAX(downstream_usage_reports.reported_at, excluded.reported_at)`,
  ).bind(report.reporter_id, report.month_start, report.received_bytes, now).run();
}

export async function downstreamUsageSummary(env: Env, monthStart: number): Promise<DownstreamUsageSummary> {
  const row = await env.USAGE.prepare(
    `SELECT COALESCE(SUM(received_bytes), 0) AS received_bytes,
            COUNT(*) AS reporting_sessions,
            MAX(reported_at) AS last_reported_at
     FROM downstream_usage_reports WHERE month_start = ?1`,
  ).bind(monthStart).first<DownstreamUsageSummary>();
  return row ?? { received_bytes: 0, reporting_sessions: 0, last_reported_at: null };
}

/** Retains the current month and the prior 12, enough for annual comparisons. */
export async function pruneDownstreamUsage(env: Env, now: number): Promise<number> {
  const date = new Date(now);
  const cutoff = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - RETENTION_MONTHS, 1);
  const result = await env.USAGE.prepare(
    'DELETE FROM downstream_usage_reports WHERE month_start < ?1',
  ).bind(cutoff).run();
  return result.meta.changes ?? 0;
}
