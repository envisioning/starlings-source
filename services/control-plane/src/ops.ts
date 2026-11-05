// Operational alerts (docs/OPERATIONS.md §Alerts).
//
// Cloudflare samples Worker logs per request, not per level, so an error line
// is kept about one time in a hundred. Configuration cannot change that. The
// Worker therefore counts its own failures in D1 (`ops_failures`), and the
// five-minute cron mails a person from those rows through Postmark.
//
// More sources feed the same count: the dead-letter consumer (`dead_job`),
// the hourly deploy check (`deploy_stale`), the hourly release check
// (`release_stale`), the daily TestFlight check (`testflight_stale`), every scheduled or queued step
// that fails, and, since, three signals about the Worker's own
// doors: a signed call refused (`inbound_signature`), Core's events gone
// quiet (`core_events_silent`), and a route answering 5xx (`route_5xx`).

import { PRODUCT_SITE_ORIGIN } from '@starlings/contracts/deployment';
import type { OpsFailureRow } from '@starlings/contracts';
import { z } from 'zod';
import { BUILD_COMMIT } from './build-info';
import { controlPlaneJobSchema, type ControlPlaneJob } from './contracts';
import { GithubError } from './github-app';
import { hasSharedSecret, sharedSecret } from './shared-secrets';
import { sendMail } from './mail';
import { readUpstreamJson } from './upstream';

/** One mail per kind per this long. */
export const ALERT_INTERVAL_MS = 6 * 60 * 60_000;
/** `main` may be ahead of the deployed commit this long before it is a failure. */
export const DEPLOY_STALE_MS = 45 * 60_000;
/** The queue whose notes and backup messages failed every retry (`wrangler.jsonc`). */
export const DEAD_JOBS_QUEUE = 'meet-artifact-jobs-dead';
/** The same for the imports' queue. Both are shelved into D1 `dead_jobs`. */
export const DEAD_IMPORT_JOBS_QUEUE = 'meet-import-jobs-dead';

/** Jobs that read an outside service page by page: Granola, GitHub, Slack. They have their own queue. */
const IMPORT_JOB_KINDS: ReadonlySet<string> = new Set(['granola', 'granola-page', 'granola-suggest', 'github-repo', 'slack-channel']);

export function isImportJob(job: ControlPlaneJob): boolean {
  return 'kind' in job && typeof job.kind === 'string' && IMPORT_JOB_KINDS.has(job.kind);
}
/** One `inbound_signature` row per caller per this long. */
export const INBOUND_REFUSAL_INTERVAL_MS = 10 * 60_000;
/** `recordInboundUse` writes at most this often per caller. */
export const INBOUND_USE_INTERVAL_MS = 60_000;
/** No accepted call from Core for this long is a failure. */
export const CORE_SILENCE_MS = 72 * 60 * 60_000;
/** The caller name Core's calls are counted under: a call that names no `sender`. */
export const CORE_CALLER = 'core';
/** 5xx on one route pattern in one hour, at or above which `route_5xx` is counted. */
export const ROUTE_5XX_THRESHOLD = 20;
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
/** The released Mac version may be this old before it is a failure. */
export const RELEASE_STALE_MS = 8 * DAY_MS;
/** What the app's updater polls; the `published` date in it is when the last release went out. */
export const RELEASE_FEED_URL = `${PRODUCT_SITE_ORIGIN}/updates/starlings.json`;
/** TestFlight expires a build at 90 days; this is the warning, 15 days ahead. */
export const TESTFLIGHT_STALE_DAYS = 75;
const APP_STORE_CONNECT_BUILDS_URL = 'https://api.appstoreconnect.apple.com/v1/builds';
/**
 * Kinds that show on Admin › Operations and are never mailed: they say a
 * check could not run. `deploy_check_skipped` is mailed: a deploy check that
 * never ran let every Workers Build fail for three days in October 2026 with
 * no mail.
 */
