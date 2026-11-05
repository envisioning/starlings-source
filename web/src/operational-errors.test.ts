import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  guestOperationalErrorBatchSchema,
  operationalErrorBatchSchema,
  operationalErrorEventSchema,
} from '@starlings/contracts';
import { ControlRequestError } from './config';
import {
  classifyApiFailure,
  classifyPageFailure,
  flushOperationalErrors,
  installOperationalErrorCapture,
  queuedOperationalErrorsForTest,
  reportApiFailure,
  reportRenderFailure,
  resetOperationalErrorsForTest,
} from './operational-errors';
import { removeStored, StorageKeys, writeStored } from './storage';

const REQUEST_ID = '0b9f6c2e-3a51-4c8e-9d7a-5f1e2b3c4d5e';
const http = (status: number, code?: string, requestId?: string) =>
  new ControlRequestError('Ada (ada@example.net) could not open /rooms/secret-room?token=abc', status, code as never, requestId);
const offline = () => new TypeError('Failed to fetch https://meet.example/rooms/secret-room');
const named = (name: string) => Object.assign(new Error('secret detail'), { name });

function member(on: boolean) {
  if (on) writeStored(StorageKeys.memberHint, '1');
  else removeStored(StorageKeys.memberHint);
}

function sentBodies(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.map(([url, init]) => ({
    url: String(url),
    body: JSON.parse(String((init as RequestInit).body)) as { events: Array<Record<string, unknown>> },
  }));
}

beforeEach(() => {
  resetOperationalErrorsForTest();
  vi.useFakeTimers();
});

afterEach(() => {
  resetOperationalErrorsForTest();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  member(false);
});

describe('classification', () => {
  it('reports a server failure with its operation, status and request id', () => {
    const item = classifyApiFailure({ method: 'GET', path: '/calendar/events?day=2026-10-04' }, http(503, undefined, REQUEST_ID), 'owner');
    expect(item?.event).toMatchObject({
      code: 'service.unavailable', operation: 'calendar', error_class: 'http', http_status: 503, request_id: REQUEST_ID,
    });
    expect(classifyApiFailure({ method: 'POST', path: '/threads/t1/messages' }, http(500, 'internal_error'), 'owner')?.event)
      .toMatchObject({ code: 'internal_error', operation: 'chat', error_class: 'internal', server_code: 'internal_error' });
    expect(classifyApiFailure({ method: 'GET', path: '/calendar/events' }, http(401, 'calendar_expired'), 'owner')?.event)
      .toMatchObject({ code: 'calendar_expired', error_class: 'authorization', server_code: 'calendar_expired' });
  });

  it('ignores refusals, cancellation, ended meetings and failed reads', () => {
    const owner = (path: string, error: unknown, method = 'POST') => classifyApiFailure({ method, path }, error, 'owner');
    expect(owner('/crm/tasks', http(400, 'invalid_request'))).toBeNull();
    expect(owner('/docs/a', http(401, 'owner_auth_required'))).toBeNull();
    expect(owner('/crm/tasks', http(429, 'rate_limited'))).toBeNull();
    expect(owner('/rooms/mz/join-requests/r1/exchange', http(410, 'meeting_ended'))).toBeNull();
    expect(owner('/rooms/mz/join-requests/r1', http(401, 'lobby_credentials_invalid'), 'GET')).toBeNull();
    expect(owner('/crm/tasks', named('AbortError'))).toBeNull();
    // A poll that never reached the Worker runs again on its own.
    expect(owner('/threads', offline(), 'GET')).toBeNull();
    expect(owner('/operational-errors', http(503))).toBeNull();
  });

  it('reports a write that never reached the Worker, and a body that is not JSON', () => {
    expect(classifyApiFailure({ method: 'POST', path: '/crm/tasks' }, offline(), 'owner')?.event)
      .toMatchObject({ code: 'service.offline', operation: 'work', error_class: 'network' });
    expect(classifyApiFailure({ method: 'GET', path: '/search?q=ada', decode: true }, new SyntaxError('x'), 'owner')?.event)
      .toMatchObject({ code: 'service.invalid_response', operation: 'search', error_class: 'decode' });
  });

  it('gives a guest only the join door, and only its server failures', () => {
    expect(classifyApiFailure({ method: 'POST', path: '/rooms/mz/join-requests' }, http(502), 'guest')?.event)
      .toMatchObject({ code: 'guest.join_failed', operation: 'guest_join', error_class: 'http', http_status: 502 });
    expect(classifyApiFailure({ method: 'POST', path: '/rooms/mz/join-requests/r1/exchange' }, offline(), 'guest')?.event)
      .toMatchObject({ code: 'guest.request_failed', operation: 'guest_lobby', error_class: 'network' });
    expect(classifyApiFailure({ method: 'POST', path: '/rooms/mz/join-requests' }, http(409, 'room_not_started'), 'guest')).toBeNull();
    expect(classifyApiFailure({ method: 'POST', path: '/rooms/mz/guest-presence' }, http(500), 'guest')).toBeNull();
    expect(classifyApiFailure({ method: 'GET', path: '/rooms/mz/join-requests/r1' }, http(500), 'guest')).toBeNull();
  });

  it('classifies page failures and skips room transitions', () => {
    expect(classifyPageFailure('web.unhandled_error', new Error('x'), 'owner', '/work')?.event)
      .toMatchObject({ code: 'web.unhandled_error', operation: 'other', error_class: 'unknown' });
    expect(classifyPageFailure('web.render_failed', new Error('x'), 'guest', '/room/mz')?.event)
      .toMatchObject({ code: 'guest.page_failed', operation: 'guest_room', error_class: 'unknown' });
    expect(classifyPageFailure('web.unhandled_error', new Error('x'), 'guest', '/help')).toBeNull();
    for (const name of ['ConnectionError', 'SignalReconnectError', 'AbortError', 'NotAllowedError']) {
      expect(classifyPageFailure('web.unhandled_error', named(name), 'owner', '/work')).toBeNull();
    }
    expect(classifyPageFailure('web.unhandled_error', http(500), 'owner', '/work')).toBeNull();
  });
});

