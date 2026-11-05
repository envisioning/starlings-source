// INBOX's invitations read every page Google lists (meet#1057): a busy
// calendar's first 250 events from a month back can end before an
// invitation weeks ahead.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readCalendarInvitations, writeTokenRecord } from '../src/calendar';

function fakeEnv() {
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
  return { env, store };
}

const owner = { sub: 'owner-1', email: 'rosa@example.com' } as never;

function event(id: string, startDay: number, invited: boolean) {
  const start = new Date(Date.now() + startDay * 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  return {
    id,
    status: 'confirmed',
    summary: id,
    updated: new Date().toISOString(),
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
    organizer: { email: 'organizer@example.net' },
    attendees: [
      { email: 'organizer@example.net', organizer: true, responseStatus: 'accepted' },
      { email: 'rosa@example.com', self: true, responseStatus: invited ? 'needsAction' : 'accepted' },
    ],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('calendar invitations', () => {
  it('reads past the first page of a calendar', async () => {
    const { env } = fakeEnv();
    await writeTokenRecord(env, 'calendar:refresh:owner-1', 'refresh-primary', 'rosa@example.com', 'native');
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('https://oauth2.googleapis.com/token')) return Response.json({ access_token: 'access-primary', expires_in: 3600 });
      if (url.includes('/users/me/calendarList')) {
        return Response.json({ items: [{ id: 'rosa@example.com', summary: 'Rosa', primary: true, accessRole: 'owner' }] });
      }
      if (url.includes('/events?')) {
        const token = new URL(url).searchParams.get('pageToken');
        asked.push(token ?? 'first');
        if (!token) return Response.json({ items: [event('busy-1', 1, false), event('busy-2', 2, false)], nextPageToken: 'page-2' });
        return Response.json({ items: [event('teams-invite', 20, true)] });
      }
      return new Response('unexpected', { status: 500 });
    });

    const rows = await readCalendarInvitations(env, owner);

    expect(asked).toEqual(['first', 'page-2']);
    expect(rows.map((row) => row.event.title)).toEqual(['teams-invite']);
    expect(rows[0]!.updatedMs).toBeGreaterThan(0);
  });
});
