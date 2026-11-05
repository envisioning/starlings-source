// Product telemetry for the operator dashboard (docs/OPS_CONSOLE.md
// §Dashboard): who is active, how they sign in, which devices and clients
// they use, which work modules and features are on, and one row per day for
// the charts. `OpsService` returns it as `product`.
//
// Counts, flags, fixed keys and app versions only. Every query here is an
// aggregate; no row leaves this file.
import { OPS_FEATURES, opsProductSchema, type OpsDay, type OpsFeatureKey, type OpsProduct, type OpsTally, type OpsWindows } from '@starlings/contracts/ops';
import { compareMeetVersions } from './client-version';
import { crmSyncEnabled } from './crm';
import { githubSyncEnabled } from './github-connector';
import { granolaSuggestEnabled } from './granola-suggest';
import { notesEngineState } from './notes';
import { readActivation, readOpsHistory } from './ops-history';
import { slackImportEnabled } from './slack-connector';
import { taskCandidatesEnabled } from './task-candidates';
import { workModulesOn } from './work-modules';
import { parsePlanRow, PLAN_SETTING_KEY, PLAN_SETTING_SQL } from './workspace-plan';
import { workspaceSuite } from './workspace-suite';

const DAY_MS = 86_400_000;
/** Days in the chart series, today included. */
const SERIES_DAYS = 30;

const FEATURE_ON: Record<OpsFeatureKey, (env: Env) => boolean | Promise<boolean>> = {
  notes: (env) => notesEngineState(env).engine !== 'off',
  task_suggestions: taskCandidatesEnabled,
  granola_suggestions: granolaSuggestEnabled,
  crm_sync: crmSyncEnabled,
  github_sync: githubSyncEnabled,
  slack_import: slackImportEnabled,
};

/** The minimum recommended version per device platform, when one is set. */
function minimumVersions(env: Pick<Env, 'MIN_RECOMMENDED_VERSION_MACOS' | 'MIN_RECOMMENDED_VERSION_IOS' | 'MIN_RECOMMENDED_VERSION_ANDROID'>): Record<string, string | undefined> {
  return {
    macos: String(env.MIN_RECOMMENDED_VERSION_MACOS ?? '').trim() || undefined,
    ios: String(env.MIN_RECOMMENDED_VERSION_IOS ?? '').trim() || undefined,
    android: String(env.MIN_RECOMMENDED_VERSION_ANDROID ?? '').trim() || undefined,
  };
}

/** `YYYY-MM-DD` for each of the last `SERIES_DAYS` UTC days, oldest first. */
export function seriesDays(now: number): string[] {
  const today = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  return Array.from({ length: SERIES_DAYS }, (_, index) => new Date(today - (SERIES_DAYS - 1 - index) * DAY_MS).toISOString().slice(0, 10));
}

type Row = Record<string, unknown>;
const n = (value: unknown) => Number(value ?? 0) || 0;
const rows = (result: D1Result | undefined) => (result?.results ?? []) as Row[];
const first = (result: D1Result | undefined) => rows(result)[0] ?? {};

function tallies(result: D1Result | undefined, limit: number): OpsTally[] {
  return rows(result)
    .map((row) => ({ key: String(row.key ?? '').slice(0, 40), value: n(row.value) }))
    .filter((tally) => tally.key && tally.value > 0)
    .slice(0, limit);
}