const UNMAILED_KINDS = new Set(['testflight_check_skipped']);
/**
 * A cron step that lost D1 twice in a row is counted as `d1_unreachable`, not
 * under its own kind: one D1 blip failed every step of a tick at once and
 * sent ten mails in October 2026. The kind is mailed only once a day holds
 * this many, about three whole ticks, so a blip shows on Admin › Operations
 * and an outage still reaches a person.
 */
export const D1_UNREACHABLE_KIND = 'd1_unreachable';
const MAIL_MIN_COUNT: Partial<Record<string, number>> = { [D1_UNREACHABLE_KIND]: 30 };
/** What D1 answers when the connection, not the statement, failed; Cloudflare asks callers to retry these. */
const TRANSIENT_D1 = /Network connection lost|storage caused object to be reset|reset because its code was updated|D1 DB is overloaded|Internal error in D1 DB storage/iu;

/** True when `error` is a D1 failure a retry can clear. */
export function isTransientD1Error(error: unknown): boolean {
  return error instanceof Error && TRANSIENT_D1.test(error.message);
}
/** The repository Workers Builds deploys from. */
const DEPLOY_REPO = 'envisioning/starlings';
const DETAIL_MAX = 200;
const DOC_URL = 'https://github.com/envisioning/starlings-source/blob/main/docs/OPERATIONS.md#alerts';

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** At most 200 characters, and no address: a detail is an id or a reason, never personal data. */
function cleanDetail(detail: string | undefined): string | null {
  if (!detail) return null;
  return detail.replace(/[^\s@]+@[^\s@]+/gu, '<address>').slice(0, DETAIL_MAX);
}

/**
 * Count one failure of `kind` for today (UTC). Best-effort: it never throws,
 * because it runs inside the catch of the step that failed, and a second
 * failure there must not hide the first.
 */
export async function recordFailure(env: Pick<Env, 'USAGE'>, kind: string, detail?: string, now = Date.now()): Promise<void> {
  try {
    await env.USAGE.prepare(
      `INSERT INTO ops_failures (kind, day, count, last_at, last_detail) VALUES (?1, ?2, 1, ?3, ?4)
       ON CONFLICT (kind, day) DO UPDATE SET
         count = count + 1,
         last_at = excluded.last_at,
         last_detail = COALESCE(excluded.last_detail, ops_failures.last_detail)`,
    ).bind(kind, utcDay(now), now, cleanDetail(detail)).run();
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      message: 'ops.failure.record.failed',
      kind,
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
  }
}

/**
 * The next step a mail names for a kind, beside the runbook link. The
 * `release_stale` mail is the reminder for the weekly standing release
 *: nothing starts a release on a schedule, so the mail asks MZ
 * to start one on the Mac.
 */
const ALERT_NEXT_STEP: Partial<Record<string, string>> = {
  deploy_check_skipped: [
    'Next step: this Worker cannot tell whether it runs the head of main, so a',
    'failing Workers Build goes unnoticed. Make a fine-grained GitHub token with',
    'Contents: read on envisioning/starlings, and set it once in the Secrets Store',
    'starlings-shared as GITHUB_DEPLOY_CHECK_TOKEN (docs/PROVISIONING.md, Shared keys).',
  ].join('\n'),
  deploy_stale: [
    'Next step: main is ahead of this Worker. Open the latest Workers Builds',
    'check for this Worker on main and read its build log in the dashboard: it runs on Linux, so a',
    'macOS-only script passes the land queue and fails here (docs/agents/areas/worker.md).',
  ].join('\n'),
  release_stale: [
    'Next step: the weekly standing release is due. On the Mac that ships,',
    'run `./scripts/cut-release.sh --dry-run`, then `pnpm release`, or tell a',
    'session there to ship. It ships only a commit whose Workers Builds',
    'check for Envisioning is green. Then dispatch the iOS job on the new tag.',
  ].join('\n'),
};

