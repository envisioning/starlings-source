import type { GuestOperationalErrorEvent, OperationalErrorEvent } from '@starlings/contracts';
import { operationForRequest } from '@starlings/contracts/operational-error-values';
import { parsePublicBookPath, parsePublicRoomPath } from '@starlings/contracts/paths';
import { apiBase, ControlRequestError } from './config';
import { readStored, StorageKeys } from './storage';

/**
 * The web half of the operational error stream: the
 * same fixed event the Mac and iOS send (`StarlingsOperationalErrorFactory`),
 * classified here and delivered best-effort to the Worker intake.
 *
 * What leaves the tab is only the allowlisted contract: code, operation,
 * class, HTTP status, server code and request id. Never an error message,
 * stack, URL, query string, room, name, email or body. The queue lives in
 * memory only; nothing is written to storage.
 *
 * Not reported: an abort or timeout the caller chose, a 4xx (validation,
 * refusal, an ended meeting, a lost lobby seat), a failed background read,
 * and a failure of this reporter's own delivery.
 */

type Audience = 'owner' | 'guest';
type OwnerEvent = OperationalErrorEvent;
type GuestEvent = GuestOperationalErrorEvent;

type Queued = { audience: Audience; fingerprint: string; event: OwnerEvent | GuestEvent };

/** Same window as the native spool: a repeat inside it only counts up. */
const DEDUPLICATION_MS = 30_000;
/** A tab that fails in a loop stops reporting; the first ones say enough. */
const MAX_EVENTS_PER_DOCUMENT = 30;
const MAX_QUEUED = 20;
const BATCH_SIZE: Record<Audience, number> = { owner: 10, guest: 3 };
const FLUSH_DELAY_MS = 2_000;
/** Bounded retry: three sends in all, then the batch is dropped. */
const RETRY_DELAYS_MS = [30_000, 60_000];
const RELEASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+() _-]{0,39}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** The guest door's two writes; every other guest request is a poll or a beat. */
const GUEST_JOIN = /^\/rooms\/[^/]+\/join-requests$/u;
const GUEST_EXCHANGE = /^\/rooms\/[^/]+\/join-requests\/[^/]+\/exchange$/u;
/**
 * Names, never messages, of failures that are a choice or a room
 * transition: a cancelled request, a refused permission, and LiveKit's
 * connection errors when a meeting ends or a guest rejoins.
 */
const EXPECTED_NAMES = new Set([
  'AbortError', 'TimeoutError', 'NotAllowedError',
  'ConnectionError', 'SignalReconnectError', 'UnexpectedConnectionState', 'NegotiationError',
]);

let queue: Queued[] = [];
let lastSeen = new Map<string, number>();
let reported = 0;
let refused: Record<Audience, boolean> = { owner: false, guest: false };
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let attempts = 0;
let flushing = false;
/** Failures already counted (or deliberately not) at the API path. */
let seen = new WeakSet<object>();

/** Set by `installOperationalErrorCapture` from the build stamp. */
let release = '0.0.0';

/** A member browser reports as its owner; any other is an anonymous guest. Same hint as `wasMember()`. */
function audience(): Audience {
  return readStored(StorageKeys.memberHint) === '1' ? 'owner' : 'guest';
}

export type ApiFailure = { method: string; path: string; decode?: boolean };

/**
 * Called by `api.ts` for every failed control-plane request. `error` is the
 * thrown fetch error or the `ControlRequestError`; only its status, code and
 * request id are read.
 */
export function reportApiFailure(request: ApiFailure, error: unknown): void {
  try {
    if (error && typeof error === 'object') seen.add(error);
    const classified = classifyApiFailure(request, error, audience());
    if (classified) enqueue(classified);
  } catch {
    // The reporter never becomes a failure of its own.
  }
}

/** React's root `onCaughtError` / `onUncaughtError`: a render a boundary caught, or one nothing did. */
export function reportRenderFailure(error: unknown): void {
  try {
    if (error && typeof error === 'object') {
      if (seen.has(error)) return;
      seen.add(error);
    }
    const classified = classifyPageFailure('web.render_failed', error, audience(), currentPath());
    if (classified) enqueue(classified);
  } catch {
    // As above.
  }
}

type PageEvent = Event & { error?: unknown; reason?: unknown };
type Listenable = { addEventListener(type: string, listener: (event: PageEvent) => void): void };

/**
 * `window.error` and `unhandledrejection`, installed once by `main.tsx`.
 * Typed structurally: the Worker's tests type-check this file without the DOM.
 */