describe('redaction', () => {
  it('sends only the contract fields, never the message, path, room or a non-UUID id', () => {
    const items = [
      classifyApiFailure({ method: 'POST', path: '/rooms/secret-room/meetings/m1/hand?token=abc' }, http(500, undefined, 'req-ada@example.net'), 'owner'),
      classifyPageFailure('web.render_failed', new Error('Ada ada@example.net /rooms/secret-room'), 'owner', '/rooms/secret-room'),
      // A member at the guest door: the guest event, on the signed-in route.
      classifyApiFailure({ method: 'POST', path: '/rooms/secret-room/join-requests' }, offline(), 'owner'),
    ];
    for (const item of items) {
      expect(item).not.toBeNull();
      const event = item!.event;
      expect(() => operationalErrorEventSchema.parse(event)).not.toThrow();
      expect(event).not.toHaveProperty('request_id');
      // The random event id is hex, so it is left out of the substring check.
      const text = JSON.stringify({ ...event, event_id: undefined });
      for (const secret of ['ada', 'secret-room', 'token', 'rooms/', 'example.com', 'm1']) expect(text).not.toContain(secret);
    }
  });
});

describe('deduplication', () => {
  it('counts a repeat inside 30 seconds and queues it again after', () => {
    member(true);
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    for (let i = 0; i < 5; i += 1) reportApiFailure({ method: 'GET', path: '/threads' }, http(503));
    expect(queuedOperationalErrorsForTest()).toHaveLength(1);
    expect(queuedOperationalErrorsForTest()[0].event.retry_count).toBe(4);
    vi.setSystemTime(Date.now() + 31_000);
    reportApiFailure({ method: 'GET', path: '/threads' }, http(503));
    expect(queuedOperationalErrorsForTest()).toHaveLength(2);
  });

  it('does not count an API failure twice when it also goes unhandled', async () => {
    member(true);
    installOperationalErrorCapture({ version: '6.2.0', build: '1234' });
    const failure = http(503);
    reportApiFailure({ method: 'POST', path: '/crm/tasks' }, failure);
    reportRenderFailure(failure);
    window.dispatchEvent(new ErrorEvent('error', { error: failure }));
    expect(queuedOperationalErrorsForTest()).toHaveLength(1);
    window.dispatchEvent(new ErrorEvent('error', { error: new RangeError('owner page broke') }));
    expect(queuedOperationalErrorsForTest().map((item) => item.event.code)).toEqual(['service.unavailable', 'web.unhandled_error']);
  });
});

describe('delivery', () => {
  it('sends a guest batch to the anonymous route with the fixed guest fields', async () => {
    member(false);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ accepted: 1 }), { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    reportApiFailure({ method: 'POST', path: '/rooms/mz/join-requests' }, http(503, 'internal_error', REQUEST_ID));
    await vi.advanceTimersByTimeAsync(2_000);
    const [sent] = sentBodies(fetchMock);
    expect(sent.url).toMatch(/\/api\/guest\/operational-errors$/u);
    expect(() => guestOperationalErrorBatchSchema.parse(sent.body)).not.toThrow();
    expect(Object.keys(sent.body.events[0]).sort()).toEqual([
      'code', 'error_class', 'event_id', 'http_status', 'operation', 'platform', 'release', 'request_id', 'retry_count', 'source',
    ]);
    expect(queuedOperationalErrorsForTest()).toHaveLength(0);
  });

  it('sends a member batch to the signed-in route', async () => {
    member(true);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ accepted: 1 }), { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    reportApiFailure({ method: 'POST', path: '/crm/tasks' }, http(500));
    await vi.advanceTimersByTimeAsync(2_000);
    const [sent] = sentBodies(fetchMock);
    expect(sent.url).toMatch(/\/api\/operational-errors$/u);
    expect(() => operationalErrorBatchSchema.parse(sent.body)).not.toThrow();
  });

  it('retries a failed delivery twice, then drops it, and never reports itself', async () => {
    member(true);
    installOperationalErrorCapture({ version: '6.2.0', build: '1234' });
    const fetchMock = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    vi.stubGlobal('fetch', fetchMock);
    reportApiFailure({ method: 'POST', path: '/crm/tasks' }, http(500));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(queuedOperationalErrorsForTest()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(queuedOperationalErrorsForTest()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('stops for the document when the route refuses the session', async () => {
    member(true);
    const fetchMock = vi.fn(async () => new Response('{}', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    reportApiFailure({ method: 'POST', path: '/crm/tasks' }, http(500));
    await vi.advanceTimersByTimeAsync(2_000);
    reportApiFailure({ method: 'POST', path: '/docs/a' }, http(502));
    await flushOperationalErrors(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(queuedOperationalErrorsForTest()).toHaveLength(0);
  });
});
