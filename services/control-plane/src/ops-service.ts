// The workspace's door for the platform operator console (docs/OPS_CONSOLE.md,
//). `starlings-ops` calls `OpsService` over a service binding. The
// entrypoint has no URL and no route, so nothing on the internet reaches it.
//
// Metadata only: names, versions, counts, one time, and the month's billable
// quantities (calls, bytes, model tokens). Never a record, a
// message, a transcript, a document or an address. A field added here must
// be added to `opsWorkspaceMetadataSchema` too, and that schema is strict.
import { WorkerEntrypoint } from 'cloudflare:workers';
import { opsWorkspaceMetadataSchema, type OpsCount, type OpsModelUsage, type OpsUsageMonth, type OpsWorkspaceMetadata } from '@starlings/contracts/ops';
import { OPEN_TASK_STATUSES } from '@starlings/contracts';
import { workspaceProduct } from './ops-product';
import { releaseInfo } from './release-info';
import { workStore, type WorkStoreKind } from './work-store';
import { workspaceDisplayName } from './workspace-profile';
import { workspaceSlug, type WorkspaceOrigins } from './workspace-origins';

export { workspaceSlug };

/** The Worker's env, with its origins widened so a test can stand in for any workspace. */
type OpsEnvSlice = Omit<Env, keyof WorkspaceOrigins> & WorkspaceOrigins;