export function installOperationalErrorCapture(build: { version: string; build: string }): void {
  const stamp = `${build.version} (${build.build})`;
  release = RELEASE_PATTERN.test(stamp) ? stamp : '0.0.0';
  const page = (error: unknown) => {
    try {
      // A cross-origin "Script error." or a resource load carries no error object.
      if (!error || typeof error !== 'object' || seen.has(error)) return;
      seen.add(error);
      const classified = classifyPageFailure('web.unhandled_error', error, audience(), currentPath());
      if (classified) enqueue(classified);
    } catch {
      // As above.
    }
  };
  const win = globalThis as unknown as Listenable;
  const doc = (globalThis as unknown as { document?: Listenable & { visibilityState?: string } }).document;
  win.addEventListener('error', (event) => page(event.error));
  win.addEventListener('unhandledrejection', (event) => page(event.reason));
  // A tab that closes sends what it has, once, without waiting.
  win.addEventListener('pagehide', () => void flushOperationalErrors(true));
  doc?.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'hidden') void flushOperationalErrors(true);
  });
}

/** Read to decide whether a visitor is on a guest page; never sent. */
function currentPath(): string {
  return globalThis.location?.pathname ?? '';
}

/** Exported for tests. Returns the event, or null when the failure is expected. */
export function classifyApiFailure(request: ApiFailure, error: unknown, who: Audience): Queued | null {
  const path = request.path.split('?')[0] ?? '';
  const method = request.method.toUpperCase();
  if (path.includes('operational-errors')) return null;
  const name = errorName(error);
  if (name === 'AbortError') return null;

  let errorClass: 'network' | 'timeout' | 'http' | 'decode';
  let status: number | undefined;
  let code: string | undefined;
  let requestId: string | undefined;
  if (request.decode) {
    errorClass = 'decode';
  } else if (error instanceof ControlRequestError) {
    errorClass = 'http';
    status = error.status;
    code = error.code;
    requestId = error.requestId;
  } else if (name === 'TimeoutError') {
    errorClass = 'timeout';
  } else {
    // A read that never reached the Worker is a poll or a refresh that runs
    // again on its own; a browser that knows it is offline is not a fault.
    if (method === 'GET' || globalThis.navigator?.onLine === false) return null;
    errorClass = 'network';
  }
  const httpStatus = status && status >= 100 && status <= 599 ? status : undefined;
  const request_id = requestId && UUID_PATTERN.test(requestId) ? requestId.toLowerCase() : undefined;

  const guestStep = method === 'POST'
    ? GUEST_JOIN.test(path) ? 'guest_join' as const : GUEST_EXCHANGE.test(path) ? 'guest_lobby' as const : null
    : null;
  if (guestStep) {
    // A 4xx here is the room answering: declined, ended, rate limited, seat gone.
    if (errorClass === 'http' && (httpStatus ?? 0) < 500) return null;
    return guestEvent(who, {
      code: guestStep === 'guest_join' ? 'guest.join_failed' : 'guest.request_failed',
      operation: guestStep,
      error_class: errorClass,
      ...(httpStatus ? { http_status: httpStatus } : {}),
      ...(request_id ? { request_id } : {}),
    });
  }
  // Only a member's own requests go to the signed-in route.
  if (who !== 'owner') return null;

  let eventCode: OwnerEvent['code'];
  let ownerClass: OwnerEvent['error_class'] = errorClass;
  let serverCode: OwnerEvent['server_code'];
  if (errorClass === 'decode') eventCode = 'service.invalid_response';
  else if (errorClass === 'timeout') eventCode = 'service.timeout';
  else if (errorClass === 'network') eventCode = 'service.offline';
  else if (code === 'calendar_expired') {
    // Google refused the stored grant: a member must reconnect, so it counts.
    eventCode = 'calendar_expired'; ownerClass = 'authorization'; serverCode = 'calendar_expired';
  } else if ((httpStatus ?? 0) < 500) {
    // Validation, refusal, sign-out, not found, rate limit: the user's outcome.
    return null;
  } else if (code === 'calendar_failed' || code === 'upstream_shape') {
    eventCode = code; ownerClass = 'upstream'; serverCode = code;
  } else if (code === 'internal_error') {
    eventCode = 'internal_error'; ownerClass = 'internal'; serverCode = 'internal_error';
  } else {
    eventCode = 'service.unavailable';
  }
  return ownerEvent({
    code: eventCode,
    operation: operationForRequest(`/api${path}`),
    error_class: ownerClass,
    ...(httpStatus ? { http_status: httpStatus } : {}),
    ...(serverCode ? { server_code: serverCode } : {}),
    ...(request_id ? { request_id } : {}),
  });
}

/** Exported for tests. A page failure carries its kind only, never its message or stack. */
export function classifyPageFailure(
  code: 'web.render_failed' | 'web.unhandled_error',
  error: unknown,
  who: Audience,
  pathname: string,
): Queued | null {
  if (EXPECTED_NAMES.has(errorName(error))) return null;
  // An API failure that went unhandled was already counted where it happened.
  if (error instanceof ControlRequestError) return null;
  if (who === 'owner') return ownerEvent({ code, operation: 'other', error_class: 'unknown' });
  // A visitor reports only from the guest's own pages: a room or a booking.
  if (!parsePublicRoomPath(pathname) && !parsePublicBookPath(pathname)) return null;
  return guestEvent(who, { code: 'guest.page_failed', operation: 'guest_room', error_class: 'unknown' });
}

function errorName(error: unknown): string {
  if (!error || typeof error !== 'object' || !('name' in error)) return '';
  return typeof error.name === 'string' ? error.name : '';
}