/** The product block, parsed against the strict contract. Throws when D1 does not answer; the caller reports null. */
export async function workspaceProduct(env: Env, now = Date.now()): Promise<OpsProduct> {
  const day = now - DAY_MS;
  const week = now - 7 * DAY_MS;
  const month = now - 30 * DAY_MS;
  const days = seriesDays(now);
  const seriesStart = Date.parse(`${days[0]}T00:00:00Z`);
  const db = env.USAGE;
  const dayOf = (column: string) => `strftime('%Y-%m-%d', ${column} / 1000, 'unixepoch')`;

  const [
    people, activeClients, signins, signinClients, devices, versions, connections, health, plan,
    dailySignins, dailyMeetings, dailyMcp, dailyErrors, dailyGuests,
  ] = await db.batch([
    db.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN role = 'admin' AND revoked_at IS NULL THEN 1 ELSE 0 END), 0) AS admins,
         COALESCE(SUM(CASE WHEN role = 'community' AND revoked_at IS NULL THEN 1 ELSE 0 END), 0) AS community,
         COALESCE(SUM(CASE WHEN revoked_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS revoked,
         COALESCE(SUM(CASE WHEN revoked_at IS NULL AND first_seen_at >= ?3 THEN 1 ELSE 0 END), 0) AS joined_30d,
         COALESCE(SUM(CASE WHEN revoked_at IS NULL AND last_seen_at >= ?1 THEN 1 ELSE 0 END), 0) AS active_day,
         COALESCE(SUM(CASE WHEN revoked_at IS NULL AND last_seen_at >= ?2 THEN 1 ELSE 0 END), 0) AS active_week,
         COALESCE(SUM(CASE WHEN revoked_at IS NULL AND last_seen_at >= ?3 THEN 1 ELSE 0 END), 0) AS active_month
       FROM people WHERE kind = 'human'`,
    ).bind(day, week, month),
    db.prepare(
      `SELECT 'web' AS key, COUNT(*) AS value FROM people WHERE kind = 'human' AND revoked_at IS NULL AND last_seen_web >= ?1
       UNION ALL SELECT 'mac', COUNT(*) FROM people WHERE kind = 'human' AND revoked_at IS NULL AND last_seen_mac >= ?1
       UNION ALL SELECT 'ios', COUNT(*) FROM people WHERE kind = 'human' AND revoked_at IS NULL AND last_seen_ios >= ?1`,
    ).bind(month),
    db.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN ts >= ?1 THEN 1 ELSE 0 END), 0) AS day,
         COALESCE(SUM(CASE WHEN ts >= ?2 THEN 1 ELSE 0 END), 0) AS week,
         COUNT(*) AS month
       FROM usage_events WHERE kind = 'signin' AND ts >= ?3`,
    ).bind(day, week, month),
    db.prepare(
      `SELECT COALESCE(client_app, 'unknown') AS key, COUNT(*) AS value FROM usage_events
       WHERE kind = 'signin' AND ts >= ?1 GROUP BY key ORDER BY value DESC LIMIT 8`,
    ).bind(month),
    db.prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN renewed_at >= ?1 THEN 1 ELSE 0 END), 0) AS active
       FROM owner_devices`,
    ).bind(month),
    db.prepare(
      `SELECT COALESCE(platform, client) AS platform, app_version AS version, COUNT(*) AS value FROM owner_devices
       WHERE renewed_at >= ?1 GROUP BY platform, version ORDER BY value DESC LIMIT 60`,
    ).bind(month),
    db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM google_grants) AS calendar,
         (SELECT COUNT(*) FROM mcp_grants WHERE revoked_at IS NULL) AS mcp_grants,
         (SELECT COUNT(*) FROM mcp_grants WHERE revoked_at IS NULL AND last_call_at >= ?1) AS mcp_active`,
    ).bind(month),
    db.prepare(
      `SELECT
         (SELECT COALESCE(SUM(count), 0) FROM operational_error_daily WHERE day >= ?1) AS errors,
         (SELECT COALESCE(SUM(count), 0) FROM ops_failures WHERE day >= ?1) AS failures,
         (SELECT COUNT(*) FROM dead_jobs) AS dead_jobs`,
    ).bind(new Date(week).toISOString().slice(0, 10)),
    db.prepare(PLAN_SETTING_SQL).bind(PLAN_SETTING_KEY),
    db.prepare(`SELECT ${dayOf('ts')} AS day, COUNT(*) AS value FROM usage_events WHERE kind = 'signin' AND ts >= ?1 GROUP BY day`).bind(seriesStart),
    db.prepare(`SELECT ${dayOf('started_at')} AS day, COUNT(*) AS value FROM meetings_ledger WHERE started_at >= ?1 GROUP BY day`).bind(seriesStart),
    db.prepare(`SELECT ${dayOf('ts')} AS day, COUNT(*) AS value FROM mcp_calls WHERE ts >= ?1 GROUP BY day`).bind(seriesStart),
    db.prepare('SELECT day, SUM(count) AS value FROM operational_error_daily WHERE day >= ?1 GROUP BY day').bind(days[0]),
    db.prepare(`SELECT ${dayOf('ts')} AS day, COUNT(*) AS value FROM usage_events WHERE kind = 'admit' AND ts >= ?1 GROUP BY day`).bind(seriesStart),
  ]);

  const byDay = (result: D1Result | undefined) => new Map(rows(result).map((row) => [String(row.day), n(row.value)]));
  const [signinsByDay, meetingsByDay, mcpByDay, errorsByDay, guestsByDay] = [dailySignins, dailyMeetings, dailyMcp, dailyErrors, dailyGuests].map(byDay);
  const daily: OpsDay[] = days.map((date) => ({
    day: date,
    signins: signinsByDay?.get(date) ?? 0,
    meetings: meetingsByDay?.get(date) ?? 0,
    mcp_calls: mcpByDay?.get(date) ?? 0,
    errors: errorsByDay?.get(date) ?? 0,
    guests: guestsByDay?.get(date) ?? 0,
  }));

  // Platforms and versions from one read; a device is outdated below its platform's floor.
  const minimum = minimumVersions(env);
  const platformCounts = new Map<string, number>();
  const versionCounts: OpsTally[] = [];
  let outdated = 0;
  for (const row of rows(versions)) {
    const platform = String(row.platform ?? 'unknown');
    const version = row.version == null ? null : String(row.version);
    const value = n(row.value);
    platformCounts.set(platform, (platformCounts.get(platform) ?? 0) + value);
    versionCounts.push({ key: `${platform} ${version ?? 'unknown'}`.slice(0, 40), value });
    const floor = minimum[platform];
    if (floor && version && compareMeetVersions(version, floor) === -1) outdated += value;
  }

  const p = first(people);
  const s = first(signins);
  const d = first(devices);
  const c = first(connections);
  const h = first(health);
  const windows = (dayValue: unknown, weekValue: unknown, monthValue: unknown): OpsWindows =>
    ({ day: n(dayValue), week: n(weekValue), month: n(monthValue) });
  // A plan row nobody can read is reported as such, not as the default.
  let planId: string;
  try {
    planId = parsePlanRow(rows(plan)[0] as { value: string } | undefined).plan;
  } catch {
    planId = 'unreadable';
  }

  // History and activation are read on their own: a failure leaves them
  // empty and keeps the rest of the block.
  const history = await readOpsHistory(db, now).catch(() => []);
  const activation = await readActivation(env, history, now).catch(() => null);

  return opsProductSchema.parse({
    plan: planId,
    suite: await workspaceSuite(env),
    work_modules: await workModulesOn(env),
    features: await Promise.all(OPS_FEATURES.map(async ({ key }) => ({ key, on: await FEATURE_ON[key](env) }))),
    people: { admins: n(p.admins), community: n(p.community), revoked: n(p.revoked), joined_30d: n(p.joined_30d) },
    active: windows(p.active_day, p.active_week, p.active_month),
    active_clients: tallies(activeClients, 8),
    signins: windows(s.day, s.week, s.month),
    signin_clients: tallies(signinClients, 8),
    devices: { total: n(d.total), active_30d: n(d.active), outdated },
    device_platforms: [...platformCounts].map(([key, value]) => ({ key: key.slice(0, 40), value })).sort((a, b) => b.value - a.value).slice(0, 8),
    app_versions: versionCounts.slice(0, 30),
    connections: { calendar: n(c.calendar), mcp_grants: n(c.mcp_grants), mcp_active_30d: n(c.mcp_active) },
    health: { errors_7d: n(h.errors), failures_7d: n(h.failures), dead_jobs: n(h.dead_jobs) },
    daily,
    history,
    activation,
  });
}