/** Counts and one time from `people`. One query; no row leaves this function. */
async function peopleCounts(db: D1Database): Promise<Pick<OpsWorkspaceMetadata, 'members' | 'agents' | 'last_activity_at'>> {
  const row = await db.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN kind = 'human' AND revoked_at IS NULL THEN 1 ELSE 0 END), 0) AS members,
       COALESCE(SUM(CASE WHEN kind = 'agent' THEN 1 ELSE 0 END), 0) AS agents,
       MAX(CASE WHEN kind = 'human' THEN last_seen_at END) AS last_activity_at
     FROM people`,
  ).first<{ members: number; agents: number; last_activity_at: number | null }>();
  return {
    members: Number(row?.members ?? 0),
    agents: Number(row?.agents ?? 0),
    last_activity_at: row?.last_activity_at == null ? null : Number(row.last_activity_at),
  };
}

const DAY_MS = 86_400_000;

/**
 * Row counts from D1, in display order. Labels are fixed here; no row leaves
 * this function. The records (projects, tasks, ...) are counted only on a
 * `d1` workspace: on a `core` workspace they live in Core and the D1 tables
 * are empty.
 */
async function d1Counts(db: D1Database, store: WorkStoreKind, now: number): Promise<OpsCount[]> {
  const open = OPEN_TASK_STATUSES.map((_, index) => `?${index + 1}`).join(', ');
  const queries: [label: string, sql: string, binds: unknown[]][] = [
    ['Threads', 'SELECT COUNT(*) AS n FROM threads WHERE removed_at IS NULL', []],
    ['Meetings', 'SELECT COUNT(*) AS n FROM meetings_ledger', []],
    ['Meetings, 30 days', 'SELECT COUNT(*) AS n FROM meetings_ledger WHERE started_at >= ?1', [now - 30 * DAY_MS]],
    ['MCP clients', 'SELECT COUNT(*) AS n FROM mcp_clients', []],
    ['MCP calls, 7 days', 'SELECT COUNT(*) AS n FROM mcp_calls WHERE ts >= ?1', [now - 7 * DAY_MS]],
    ['Inbound requests, 30 days', 'SELECT COUNT(*) AS n FROM interest_submissions WHERE created_at >= ?1', [now - 30 * DAY_MS]],
  ];
  if (store === 'd1') {
    queries.push(
      ['Organizations', 'SELECT COUNT(*) AS n FROM organizations', []],
      ['Projects', 'SELECT COUNT(*) AS n FROM projects', []],
      ['Leads', 'SELECT COUNT(*) AS n FROM leads', []],
      ['Contacts', 'SELECT COUNT(*) AS n FROM contacts', []],
      ['Open tasks', `SELECT COUNT(*) AS n FROM tasks WHERE status IN (${open})`, [...OPEN_TASK_STATUSES]],
      ['Interactions', 'SELECT COUNT(*) AS n FROM interactions', []],
      ['Goals', 'SELECT COUNT(*) AS n FROM goals', []],
      ['Decisions', 'SELECT COUNT(*) AS n FROM decisions', []],
    );
  }
  const results = await db.batch(queries.map(([, sql, binds]) => db.prepare(sql).bind(...binds)));
  return queries.map(([label], index) => ({
    label,
    value: Number((results[index]?.results?.[0] as { n?: number } | undefined)?.n ?? 0),
  }));
}

/** `YYYY-MM` and the UTC bounds of the month `offset` months before `now`'s. */
function utcMonth(now: number, offset: number): { month: string; start: number; end: number } {
  const date = new Date(now);
  const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - offset, 1);
  const end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - offset + 1, 1);
  return { month: new Date(start).toISOString().slice(0, 7), start, end };
}

/**
 * Billable quantities for one UTC month: meetings, participant-minutes,
 * downstream bytes, notes mails, MCP calls, and model calls per provider,
 * model and purpose. Sums only; no row leaves this function.
 */
async function usageMonth(db: D1Database, now: number, offset: number): Promise<OpsUsageMonth> {
  const { month, start, end } = utcMonth(now, offset);
  const [meetings, downstream, mcp, models] = await db.batch([
    db.prepare(
      `SELECT COUNT(*) AS meetings,
              COALESCE(SUM(summary_generated), 0) AS meetings_with_notes,
              COALESCE(SUM(COALESCE(webhook_seconds, client_seconds)), 0) AS seconds,
              COALESCE(SUM(emails_sent), 0) AS emails_sent
       FROM meetings_ledger WHERE started_at >= ?1 AND started_at < ?2`,
    ).bind(start, end),
    db.prepare('SELECT COALESCE(SUM(received_bytes), 0) AS bytes FROM downstream_usage_reports WHERE month_start = ?1').bind(start),
    db.prepare('SELECT COUNT(*) AS n FROM mcp_calls WHERE ts >= ?1 AND ts < ?2').bind(start, end),
    db.prepare(
      `SELECT provider, model, purpose, SUM(calls) AS calls, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens
       FROM model_usage WHERE day >= ?1 AND day < ?2
       GROUP BY provider, model, purpose ORDER BY purpose, provider, model LIMIT 40`,
    ).bind(new Date(start).toISOString().slice(0, 10), new Date(end).toISOString().slice(0, 10)),
  ]);
  const m = (meetings?.results?.[0] ?? {}) as { meetings?: number; meetings_with_notes?: number; seconds?: number; emails_sent?: number };
  return {
    month,
    meetings: Number(m.meetings ?? 0),
    meetings_with_notes: Number(m.meetings_with_notes ?? 0),
    participant_minutes: Math.round(Number(m.seconds ?? 0) / 60),
    downstream_bytes: Number((downstream?.results?.[0] as { bytes?: number } | undefined)?.bytes ?? 0),
    emails_sent: Number(m.emails_sent ?? 0),
    mcp_calls: Number((mcp?.results?.[0] as { n?: number } | undefined)?.n ?? 0),
    models: ((models?.results ?? []) as OpsModelUsage[]).map((row) => ({
      provider: String(row.provider),
      model: String(row.model),
      purpose: String(row.purpose),
      calls: Number(row.calls ?? 0),
      input_tokens: Number(row.input_tokens ?? 0),
      output_tokens: Number(row.output_tokens ?? 0),
    })),
  };
}

/** This month and the month before, newest first. */
async function usageMonths(db: D1Database, now: number): Promise<OpsUsageMonth[]> {
  return Promise.all([usageMonth(db, now, 0), usageMonth(db, now, 1)]);
}

/** The metadata `OpsService` returns, parsed against the strict contract before it leaves. */
export async function workspaceOpsMetadata(env: OpsEnvSlice): Promise<OpsWorkspaceMetadata> {
  const store = workStore(env);
  const now = Date.now();
  const [release, people, counts, usage, name, product] = await Promise.all([
    releaseInfo(env),
    peopleCounts(env.USAGE),
    // A failed count read leaves the list empty; Health already reports D1.
    d1Counts(env.USAGE, store, now).catch(() => []),
    usageMonths(env.USAGE, now).catch(() => []),
    workspaceDisplayName(env),
    // The product block reads aggregates and env flags, never an origin; the
    // widened origin types are the only difference from `Env`.
    workspaceProduct(env as unknown as Env, now).catch((error: unknown) => {
      console.warn(JSON.stringify({ level: 'warn', message: 'ops.product.read_failed', error: error instanceof Error ? error.message : 'Unknown error' }));
      return null;
    }),
  ]);
  return opsWorkspaceMetadataSchema.parse({
    slug: workspaceSlug(env),
    name,
    work_store: store,
    build: release.build,
    migration: release.migration,
    ...people,
    counts,
    usage,
    product,
  });
}

/** RPC for `starlings-ops` only, over a service binding. It has no `fetch`. */
export class OpsService extends WorkerEntrypoint<Env> {
  async metadata(): Promise<OpsWorkspaceMetadata> {
    return workspaceOpsMetadata(this.env);
  }
}
