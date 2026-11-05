// The workspace's history and activation, for the operator dashboard
// (docs/OPS_CONSOLE.md §History, §Activation).
//
// History: `ops_daily`, one row of counts per UTC day, written by the cron.
// Activation: when the workspace reached each first milestone, read from the
// first timestamps its tables already hold. Counts and times only; no row
// about a person leaves this file.
import { OPS_MILESTONES, type OpsActivation, type OpsHistoryDay, type OpsMilestoneKey } from '@starlings/contracts/ops';
import { workStore } from './work-store';

const DAY_MS = 86_400_000;
/** Days of history the dashboard reads. */
export const HISTORY_DAYS = 120;
/** Days `ops_daily` keeps. */
const KEEP_DAYS = 730;
/** Alive at day 14: at least this many members active in week two (MZ, 2026-09-29). */
export const ALIVE_DAY14_MEMBERS = 3;

const startOfUTCDay = (ms: number) => {
  const at = new Date(ms);
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
};
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Write today's row. Every tick overwrites it, so the counts are the day's as
 * of the last tick: at most five minutes of the day go uncounted.
 */
export async function recordOpsDaily(env: Pick<Env, 'USAGE'>, now: number): Promise<void> {
  const day = startOfUTCDay(now);
  await env.USAGE.prepare(
    `INSERT INTO ops_daily (day, members, active_day, active_week, active_month, active_web, active_mac, active_ios, devices_active, agents_active, updated_at)
     SELECT ?1,
       COALESCE(SUM(CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END), 0),
       COALESCE(SUM(CASE WHEN revoked_at IS NULL AND last_seen_at >= ?2 THEN 1 ELSE 0 END), 0),
       COALESCE(SUM(CASE WHEN revoked_at IS NULL AND last_seen_at >= ?3 THEN 1 ELSE 0 END), 0),
       COALESCE(SUM(CASE WHEN revoked_at IS NULL AND last_seen_at >= ?4 THEN 1 ELSE 0 END), 0),
       COALESCE(SUM(CASE WHEN revoked_at IS NULL AND last_seen_web >= ?2 THEN 1 ELSE 0 END), 0),
       COALESCE(SUM(CASE WHEN revoked_at IS NULL AND last_seen_mac >= ?2 THEN 1 ELSE 0 END), 0),
       COALESCE(SUM(CASE WHEN revoked_at IS NULL AND last_seen_ios >= ?2 THEN 1 ELSE 0 END), 0),
       (SELECT COUNT(*) FROM owner_devices WHERE renewed_at >= ?5),
       (SELECT COUNT(*) FROM mcp_grants WHERE revoked_at IS NULL AND last_call_at >= ?5),
       ?6
     FROM people WHERE kind = 'human'
     ON CONFLICT (day) DO UPDATE SET
       members = excluded.members, active_day = excluded.active_day, active_week = excluded.active_week,
       active_month = excluded.active_month, active_web = excluded.active_web, active_mac = excluded.active_mac,
       active_ios = excluded.active_ios, devices_active = excluded.devices_active, agents_active = excluded.agents_active,
       updated_at = excluded.updated_at`,
  ).bind(isoDay(day), day, day - 6 * DAY_MS, day - 29 * DAY_MS, now - 30 * DAY_MS, now).run();
}

/** Drop rows past two years. The daily tick runs it. */
export async function pruneOpsDaily(env: Pick<Env, 'USAGE'>, now: number): Promise<void> {
  await env.USAGE.prepare('DELETE FROM ops_daily WHERE day < ?1').bind(isoDay(now - KEEP_DAYS * DAY_MS)).run();
}