interface FailureRow {
  kind: string;
  day: string;
  count: number;
  last_at: number;
  last_detail: string | null;
}

/**
 * Mail `OPS_ALERT_EMAIL` about each kind that failed since its last mail,
 * at most once per kind per six hours. Unset means no mail. A kind is marked
 * as sent only after Postmark accepts the mail, so a refused mail is tried
 * again on the next tick. Answers the kinds it mailed.
 */
export async function sendDueAlerts(env: Env, now = Date.now()): Promise<string[]> {
  const to = env.OPS_ALERT_EMAIL?.trim();
  if (!to) return [];
  const today = utcDay(now);
  const yesterday = utcDay(now - 24 * 60 * 60_000);
  const [{ results: failures }, { results: alerts }] = await Promise.all([
    env.USAGE.prepare(
      'SELECT kind, day, count, last_at, last_detail FROM ops_failures WHERE day >= ?1',
    ).bind(yesterday).all<FailureRow>(),
    env.USAGE.prepare('SELECT kind, sent_at FROM ops_alerts').all<{ kind: string; sent_at: number }>(),
  ]);
  const sentAt = new Map(alerts.map((row) => [row.kind, row.sent_at]));
  const byKind = new Map<string, FailureRow[]>();
  for (const row of failures) byKind.set(row.kind, [...(byKind.get(row.kind) ?? []), row]);

  const mailed: string[] = [];
  for (const [kind, rows] of [...byKind].sort(([a], [b]) => a.localeCompare(b))) {
    if (UNMAILED_KINDS.has(kind)) continue;
    const last = rows.reduce((latest, row) => (row.last_at > latest.last_at ? row : latest));
    const previous = sentAt.get(kind) ?? 0;
    if (last.last_at <= previous || now - previous < ALERT_INTERVAL_MS) continue;
    const countOn = (day: string) => rows.find((row) => row.day === day)?.count ?? 0;
    if (countOn(today) < (MAIL_MIN_COUNT[kind] ?? 0)) continue;
    const text = [
      `Starlings counted failures of ${kind}.`,
      '',
      `Today (${today} UTC): ${countOn(today)}`,
      `Yesterday (${yesterday} UTC): ${countOn(yesterday)}`,
      `Last: ${new Date(last.last_at).toISOString()}${last.last_detail ? `, ${last.last_detail}` : ''}`,
      '',
      ...(ALERT_NEXT_STEP[kind] ? [ALERT_NEXT_STEP[kind], ''] : []),
      `What to do: docs/OPERATIONS.md, section Alerts.`,
      DOC_URL,
      '',
      `The next mail about ${kind} comes no sooner than six hours after this one.`,
    ].join('\n');
    try {
      const sent = await sendMail(env, { to, subject: `Starlings: ${kind} failing`, text });
      if (!sent) return mailed;
      await env.USAGE.prepare(
        'INSERT INTO ops_alerts (kind, sent_at) VALUES (?1, ?2) ON CONFLICT (kind) DO UPDATE SET sent_at = excluded.sent_at',
      ).bind(kind, now).run();
      mailed.push(kind);
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error',
        message: 'ops.alert.send.failed',
        kind,
        error: error instanceof Error ? error.message : 'Unknown error',
      }));
    }
  }
  return mailed;
}

// -------------------------------------------------------- inbound doors

/**
 * A signed call to an inbound route was refused for its signature.
 * `reason` is `mismatch` or `expired`, and since `identity` (a real
 * key asked for an identity it does not carry) or `unknown_key` (a key id
 * nobody provisioned); a request with no signature at all is a probe, not a
 * drifted secret, and is not counted. One `inbound_signature`
 * failure per caller per ten minutes, decided by the one statement that
 * writes the refusal time, so a flood cannot fill the table. `caller` is a
 * route or a roster agent, never text the caller chose. Best-effort.
 */
