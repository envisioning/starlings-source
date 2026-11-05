import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseSearchDoor } from '../src/contracts';
import { listCalendarEventsInRange, writeTokenRecord } from '../src/calendar';
import { eventForDoor, eventRow, searchEventsWindow } from '../src/search';

const owner = { sub: 'owner-1', email: 'rosa@example.com' } as never;

function fakeEnv() {
  const store = new Map<string, string>();
  return {
    GOOGLE_TOKEN_ENCRYPTION_KEY: 'test-key',
    GOOGLE_NATIVE_CLIENT_ID: 'native-client',
    WEB_ORIGIN: 'https://envisioning.starlings.example',
    CALENDAR_TOKENS: {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => { store.set(key, value); },
      delete: async (key: string) => { store.delete(key); },
    },
  } as never;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// MCP `open` once matched `<calendarId>:<id>` against a door whose id already
// was `<calendarId>:<googleId>`, so no event door from search opened.
describe('an event door from search opens', () => {
  it('resolves a single event and a recurring instance to the event search listed', async () => {
    const env = fakeEnv();
    await writeTokenRecord(env, 'calendar:refresh:owner-1', 'refresh-1', 'rosa@example.com', 'native');
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('https://oauth2.googleapis.com/token')) return Response.json({ access_token: 'access-1' });
      if (url.includes('/users/me/calendarList')) {
        return Response.json({ items: [{ id: 'rosa@example.com', summary: 'Rosa', primary: true, accessRole: 'owner' }] });
      }
      if (url.includes('/events?')) {
        return Response.json({ items: [
          { id: 'dt7gfddv6e6h2arjbdv2i5cjt4', status: 'confirmed', summary: 'Review', start: { dateTime: '2026-10-20T09:00:00Z' }, end: { dateTime: '2026-10-20T10:00:00Z' } },
          { id: '3p6gtpc1ol3u3gaphjl6dkc9tr_20261019T130000Z', status: 'confirmed', summary: 'Weekly', start: { dateTime: '2026-10-19T13:00:00Z' }, end: { dateTime: '2026-10-19T14:00:00Z' } },
        ] });
      }
      return new Response('unexpected', { status: 500 });
    });

    const { timeMin, timeMax } = searchEventsWindow(Date.parse('2026-10-16T12:00:00Z'));
    const events = await listCalendarEventsInRange(env, owner, timeMin, timeMax);
    expect(events).toHaveLength(2);
    for (const event of events) {
      const door = parseSearchDoor(eventRow(event, 'UTC').door);
      if (door?.to !== 'event') throw new Error(`search gave a ${door?.to ?? 'broken'} door for an event`);
      expect(eventForDoor(events, door.id)).toBe(event);
    }
  });
});
