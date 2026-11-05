// Privacy-safe operational error events. Unlike MetricKit's
// diagnostics table, this stores only bounded dimensions and daily counts.
// `operationForRequest` is shared with the web reporter.
import {
  OPERATIONAL_ERROR_OVERVIEW_REQUEST_IDS,
  OPERATIONAL_ERROR_RETENTION_DAYS,
  OPERATIONAL_ERROR_WINDOW_DAYS,
  operationForRequest,
  type OperationalErrorEvent,
  type OperationalErrorGroup,
  type OperationalErrorOverview,
  type OperationalErrorOverviewQuery,
} from './contracts';
import { BUILD_COMMIT } from './build-info';

const RETENTION_DAYS = OPERATIONAL_ERROR_RETENTION_DAYS;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60_000;
const REQUEST_ID_SAMPLE_SIZE = 5;
const ACTIONABLE_SERVER_CODES = new Set([
  'calendar_expired', 'calendar_failed', 'oauth_failed', 'upstream_shape', 'internal_error',
]);

/**
 * What the Worker stores beside a client-shaped event: the route pattern a
 * 5xx came from. Never part of the wire schema, so a client cannot
 * upload one.
 */
export type WorkerErrorEvent = OperationalErrorEvent & { route?: string };

type EventSource = OperationalErrorEvent['source'];
type EventCode = OperationalErrorEvent['code'];
type EventClass = OperationalErrorEvent['error_class'];

interface EventAggregate {
  day: string;
  fingerprint: string;
  event: WorkerErrorEvent;
  count: number;
  firstAt: number;
  lastAt: number;
  requestIds: Set<string>;
  maxRetry: number;
}

/**
 * A guest's `release` is client text, and it is part of the fingerprint: a
 * script rotating it would make a new row per request, and it could carry
 * prose. The Worker serves the guest page, so the served build names it.
 */
export function guestEventsAtServedRelease<Event extends { release: string }>(events: readonly Event[]): Event[] {
  return events.map((event) => ({ ...event, release: BUILD_COMMIT }));
}

/** The Worker boundary keeps normal 4xx/user outcomes out of the error stream. */
export function shouldCaptureWorkerFailure(status: number, code: string): boolean {
  return status >= 500 || code === 'calendar_expired';
}

/** A path segment that names a kind of thing, not one of them: lowercase words only. */
const WORD_SEGMENT = /^[a-z][a-z_-]{0,29}$/u;
/** Segments after which the next one is a slug, even when it reads like a word. */
const SLUG_AFTER = new Set(['rooms', 'room', 'book', 'bookings', 'u']);
const ROUTE_MAX_SEGMENTS = 7;
const ROUTE_MAX_LENGTH = 100;

/**
 * The route a request took, as a pattern: `POST /api/threads/:id/messages`,
 * never the raw path. A segment stays only when it is a lowercase word, the
 * name of a thing; every id, slug, address or token becomes `:id`, so the set
 * of patterns is the set of routes and a crawler cannot grow it. Bounded in
 * depth and length for the same reason.
 */
export function routePattern(method: string, pathname: string): string {
  const segments = pathname.split('/').filter(Boolean).slice(0, ROUTE_MAX_SEGMENTS);
  const pattern: string[] = [];
  let previous = '';
  for (const segment of segments) {
    const word = WORD_SEGMENT.test(segment) && !SLUG_AFTER.has(previous);
    pattern.push(word ? segment : ':id');
    previous = segment;
  }
  return `${method.toUpperCase().slice(0, 7)} /${pattern.join('/')}`.slice(0, ROUTE_MAX_LENGTH);
}