export async function recordInboundRefusal(
  env: Pick<Env, 'USAGE'>,
  caller: string,
  reason: 'mismatch' | 'expired' | 'identity' | 'unknown_key',
  now = Date.now(),
): Promise<void> {
  try {
    const written = await env.USAGE.prepare(
      `INSERT INTO ops_inbound (caller, first_seen_at, last_refused_at) VALUES (?1, ?2, ?2)
       ON CONFLICT (caller) DO UPDATE SET last_refused_at = excluded.last_refused_at
       WHERE ops_inbound.last_refused_at IS NULL OR ops_inbound.last_refused_at <= ?3`,
    ).bind(caller, now, now - INBOUND_REFUSAL_INTERVAL_MS).run();
    if (!written.meta.changes) return;
    await recordFailure(env, 'inbound_signature', `${caller}: ${reason}`, now);
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      message: 'ops.inbound.refusal.failed',
      caller,
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
  }
}

/**
 * A signed call from `caller` was accepted with its own key id.
 * The `last_legacy_at` column stays for history: the old shared secret that
 * wrote it was removed on 2026-10-06. At most one write a minute
 * per caller; answers whether it wrote. Best-effort.
 */
export async function recordInboundUse(
  env: Pick<Env, 'USAGE'>,
  caller: string,
  now = Date.now(),
): Promise<boolean> {
  try {
    const written = await env.USAGE.prepare(
      `INSERT INTO ops_inbound (caller, first_seen_at, last_keyed_at) VALUES (?1, ?2, ?2)
       ON CONFLICT (caller) DO UPDATE SET last_keyed_at = excluded.last_keyed_at
       WHERE ops_inbound.last_keyed_at IS NULL OR ops_inbound.last_keyed_at <= ?3`,
    ).bind(caller, now, now - INBOUND_USE_INTERVAL_MS).run();
    return written.meta.changes > 0;
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      message: 'ops.inbound.use.failed',
      caller,
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
    return false;
  }
}

/** A signed call from `caller` was accepted: the time the silence check reads. Best-effort. */
export async function recordInboundAccepted(env: Pick<Env, 'USAGE'>, caller: string, now = Date.now()): Promise<void> {
  try {
    await env.USAGE.prepare(
      `INSERT INTO ops_inbound (caller, first_seen_at, last_accepted_at) VALUES (?1, ?2, ?2)
       ON CONFLICT (caller) DO UPDATE SET last_accepted_at = excluded.last_accepted_at`,
    ).bind(caller, now).run();
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      message: 'ops.inbound.accepted.failed',
      caller,
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
  }
}

/**
 * Core's events stopped reaching Meet for about two weeks in September 2026
 * because of a secret mismatch, and nothing said so. The hourly cron calls
 * this: when no accepted call from Core has arrived in 72 hours, count
 * `core_events_silent`. Before the first accepted call is on record the
 * baseline is the first time this table saw Core, which the check itself
 * writes, so a fresh deploy waits 72 hours before it can say anything.
 * Answers whether it counted a failure.
 */
export async function checkCoreSilence(env: Pick<Env, 'USAGE'>, now = Date.now()): Promise<boolean> {
  await env.USAGE.prepare(
    'INSERT INTO ops_inbound (caller, first_seen_at) VALUES (?1, ?2) ON CONFLICT (caller) DO NOTHING',
  ).bind(CORE_CALLER, now).run();
  const row = await env.USAGE.prepare('SELECT first_seen_at, last_accepted_at FROM ops_inbound WHERE caller = ?1')
    .bind(CORE_CALLER).first<{ first_seen_at: number; last_accepted_at: number | null }>();
  if (!row) return false;
  const since = row.last_accepted_at ?? row.first_seen_at;
  if (now - since <= CORE_SILENCE_MS) return false;
  const hours = Math.floor((now - since) / HOUR_MS);
  await recordFailure(env, 'core_events_silent', row.last_accepted_at ? `${hours} h since the last call` : `no call in ${hours} h`, now);
  return true;
}

