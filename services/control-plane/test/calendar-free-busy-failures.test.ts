import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CRM_ATTENDEE_LOOKUP_MS,
  fetchCalendarFreeBusy,
  freeBusyPersonReason,
  freeBusyRequestFailure,
  listCalendarEventsInRange,
  writeTokenRecord,
} from '../src/calendar';

const owner = { sub: 'owner-1', email: 'rosa@example.com' } as never;

function fakeEnv(connected = true) {
  const store = new Map<string, string>();
  const env = {
    GOOGLE_TOKEN_ENCRYPTION_KEY: 'test-key',
    GOOGLE_NATIVE_CLIENT_ID: 'native-client',
    WEB_ORIGIN: 'https://envisioning.starlings.example',
    CALENDAR_TOKENS: {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => { store.set(key, value); },
      delete: async (key: string) => { store.delete(key); },
    },
  } as never;
  return { env, store, seed: () => connected && writeTokenRecord(env, 'calendar:refresh:owner-1', 'refresh-1', 'rosa@example.com', 'native') };
}

/** A token endpoint that mints access-1, access-2, … and a free/busy answer per call. */
function stubGoogle(freeBusy: (call: number, bearer: string) => Response) {
  let mints = 0;
  let calls = 0;
  const bearers: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      mints += 1;
      return Response.json({ access_token: `access-${mints}` });
    }
    if (url === 'https://www.googleapis.com/calendar/v3/freeBusy') {
      const bearer = (new Headers(init?.headers).get('authorization') ?? '').replace('Bearer ', '');
      bearers.push(bearer);
      calls += 1;
      return freeBusy(calls, bearer);
    }
    return new Response('unexpected', { status: 500 });
  });
  return { bearers };
}

const query = { timeMin: '2026-10-01T00:00:00Z', timeMax: '2026-10-02T00:00:00Z', emails: ['tarik@example.org'] };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('free/busy: one teammate', () => {
  it.each([
    ['notFound', 'not_shared'],
    ['internalError', 'temporarily_unavailable'],
    ['backendError', 'temporarily_unavailable'],
    ['groupTooBig', 'unavailable'],
    ['tooManyCalendarsRequested', 'unavailable'],
    ['somethingNew', 'unavailable'],
    ['', ''],
  ])('maps Google %s to %j', (google, mapped) => {
    expect(freeBusyPersonReason(google)).toBe(mapped);
  });

  it('says "not shared" for a calendar on another domain that Google will not show', async () => {
    const { env, seed } = fakeEnv();
    await seed();
    stubGoogle(() => Response.json({
      calendars: { 'tarik@example.org': { busy: [], errors: [{ domain: 'global', reason: 'notFound' }] } },
    }));
    const [person] = await fetchCalendarFreeBusy(env, owner, query);
    expect(person).toEqual({ email: 'tarik@example.org', busy: [], error: 'not_shared' });
  });

  it('returns the busy blocks, with no error, when Google shares them', async () => {
    const { env, seed } = fakeEnv();
    await seed();
    stubGoogle(() => Response.json({
      calendars: { 'tarik@example.org': { busy: [{ start: '2026-10-01T09:00:00Z', end: '2026-10-01T10:00:00Z' }] } },
    }));
    const [person] = await fetchCalendarFreeBusy(env, owner, query);
    expect(person?.error).toBe('');
    expect(person?.busy).toHaveLength(1);
  });

  it('treats an address Google did not answer for as unavailable, not free', async () => {
    const { env, seed } = fakeEnv();
    await seed();
    stubGoogle(() => Response.json({ calendars: {} }));
    const [person] = await fetchCalendarFreeBusy(env, owner, query);
    expect(person?.error).toBe('unavailable');
  });
});

describe('free/busy: the viewer', () => {
  it('says "connect Calendar" with its own code when the viewer has no token', async () => {
    const { env } = fakeEnv(false);
    stubGoogle(() => Response.json({}));
    await expect(fetchCalendarFreeBusy(env, owner, query)).rejects.toMatchObject({ status: 409, code: 'calendar_not_connected' });
  });

  it('forgets a revoked grant and says "reconnect" (calendar_expired)', async () => {
    const { env, store, seed } = fakeEnv();
    await seed();
    vi.stubGlobal('fetch', async () => Response.json({ error: 'invalid_grant' }, { status: 400 }));
    await expect(fetchCalendarFreeBusy(env, owner, query)).rejects.toMatchObject({ status: 401, code: 'calendar_expired' });
    expect(store.has('calendar:refresh:owner-1')).toBe(false);
  });

  it('retries once with a fresh token when Google refuses the one it was handed', async () => {
    const { env, seed } = fakeEnv();
    await seed();
    const { bearers } = stubGoogle((call) => call === 1
      ? Response.json({ error: { code: 401, status: 'UNAUTHENTICATED' } }, { status: 401 })
      : Response.json({ calendars: { 'tarik@example.org': { busy: [] } } }));
    const [person] = await fetchCalendarFreeBusy(env, owner, query);
    expect(person?.error).toBe('');
    expect(bearers).toEqual(['access-1', 'access-2']);
  });

  it('says "reconnect" when a fresh token is refused too', async () => {
    const { env, seed } = fakeEnv();
    await seed();
    stubGoogle(() => new Response('{}', { status: 401 }));
    await expect(fetchCalendarFreeBusy(env, owner, query)).rejects.toMatchObject({ status: 401, code: 'calendar_expired' });
  });

  it('keeps a Google outage as a retryable 502, never an auth failure', async () => {
    const { env, seed } = fakeEnv();
    await seed();
    stubGoogle(() => new Response('try later', { status: 503 }));
    await expect(fetchCalendarFreeBusy(env, owner, query)).rejects.toMatchObject({ status: 502, code: 'calendar_failed' });
  });
});