/** A failed request is normalized before it enters D1: no URL, path, message or payload. */
export function workerErrorEvent(input: {
  requestId: string;
  pathname: string;
  status: number;
  code: string;
  method?: string;
}): WorkerErrorEvent {
  const serverCode = ACTIONABLE_SERVER_CODES.has(input.code)
    ? input.code as NonNullable<OperationalErrorEvent['server_code']>
    : undefined;
  const code: EventCode = input.code === 'calendar_expired'
    ? 'calendar_expired'
    : input.code === 'calendar_failed'
      ? 'calendar_failed'
      : input.code === 'oauth_failed'
        ? 'oauth_failed'
        : input.code === 'upstream_shape'
          ? 'worker.upstream_shape'
          : 'worker.internal_error';
  const errorClass: EventClass = input.code === 'calendar_expired' || input.code === 'oauth_failed'
    ? 'authorization'
    : input.code === 'calendar_failed' || input.code === 'upstream_shape'
      ? 'upstream'
      : 'internal';
  return {
    event_id: crypto.randomUUID(),
    source: 'worker' satisfies EventSource,
    platform: 'cloudflare',
    release: BUILD_COMMIT,
    code,
    operation: operationForRequest(input.pathname),
    error_class: errorClass,
    http_status: input.status,
    ...(serverCode ? { server_code: serverCode } : {}),
    request_id: input.requestId,
    retry_count: 0,
    ...(input.method ? { route: routePattern(input.method, input.pathname) } : {}),
  };
}

/** Insert or increment aggregates atomically. Any caller decides whether failure is fatal. */
export async function recordOperationalErrors(
  env: Pick<Env, 'USAGE'>,
  events: readonly WorkerErrorEvent[],
  now = Date.now(),
): Promise<number> {
  if (!events.length) return 0;
  const day = new Date(now).toISOString().slice(0, 10);
  const groups = new Map<string, EventAggregate>();
  for (const event of events) {
    const dimensions = [
      event.source, event.platform, event.release, event.code, event.operation,
      event.error_class, event.http_status ?? null, event.server_code ?? null,
      // Appended only when present, so a client event keeps the fingerprint it always had.
      ...(event.route ? [event.route] : []),
    ];
    const fingerprint = await fingerprintFor(dimensions);
    const key = `${day}:${fingerprint}`;
    const group = groups.get(key);
    if (group) {
      group.count += 1;
      group.firstAt = Math.min(group.firstAt, now);
      group.lastAt = Math.max(group.lastAt, now);
      group.maxRetry = Math.max(group.maxRetry, event.retry_count);
      if (event.request_id && group.requestIds.size < REQUEST_ID_SAMPLE_SIZE) group.requestIds.add(event.request_id);
    } else {
      groups.set(key, {
        day,
        fingerprint,
        event,
        count: 1,
        firstAt: now,
        lastAt: now,
        requestIds: new Set(event.request_id ? [event.request_id] : []),
        maxRetry: event.retry_count,
      });
    }
  }

  const statements = [...groups.values()].map(({ day: eventDay, fingerprint, event, count, firstAt, lastAt, requestIds, maxRetry }) => (
    env.USAGE.prepare(
      `INSERT INTO operational_error_daily (
         day, fingerprint, source, platform, release, code, operation, error_class,
         http_status, server_code, count, first_at, last_at, max_retry_count, request_ids, route
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
       ON CONFLICT(day, fingerprint) DO UPDATE SET
         count = operational_error_daily.count + excluded.count,
         first_at = MIN(operational_error_daily.first_at, excluded.first_at),
         last_at = MAX(operational_error_daily.last_at, excluded.last_at),
         max_retry_count = MAX(operational_error_daily.max_retry_count, excluded.max_retry_count),
         request_ids = (
           SELECT json_group_array(value) FROM (
             SELECT value FROM json_each(operational_error_daily.request_ids)
             UNION
             SELECT value FROM json_each(excluded.request_ids)
             LIMIT ${REQUEST_ID_SAMPLE_SIZE}
           )
         )`,
    ).bind(
      eventDay,
      fingerprint,
      event.source,
      event.platform,
      event.release,
      event.code,
      event.operation,
      event.error_class,
      event.http_status ?? null,
      event.server_code ?? null,
      count,
      firstAt,
      lastAt,
      maxRetry,
      JSON.stringify([...requestIds].slice(0, REQUEST_ID_SAMPLE_SIZE)),
      event.route ?? null,
    )
  ));
  // Each 5xx by route and hour, which is what the hourly check reads (ops.ts).
  const hour = Math.floor(now / HOUR_MS);
  for (const { event, count } of groups.values()) {
    if (!event.route || (event.http_status ?? 0) < 500) continue;
    statements.push(env.USAGE.prepare(
      `INSERT INTO ops_route_5xx_hourly (hour, route, count) VALUES (?1, ?2, ?3)
       ON CONFLICT (hour, route) DO UPDATE SET count = count + excluded.count`,
    ).bind(hour, event.route, count));
  }
  await env.USAGE.batch(statements);
  return [...groups.values()].reduce((total, group) => total + group.count, 0);
}