/**
 * Count `route_5xx` for each route pattern that answered 5xx at least
 * `ROUTE_5XX_THRESHOLD` times in the current or the last hour (the tick that
 * runs it is the first of an hour, so the hour that just ended is the one that
 * matters). Also drops hours older than two days. Answers the patterns it
 * counted.
 */
export async function checkRoute5xx(env: Pick<Env, 'USAGE'>, now = Date.now()): Promise<string[]> {
  const hour = Math.floor(now / HOUR_MS);
  const { results } = await env.USAGE.prepare(
    `SELECT route, MAX(count) AS count FROM ops_route_5xx_hourly
     WHERE hour >= ?1 GROUP BY route HAVING MAX(count) >= ?2 ORDER BY route`,
  ).bind(hour - 1, ROUTE_5XX_THRESHOLD).all<{ route: string; count: number }>();
  for (const row of results) await recordFailure(env, 'route_5xx', `${row.route} x${row.count}`, now);
  await env.USAGE.prepare('DELETE FROM ops_route_5xx_hourly WHERE hour < ?1').bind(hour - 48).run();
  return results.map((row) => row.route);
}

/** What Admin › Operations lists: every failure kind counted in the last seven UTC days. */
export async function recentFailures(env: Pick<Env, 'USAGE'>, now = Date.now()): Promise<OpsFailureRow[]> {
  const since = utcDay(now - 6 * 24 * 60 * 60_000);
  const [{ results }, { results: alerts }] = await Promise.all([
    env.USAGE.prepare(
      `SELECT f.kind AS kind,
              SUM(CASE WHEN f.day = ?2 THEN f.count ELSE 0 END) AS count_today,
              SUM(f.count) AS count_7d,
              MAX(f.last_at) AS last_at,
              (SELECT g.last_detail FROM ops_failures g WHERE g.kind = f.kind AND g.day >= ?1
               ORDER BY g.last_at DESC LIMIT 1) AS last_detail
       FROM ops_failures f WHERE f.day >= ?1 GROUP BY f.kind ORDER BY MAX(f.last_at) DESC LIMIT 50`,
    ).bind(since, utcDay(now)).all<Omit<OpsFailureRow, 'mailed'>>(),
    env.USAGE.prepare('SELECT kind, sent_at FROM ops_alerts').all<{ kind: string; sent_at: number }>(),
  ]);
  const sentAt = new Map(alerts.map((row) => [row.kind, row.sent_at]));
  return results.map((row) => ({
    ...row,
    mailed: !UNMAILED_KINDS.has(row.kind) && (sentAt.get(row.kind) ?? 0) >= row.last_at,
  }));
}

/** When Core's last call was accepted, or null if none is on record. */
export async function coreLastAccepted(env: Pick<Env, 'USAGE'>): Promise<number | null> {
  const row = await env.USAGE.prepare('SELECT last_accepted_at FROM ops_inbound WHERE caller = ?1')
    .bind(CORE_CALLER).first<{ last_accepted_at: number | null }>();
  return row?.last_accepted_at ?? null;
}

// ------------------------------------------------------------ dead jobs

/** The one field a queue message needs from the dead-letter batch. */
interface DeadMessage {
  id: string;
  body: unknown;
  ack(): void;
  retry(options?: QueueRetryOptions): void;
}

function jobKind(body: unknown): string {
  const kind = (body as { kind?: unknown } | null)?.kind;
  return typeof kind === 'string' ? kind : 'artifact';
}

/**
 * The dead-letter consumer. Each message body goes into `dead_jobs` and the
 * message is acked, so the job is kept until an admin replays it. A message
 * whose row cannot be written is retried, not acked: nothing is dropped.
 */
