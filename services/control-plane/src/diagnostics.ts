// MetricKit reports from the Apple clients. A device posts what
// MetricKit delivers; Admin lists the rows and opens one payload. No
// symbolication here: release CI keeps each build's dSYMs, and an operator
// symbolicates a payload against them (docs/OPERATIONS.md).

import type { DiagnosticReport, DiagnosticsListResponse } from './contracts';
import type { OwnerSession } from './contracts';
import { ControlError } from './errors';

/** How long a report is kept. Long enough to see a release through, no longer. */
const DIAGNOSTICS_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export async function recordDiagnostic(env: Env, owner: OwnerSession, report: DiagnosticReport, now = Date.now()): Promise<string> {
  const id = crypto.randomUUID();
  await env.USAGE.prepare(
    `INSERT INTO diagnostics (id, ts, sub, email, platform, app_version, kind, payload)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  ).bind(id, now, owner.sub, owner.email, report.platform, report.app_version, report.kind, report.payload_json).run();
  return id;
}

/** The newest reports, without payloads. */
export async function listDiagnostics(env: Env, limit = 100): Promise<DiagnosticsListResponse> {
  const { results } = await env.USAGE.prepare(
    `SELECT id, ts, email, platform, app_version, kind, length(payload) AS bytes
     FROM diagnostics ORDER BY ts DESC LIMIT ?1`,
  ).bind(limit).all<DiagnosticsListResponse['reports'][number]>();
  return { reports: results };
}

/** One payload, as the device sent it. */
export async function diagnosticPayload(env: Env, id: string): Promise<string> {
  const row = await env.USAGE.prepare('SELECT payload FROM diagnostics WHERE id = ?1').bind(id).first<{ payload: string }>();
  if (!row) throw new ControlError('No report with that id.', 404, 'request_not_found');
  return row.payload;
}

/** Drops reports past the retention. The cron runs it; `diagnostics_ts` makes it one index range. */
export async function pruneDiagnostics(env: Env, now: number): Promise<number> {
  const result = await env.USAGE.prepare('DELETE FROM diagnostics WHERE ts < ?1').bind(now - DIAGNOSTICS_RETENTION_MS).run();
  return result.meta.changes ?? 0;
}