/** Removes expired aggregates once daily (UTC), without touching MetricKit reports. */
export async function pruneOperationalErrors(env: Pick<Env, 'USAGE'>, now: number): Promise<number> {
  const before = now - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const result = await env.USAGE.prepare('DELETE FROM operational_error_daily WHERE last_at < ?1').bind(before).run();
  return result.meta.changes ?? 0;
}

interface OverviewRow {
  fingerprint: string;
  source: OperationalErrorGroup['source'];
  platform: OperationalErrorGroup['platform'];
  release: string;
  code: OperationalErrorGroup['code'];
  operation: OperationalErrorGroup['operation'];
  error_class: OperationalErrorGroup['error_class'];
  http_status: number | null;
  server_code: OperationalErrorGroup['server_code'];
  route: string | null;
  total: number;
  first_at: number;
  last_at: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function trendOf(count: number, previous: number | null): OperationalErrorGroup['trend'] {
  if (previous === null) return 'unknown';
  if (previous === 0) return 'new';
  if (count > previous) return 'up';
  if (count < previous) return 'down';
  return 'flat';
}

/**
 * The admin error overview: `operational_error_daily` grouped by
 * fingerprint over whole UTC days ending today, ranked by count, with each
 * group's count in the previous equal window. Reads only; never further back
 * than the retention, so a month has no previous window and its trend is
 * `unknown`. The answer names each column it returns, so a column added to
 * the table later does not reach an agent by accident.
 */
export async function operationalErrorOverview(
  env: Pick<Env, 'USAGE'>,
  query: OperationalErrorOverviewQuery,
  now = Date.now(),
): Promise<OperationalErrorOverview> {
  const days = OPERATIONAL_ERROR_WINDOW_DAYS[query.window];
  const toDay = utcDay(now);
  const fromDay = utcDay(now - (days - 1) * DAY_MS);
  const hasPrevious = days * 2 <= RETENTION_DAYS;
  const previous = hasPrevious
    ? { from_day: utcDay(now - (days * 2 - 1) * DAY_MS), to_day: utcDay(now - days * DAY_MS) }
    : null;

  const filters: string[] = [];
  const filterValues: string[] = [];
  for (const [column, value] of [['release', query.release], ['platform', query.platform], ['code', query.code]] as const) {
    if (value === undefined) continue;
    filterValues.push(value);
    filters.push(`${column} = ?${filterValues.length + 2}`);
  }
  const where = ['day BETWEEN ?1 AND ?2', ...filters].join(' AND ');
  const windowTotal = (from: string, to: string) => env.USAGE.prepare(
    `SELECT COALESCE(SUM(count), 0) AS count, COUNT(DISTINCT fingerprint) AS groups
       FROM operational_error_daily WHERE ${where}`,
  ).bind(from, to, ...filterValues);

  const [ranked, current, before] = await env.USAGE.batch([
    env.USAGE.prepare(
      `SELECT fingerprint, source, platform, release, code, operation, error_class, http_status, server_code, route,
              SUM(count) AS total, MIN(first_at) AS first_at, MAX(last_at) AS last_at
         FROM operational_error_daily WHERE ${where}
        GROUP BY fingerprint
        ORDER BY total DESC, last_at DESC, fingerprint
        LIMIT ?${filterValues.length + 3}`,
    ).bind(fromDay, toDay, ...filterValues, query.limit + 1),
    windowTotal(fromDay, toDay),
    ...(previous ? [windowTotal(previous.from_day, previous.to_day)] : []),
  ]);
  const rows = (ranked!.results as unknown as OverviewRow[]);
  const top = rows.slice(0, query.limit);
  const totals = current!.results[0] as { count: number; groups: number } | undefined;
  const previousTotal = before ? Number((before.results[0] as { count: number } | undefined)?.count ?? 0) : null;

  // Each returned group's days, newest first: its previous count and its
  // newest request ids. A fingerprint fixes every dimension, so the filters
  // are already in it.
  const perDay = new Map<string, { previous: number; requestIds: string[] }>();
  if (top.length) {
    const placeholders = top.map((_, index) => `?${index + 3}`).join(', ');
    const detail = await env.USAGE.prepare(
      `SELECT fingerprint, day, count, request_ids FROM operational_error_daily
        WHERE day BETWEEN ?1 AND ?2 AND fingerprint IN (${placeholders})
        ORDER BY day DESC, last_at DESC`,
    ).bind(previous?.from_day ?? fromDay, toDay, ...top.map((row) => row.fingerprint))
      .all<{ fingerprint: string; day: string; count: number; request_ids: string }>();
    for (const row of detail.results) {
      const entry = perDay.get(row.fingerprint) ?? { previous: 0, requestIds: [] };
      if (row.day < fromDay) {
        entry.previous += Number(row.count);
      } else if (entry.requestIds.length < OPERATIONAL_ERROR_OVERVIEW_REQUEST_IDS) {
        let ids: unknown = [];
        try {
          ids = JSON.parse(row.request_ids);
        } catch {
          ids = [];
        }
        for (const id of Array.isArray(ids) ? ids : []) {
          if (entry.requestIds.length >= OPERATIONAL_ERROR_OVERVIEW_REQUEST_IDS) break;
          if (typeof id === 'string' && UUID.test(id) && !entry.requestIds.includes(id)) entry.requestIds.push(id);
        }
      }
      perDay.set(row.fingerprint, entry);
    }
  }

  const groups: OperationalErrorGroup[] = top.map((row) => {
    const count = Number(row.total);
    const previousCount = previous ? perDay.get(row.fingerprint)?.previous ?? 0 : null;
    return {
      code: row.code,
      source: row.source,
      platform: row.platform,
      release: row.release,
      operation: row.operation,
      error_class: row.error_class,
      http_status: row.http_status ?? null,
      server_code: row.server_code ?? null,
      route: row.route ?? null,
      count,
      previous_count: previousCount,
      trend: trendOf(count, previousCount),
      first_at: new Date(Number(row.first_at)).toISOString(),
      last_at: new Date(Number(row.last_at)).toISOString(),
      request_ids: perDay.get(row.fingerprint)?.requestIds ?? [],
    };
  });

  return {
    window: query.window,
    days,
    from_day: fromDay,
    to_day: toDay,
    previous,
    retention_days: RETENTION_DAYS,
    filters: { release: query.release ?? null, platform: query.platform ?? null, code: query.code ?? null },
    total: { count: Number(totals?.count ?? 0), groups: Number(totals?.groups ?? 0), previous_count: previousTotal },
    groups,
    truncated: rows.length > query.limit,
    generated_at: new Date(now).toISOString(),
  };
}

async function fingerprintFor(dimensions: readonly (string | number | null)[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(dimensions));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