export async function shelveDeadJobs(messages: readonly DeadMessage[], env: Env, now = Date.now()): Promise<void> {
  for (const message of messages) {
    try {
      await env.USAGE.prepare('INSERT OR IGNORE INTO dead_jobs (id, received_at, body) VALUES (?1, ?2, ?3)')
        .bind(message.id, now, JSON.stringify(message.body)).run();
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error',
        message: 'dead_job.store.failed',
        error: error instanceof Error ? error.message : 'Unknown error',
      }));
      message.retry({ delaySeconds: 300 });
      continue;
    }
    message.ack();
    console.error(JSON.stringify({ level: 'error', message: 'dead_job.received', kind: jobKind(message.body) }));
    await recordFailure(env, 'dead_job', jobKind(message.body), now);
  }
}

export async function deadJobSummary(env: Env): Promise<{ count: number; oldest_at: number | null }> {
  const row = await env.USAGE.prepare('SELECT COUNT(*) AS count, MIN(received_at) AS oldest_at FROM dead_jobs')
    .first<{ count: number; oldest_at: number | null }>();
  return { count: row?.count ?? 0, oldest_at: row?.oldest_at ?? null };
}

/** Rows one replay reads. Five `sendBatch` calls of 100. */
const REPLAY_LIMIT = 500;

/**
 * Every dead job, sent on the live queue again, oldest first. A row is
 * deleted only after its batch is sent. A body that is not a job the queue
 * carries stays in the table, so the count on Admin says it is still there.
 */
export async function replayDeadJobs(env: Env): Promise<number> {
  const { results } = await env.USAGE.prepare(
    'SELECT id, body FROM dead_jobs ORDER BY received_at LIMIT ?1',
  ).bind(REPLAY_LIMIT).all<{ id: string; body: string }>();
  const ready: Array<{ id: string; job: ControlPlaneJob }> = [];
  for (const row of results) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.body);
    } catch {
      continue;
    }
    const job = controlPlaneJobSchema.safeParse(parsed);
    if (job.success) ready.push({ id: row.id, job: job.data });
  }
  let queued = 0;
  for (let start = 0; start < ready.length; start += 100) {
    const slice = ready.slice(start, start + 100);
    // Each job goes back on the queue it came from.
    const imports = slice.filter((row) => isImportJob(row.job));
    const rest = slice.filter((row) => !isImportJob(row.job));
    if (imports.length > 0) await env.IMPORT_JOBS.sendBatch(imports.map((row) => ({ body: row.job })));
    if (rest.length > 0) await env.ARTIFACT_JOBS.sendBatch(rest.map((row) => ({ body: row.job })));
    await env.USAGE.batch(slice.map((row) => env.USAGE.prepare('DELETE FROM dead_jobs WHERE id = ?1').bind(row.id)));
    queued += slice.length;
  }
  return queued;
}

// -------------------------------------------------------- deploy check

const compareSchema = z.looseObject({
  status: z.string(),
  ahead_by: z.number(),
  commits: z.array(z.looseObject({
    sha: z.string(),
    commit: z.looseObject({ committer: z.looseObject({ date: z.string() }).nullish() }),
  })),
});

/**
 * Why the deploy check cannot run, or null when it can. `GITHUB_DEPLOY_CHECK_TOKEN`
 * is a fine-grained token with Contents: read on the repository, which is
 * private, so the public commit API does not answer without one. The
 * Starlings GitHub App does not: its installation is the workspace's own
 * account, which need not see envisioning/starlings. A build that did not
 * record its commit has nothing to compare and is not a configuration gap.
 */
export function deployCheckBlocker(env: Env, deployed = BUILD_COMMIT): string | null {
  if (!deployed || deployed === 'unknown') return null;
  if (hasSharedSecret(env, 'GITHUB_DEPLOY_CHECK_TOKEN')) return null;
  return 'no GITHUB_DEPLOY_CHECK_TOKEN';
}