describe('free/busy: whole-request failures', () => {
  it.each([
    [401, '', 401, 'calendar_expired'],
    [403, 'insufficientPermissions', 403, 'calendar_expired'],
    [403, 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', 403, 'calendar_expired'],
    [403, 'userRateLimitExceeded', 429, 'rate_limited'],
    [403, 'rateLimitExceeded', 429, 'rate_limited'],
    [429, '', 429, 'rate_limited'],
    [400, 'timeRangeEmpty', 400, 'invalid_request'],
    [500, '', 502, 'calendar_failed'],
    [503, 'backendError', 502, 'calendar_failed'],
  ])('Google %i %s becomes %i %s', (status, reason, mappedStatus, code) => {
    expect(freeBusyRequestFailure(status, reason)).toMatchObject({ status: mappedStatus, code });
  });

  it('never turns a Google 403 into a bare 401 that a client reads as "sign in"', () => {
    for (const reason of ['', 'forbidden', 'insufficientPermissions', 'rateLimitExceeded']) {
      expect(freeBusyRequestFailure(403, reason).status).not.toBe(401);
    }
  });
});

describe('events read: the refresh a wake triggers (meet#613)', () => {
  function stubEvents(events: (call: number, bearer: string) => Response) {
    let mints = 0;
    let calls = 0;
    const bearers: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const bearer = (new Headers(init?.headers).get('authorization') ?? '').replace('Bearer ', '');
      if (url.startsWith('https://oauth2.googleapis.com/token')) {
        mints += 1;
        return Response.json({ access_token: `access-${mints}` });
      }
      if (url.includes('/users/me/calendarList')) {
        return Response.json({ items: [{ id: 'rosa@example.com', summary: 'Rosa', primary: true, accessRole: 'owner' }] });
      }
      if (url.includes('/events?')) {
        calls += 1;
        bearers.push(bearer);
        return events(calls, bearer);
      }
      return new Response('unexpected', { status: 500 });
    });
    return { bearers };
  }
  const range = ['2026-10-01T00:00:00Z', '2026-10-08T00:00:00Z'] as const;

  it('mints a new token when Google refuses the first, instead of failing the refresh', async () => {
    const { env, seed } = fakeEnv();
    await seed();
    const { bearers } = stubEvents((call) => call === 1
      ? new Response('{}', { status: 401 })
      : Response.json({ items: [] }));
    await expect(listCalendarEventsInRange(env, owner, ...range)).resolves.toEqual([]);
    // The calendar list took one token; the events read was refused on the
    // pooled one and asked again with a renewed one.
    expect(bearers).toHaveLength(2);
    expect(bearers[0]).not.toBe(bearers[1]);
  });

  it('reports a Google per-user rate limit as busy (429), not as an expired sign-in (401)', async () => {
    const { env, seed } = fakeEnv();
    await seed();
    stubEvents(() => Response.json(
      { error: { code: 403, errors: [{ reason: 'userRateLimitExceeded' }] } },
      { status: 403 },
    ));
    await expect(listCalendarEventsInRange(env, owner, ...range)).rejects.toMatchObject({ status: 429, code: 'calendar_failed' });
  });

  it('answers without CRM names when Core does not answer in time', async () => {
    const { env, seed } = fakeEnv();
    await seed();
    Object.assign(env, { WORK_STORE: 'core', INTERNAL_REQUEST_SECRET: 'core-test-secret-with-at-least-32-characters', CORE_API_ORIGIN: 'https://core.test' });
    let coreAsked = false;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('https://oauth2.googleapis.com/token')) return Response.json({ access_token: 'access-1' });
      if (url.includes('/users/me/calendarList')) {
        return Response.json({ items: [{ id: 'rosa@example.com', summary: 'Rosa', primary: true, accessRole: 'owner' }] });
      }
      if (url.includes('/events?')) {
        return Response.json({ items: [{
          id: 'event-1',
          status: 'confirmed',
          summary: 'Review',
          start: { dateTime: '2026-10-02T09:00:00Z' },
          end: { dateTime: '2026-10-02T10:00:00Z' },
          attendees: [{ email: 'guest@example.net', responseStatus: 'accepted' }],
        }] });
      }
      if (url.startsWith('https://core.test/')) {
        // A Core call that never comes back: a busy Core, or a slot held by
        // a cancelled request. The events must not wait for it.
        coreAsked = true;
        return new Promise<Response>(() => undefined);
      }
      return new Response('unexpected', { status: 500 });
    });
    const started = Date.now();
    const events = await listCalendarEventsInRange(env, owner, ...range);
    expect(coreAsked).toBe(true);
    expect(events.map((event) => event.title)).toEqual(['Review']);
    expect(Date.now() - started).toBeLessThan(CRM_ATTENDEE_LOOKUP_MS + 2_000);
  });
});