/** The last `HISTORY_DAYS` rows, oldest first. Days the cron missed are absent, not zero. */
export async function readOpsHistory(db: D1Database, now: number): Promise<OpsHistoryDay[]> {
  const { results } = await db.prepare(
    `SELECT day, members, active_day, active_week, active_month, active_web, active_mac, active_ios, devices_active, agents_active
     FROM ops_daily WHERE day >= ?1 ORDER BY day`,
  ).bind(isoDay(now - (HISTORY_DAYS - 1) * DAY_MS)).all<OpsHistoryDay>();
  return results.map((row) => ({
    day: String(row.day),
    members: Number(row.members),
    active_day: Number(row.active_day),
    active_week: Number(row.active_week),
    active_month: Number(row.active_month),
    active_web: Number(row.active_web),
    active_mac: Number(row.active_mac),
    active_ios: Number(row.active_ios),
    devices_active: Number(row.devices_active),
    agents_active: Number(row.agents_active),
  }));
}

/** The first time of each milestone, from the first rows the tables hold. One batch of MIN() reads. */
async function milestoneTimes(env: Pick<Env, 'USAGE' | 'WORK_STORE'>): Promise<Record<OpsMilestoneKey, number | null>> {
  const db = env.USAGE;
  const nth = (n: number) => db.prepare(
    `SELECT first_seen_at AS at FROM people WHERE kind = 'human' ORDER BY first_seen_at LIMIT 1 OFFSET ${n - 1}`,
  );
  const reads: [OpsMilestoneKey, D1PreparedStatement | null][] = [
    ['first_signin', nth(1)],
    ['second_member', nth(2)],
    ['third_member', nth(3)],
    ['first_call', db.prepare('SELECT MIN(started_at) AS at FROM meetings_ledger')],
    ['first_guest', db.prepare("SELECT MIN(ts) AS at FROM usage_events WHERE kind = 'admit'")],
    ['first_notes', db.prepare('SELECT MIN(started_at) AS at FROM meetings_ledger WHERE summary_generated = 1')],
    ['first_calendar', db.prepare('SELECT MIN(granted_at) AS at FROM google_grants')],
    ['first_device', db.prepare('SELECT MIN(issued_at) AS at FROM owner_devices')],
    ['first_agent', db.prepare('SELECT MIN(created_at) AS at FROM mcp_grants')],
    // A Core workspace keeps its projects in Core: unknown here, not never.
    ['first_project', workStore(env) === 'd1' ? db.prepare('SELECT MIN(created_at) AS at FROM projects') : null],
  ];
  const statements = reads.flatMap(([, statement]) => statement ? [statement] : []);
  const results = await db.batch(statements);
  const times = {} as Record<OpsMilestoneKey, number | null>;
  let index = 0;
  for (const [key, statement] of reads) {
    if (!statement) { times[key] = null; continue; }
    const at = (results[index++]?.results?.[0] as { at?: number | null } | undefined)?.at;
    times[key] = at == null ? null : Number(at);
  }
  return times;
}

/**
 * Activation: each milestone's time, and the day-14 signal. Alive at day 14
 * means at least three members active in the workspace's second week: the
 * `active_week` of the row 13 days after the first sign-in. Null while the
 * workspace is younger than that, or when the row was never written (the
 * table starts with this release).
 */
export async function readActivation(env: Pick<Env, 'USAGE' | 'WORK_STORE'>, history: OpsHistoryDay[], now: number): Promise<OpsActivation> {
  const times = await milestoneTimes(env);
  const start = times.first_signin;
  let alive: boolean | null = null;
  if (start !== null && now >= startOfUTCDay(start) + 14 * DAY_MS) {
    const dayFourteen = isoDay(startOfUTCDay(start) + 13 * DAY_MS);
    const row = history.find((entry) => entry.day === dayFourteen)
      ?? await env.USAGE.prepare('SELECT active_week FROM ops_daily WHERE day = ?1').bind(dayFourteen).first<{ active_week: number }>()
        .then((found) => found ? { active_week: Number(found.active_week) } : undefined);
    alive = row ? row.active_week >= ALIVE_DAY14_MEMBERS : null;
  }
  return {
    milestones: OPS_MILESTONES.map(({ key }) => ({ key, at: times[key] })),
    alive_day14: alive,
  };
}