async function githubCompareResponse(env: Env, deployed: string): Promise<Response> {
  const path = `/repos/${DEPLOY_REPO}/compare/${encodeURIComponent(deployed)}...main`;
  const token = await sharedSecret(env, 'GITHUB_DEPLOY_CHECK_TOKEN');
  if (!token) throw new GithubError('The deploy check has no GitHub token.', 503);
  return fetch(`https://api.github.com${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'meet-control-plane',
    },
    signal: AbortSignal.timeout(15_000),
  });
}

/**
 * Whether `main` is ahead of the commit this Worker was built from for more
 * than 45 minutes. Workers Builds failed for two days in September 2026 and
 * nobody noticed (AGENTS.md, "The Worker ships on push"). Skipped when the
 * build did not record its commit or no GitHub credential is configured
 * (`deployCheckBlocker`); the caller counts a skip once a day so it shows on
 * Admin › Operations.
 *
 * The age is the committer date of the oldest commit not deployed. That is
 * when the commit was made, which is at or before the push.
 */
export async function checkDeployStale(env: Env, now = Date.now(), deployed = BUILD_COMMIT): Promise<'fresh' | 'stale' | 'skipped'> {
  if (!deployed || deployed === 'unknown' || deployCheckBlocker(env, deployed)) return 'skipped';
  const response = await githubCompareResponse(env, deployed);
  if (!response.ok) throw new GithubError(`GitHub answered ${response.status} for the deploy check.`, 502);
  const compare = await readUpstreamJson(response, compareSchema, {
    source: 'github', route: 'GET /repos/:owner/:repo/compare/:base...:head', error: GithubError,
  });
  if (compare.ahead_by === 0 || compare.status === 'identical' || compare.status === 'behind') return 'fresh';
  const oldest = compare.commits[0];
  const head = compare.commits.at(-1);
  const madeAt = oldest?.commit.committer?.date ? Date.parse(oldest.commit.committer.date) : Number.NaN;
  if (!Number.isFinite(madeAt) || now - madeAt <= DEPLOY_STALE_MS) return 'fresh';
  await recordFailure(env, 'deploy_stale', head?.sha ?? oldest?.sha, now);
  return 'stale';
}

/** True on the one five-minute tick in the first five minutes of each hour. */
export function isHourlyTick(scheduledTime: number): boolean {
  return new Date(scheduledTime).getUTCMinutes() < 5;
}

// -------------------------------------------------------- release check

const releaseFeedSchema = z.looseObject({
  version: z.string().min(1),
  published: z.string().min(1),
});

/** The Mac release the feed advertises, and how long ago it went out. */
export interface ReleaseAge {
  version: string;
  published_at: number;
  age_days: number;
}

/**
 * Read the update feed the apps poll. Throws when it cannot be read or is not
 * a feed: a check that cannot see the feed is not a pass, and the callers say so.
 */
export async function readReleaseFeed(now = Date.now(), fetchImpl: typeof fetch = fetch): Promise<ReleaseAge> {
  const response = await fetchImpl(RELEASE_FEED_URL, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`The update feed answered ${response.status}.`);
  const feed = releaseFeedSchema.parse(await response.json());
  const publishedAt = Date.parse(feed.published);
  if (!Number.isFinite(publishedAt)) throw new Error('The update feed has no readable published date.');
  return { version: feed.version, published_at: publishedAt, age_days: (now - publishedAt) / DAY_MS };
}

/**
 * Whether the released Mac version is more than eight days old.
 * The apps were stuck on 4.4.3 for a week in September 2026 because nothing
 * compared the feed with `main`; releases are cut by hand, so the age of the
 * last one is the signal. Counts one `release_stale` failure per run while it
 * holds; `sendDueAlerts` mails it, at most every six hours. Throws when the
 * feed cannot be read; the cron logs that.
 */
export async function checkReleaseStale(
  env: Pick<Env, 'USAGE'>,
  now = Date.now(),
  fetchImpl: typeof fetch = fetch,
): Promise<'fresh' | 'stale'> {
  const release = await readReleaseFeed(now, fetchImpl);
  if (now - release.published_at <= RELEASE_STALE_MS) return 'fresh';
  await recordFailure(env, 'release_stale', `Starlings ${release.version} is ${Math.floor(release.age_days)} days old`, now);
  return 'stale';
}

// -------------------------------------------------------- TestFlight check

/**
 * Why the TestFlight check cannot run, or null when it can. The four values
 * are the App Store Connect API key (`.p8` text), its id, the issuer and the
 * app, under the names the `testflight-age` workflow reads them by.
 */
export function testflightCheckBlocker(env: Pick<Env, 'APPLE_API_KEY' | 'APPLE_API_KEY_ID' | 'APPLE_API_ISSUER_ID' | 'ASC_APP_ID'>): string | null {
  const missing = (['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER_ID', 'ASC_APP_ID'] as const)
    .filter((name) => !env[name]?.trim());
  return missing.length ? `no ${missing.join(', ')}` : null;
}

function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of array) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/** An App Store Connect API token: ES256, ten minutes. WebCrypto signs ECDSA as r||s, which is what JWT wants. */
async function appStoreConnectToken(env: Pick<Env, 'APPLE_API_KEY' | 'APPLE_API_KEY_ID' | 'APPLE_API_ISSUER_ID'>, now: number): Promise<string> {
  const pem = env.APPLE_API_KEY!.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), (char) => char.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const text = new TextEncoder();
  const issuedAt = Math.floor(now / 1000);
  const header = base64Url(text.encode(JSON.stringify({ alg: 'ES256', kid: env.APPLE_API_KEY_ID!.trim(), typ: 'JWT' })));
  const payload = base64Url(text.encode(JSON.stringify({
    iss: env.APPLE_API_ISSUER_ID!.trim(),
    iat: issuedAt,
    exp: issuedAt + 600,
    aud: 'appstoreconnect-v1',
  })));
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, text.encode(`${header}.${payload}`));
  return `${header}.${payload}.${base64Url(signature)}`;
}

const buildsSchema = z.looseObject({
  data: z.array(z.looseObject({
    attributes: z.looseObject({ version: z.string(), uploadedDate: z.string() }),
  })),
});

/**
 * Whether the newest TestFlight build of the app was uploaded more than 75
 * days ago: TestFlight expires a build at 90. This is
 * the `testflight-age` workflow's check run from the Worker's cron, because
 * that workflow cannot start while the organisation is over its Actions
 * budget (it failed 4 of 4 runs for that reason). Counts one
 * `testflight_stale` failure per run while it holds. Skipped, and counted as
 * `testflight_check_skipped` by the caller, when the Apple values are not set.
 * Throws when App Store Connect cannot be read or answers no build.
 */
export async function checkTestflightStale(
  env: Env,
  now = Date.now(),
  fetchImpl: typeof fetch = fetch,
): Promise<'fresh' | 'stale' | 'skipped'> {
  if (testflightCheckBlocker(env)) return 'skipped';
  const url = new URL(APP_STORE_CONNECT_BUILDS_URL);
  url.searchParams.set('filter[app]', env.ASC_APP_ID!.trim());
  url.searchParams.set('sort', '-uploadedDate');
  url.searchParams.set('limit', '1');
  const response = await fetchImpl(url, {
    headers: { authorization: `Bearer ${await appStoreConnectToken(env, now)}`, accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`App Store Connect answered ${response.status} for the newest build.`);
  const build = buildsSchema.parse(await response.json()).data[0];
  if (!build) throw new Error('App Store Connect returned no build for this app.');
  const uploadedAt = Date.parse(build.attributes.uploadedDate);
  if (!Number.isFinite(uploadedAt)) throw new Error('The newest build has an unreadable uploadedDate.');
  const ageDays = (now - uploadedAt) / DAY_MS;
  if (ageDays <= TESTFLIGHT_STALE_DAYS) return 'fresh';
  await recordFailure(env, 'testflight_stale', `build ${build.attributes.version} is ${Math.floor(ageDays)} days old`, now);
  return 'stale';
}