type OwnerFields = Pick<OwnerEvent, 'code' | 'operation' | 'error_class' | 'http_status' | 'server_code' | 'request_id'>;
type GuestFields = Pick<GuestEvent, 'code' | 'operation' | 'error_class' | 'http_status' | 'request_id'>;

function ownerEvent(fields: OwnerFields): Queued | null {
  const event_id = newEventId();
  if (!event_id) return null;
  const event: OwnerEvent = { event_id, source: 'web', platform: 'web', release, ...fields, retry_count: 0 };
  return { audience: 'owner', fingerprint: fingerprint('owner', fields), event };
}

/** A member's guest-door failure still goes to the signed-in route; the event is the guest one either way. */
function guestEvent(who: Audience, fields: GuestFields): Queued | null {
  const event_id = newEventId();
  if (!event_id) return null;
  const event: GuestEvent = { event_id, source: 'web', platform: 'web', release, ...fields, retry_count: 0 };
  return { audience: who, fingerprint: fingerprint(who, fields), event };
}

function fingerprint(who: Audience, fields: OwnerFields | GuestFields): string {
  const serverCode = 'server_code' in fields ? fields.server_code : undefined;
  return [who, fields.code, fields.operation, fields.error_class, fields.http_status ?? '', serverCode ?? ''].join('|');
}

function newEventId(): string | null {
  return typeof crypto?.randomUUID === 'function' ? crypto.randomUUID() : null;
}

function enqueue(item: Queued, now = Date.now()): void {
  if (refused[item.audience]) return;
  const last = lastSeen.get(item.fingerprint);
  lastSeen.set(item.fingerprint, now);
  if (last !== undefined && now - last <= DEDUPLICATION_MS) {
    const queued = queue.find((entry) => entry.fingerprint === item.fingerprint);
    if (queued) queued.event.retry_count = Math.min(10, queued.event.retry_count + 1);
    return;
  }
  if (reported >= MAX_EVENTS_PER_DOCUMENT) return;
  reported += 1;
  queue.push(item);
  if (queue.length > MAX_QUEUED) queue.splice(0, queue.length - MAX_QUEUED);
  scheduleFlush(FLUSH_DELAY_MS);
}

function scheduleFlush(delay: number): void {
  if (flushTimer !== undefined) return;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    void flushOperationalErrors(false);
  }, delay);
}

/**
 * Sends what is queued, one batch per audience. Raw `fetch`, never
 * `apiFetch`: a failure here is not recorded, reported or retried past
 * the bound. Exported for tests.
 */
export async function flushOperationalErrors(leaving: boolean): Promise<void> {
  if (flushing || !queue.length) return;
  flushing = true;
  let retry = false;
  try {
    for (const who of ['owner', 'guest'] as const) {
      const batch = queue.filter((entry) => entry.audience === who).slice(0, BATCH_SIZE[who]);
      if (!batch.length) continue;
      const outcome = await send(who, batch.map((entry) => entry.event), leaving);
      if (outcome === 'retry') { retry = true; continue; }
      if (outcome === 'refused') {
        refused[who] = true;
        queue = queue.filter((entry) => entry.audience !== who);
        continue;
      }
      queue = queue.filter((entry) => !batch.includes(entry));
    }
  } finally {
    flushing = false;
  }
  if (leaving) return;
  if (retry) {
    if (attempts >= RETRY_DELAYS_MS.length) {
      // Out of tries: drop it; the stream is best-effort.
      attempts = 0;
      queue = [];
      return;
    }
    scheduleFlush(RETRY_DELAYS_MS[attempts] ?? 60_000);
    attempts += 1;
    return;
  }
  attempts = 0;
  if (queue.length) scheduleFlush(FLUSH_DELAY_MS);
}

async function send(who: Audience, events: Array<OwnerEvent | GuestEvent>, keepalive: boolean): Promise<'done' | 'retry' | 'refused'> {
  try {
    const response = await fetch(`${apiBase}/${who === 'owner' ? 'operational-errors' : 'guest/operational-errors'}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events }),
      ...(keepalive ? { keepalive: true } : {}),
    });
    if (response.ok) return 'done';
    // Signed out or not allowed: nothing this document sends will change that.
    if (response.status === 401 || response.status === 403) return 'refused';
    // A 400 cannot succeed on a second try.
    return response.status === 429 || response.status >= 500 ? 'retry' : 'done';
  } catch {
    return 'retry';
  }
}

/** Test seam: the queue and its counters are module state. */
export function resetOperationalErrorsForTest(): void {
  if (flushTimer !== undefined) clearTimeout(flushTimer);
  flushTimer = undefined;
  queue = [];
  lastSeen = new Map();
  reported = 0;
  refused = { owner: false, guest: false };
  attempts = 0;
  flushing = false;
  seen = new WeakSet();
}

/** Test seam: what would be sent next. */
export function queuedOperationalErrorsForTest(): ReadonlyArray<Readonly<Queued>> {
  return queue;
}
