/**
 * The event sign-up seam, one suite for both stores (meet#966, docs/SESSIONS.md
 * §0 fold rule F2). Every case runs against the D1 implementation for real and
 * against the Core client, whose Core is a small stand-in that answers the
 * `meet-session-*` routes in the shapes Core records
 * (`fixtures/core/meet-session-*.json`, read in core-fixtures.test.ts). A
 * behaviour only one store has is a bug, so a case that fails on one store
 * and not the other names the gap.
 */
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_REGISTRATION_CAP, sessionEventFromRecord, sessionEventRecordSchema, type SessionEventRecord } from '@starlings/contracts/event-signups';
import {
  cancelSessionRegistration,
  registerForSession,
  registrationsNeedingMail,
  resolveSessionToken,
  sessionEventById,
  sessionEventBySlug,
  sessionEventsCovering,
  sessionEventsStarting,
  sessionTokenHashes,
  sha256Hex,
  stampSessionMail,
} from '../src/event-signups';

interface SeedEvent {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  body: string | null;
  image_url: string | null;
  starts_at: string;
  ends_at: string;
  room: string;
}

interface Harness {
  name: 'd1' | 'core';
  env: Env;
  reset(): Promise<void>;
  seed(event: SeedEvent): Promise<void>;
}

const EVENT: SeedEvent = {
  id: 'abcdef12-0000-4000-8000-000000000001',
  slug: 'starlings-at-work-abcdef12',
  title: 'Starlings at work',
  description: 'A live call where Starlings runs a real project.',
  body: '## What happens\n\nA real project, live.',
  image_url: 'https://images.example.test/cover.png',
  starts_at: '2026-10-20T15:00:00.000Z',
  ends_at: '2026-10-20T15:45:00.000Z',
  room: 'rosa',
};
const BEFORE = new Date('2026-10-10T12:00:00.000Z');

// ---------------------------------------------------------------------------
// D1: the real tables, on a `d1` workspace.

const d1Env = { ...env, WORK_STORE: 'd1' } as Env;

const d1: Harness = {
  name: 'd1',
  env: d1Env,
  async reset() {
    await env.USAGE.batch([env.USAGE.prepare('DELETE FROM event_registrations'), env.USAGE.prepare('DELETE FROM events')]);
  },
  async seed(event) {
    const now = Date.now();
    await env.USAGE.prepare(`
      INSERT INTO events (id, title, starts_on, public_slug, starts_at, ends_at, time_zone, room_slug, cta_url, cta_label, created_at, updated_at, description, body, image_url)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'Europe/Amsterdam', ?7, 'https://site.example/interest?source=artificial-insights', 'Ask about a pilot', ?8, ?8, ?9, ?10, ?11)`)
      .bind(event.id, event.title, event.starts_at.slice(0, 10), event.slug, Date.parse(event.starts_at), Date.parse(event.ends_at), event.room, now, event.description, event.body, event.image_url)
      .run();
  },
};

// ---------------------------------------------------------------------------
// Core: the client against a stand-in for Core's routes. It keeps Core's rules
// (src/lib/meet-session-events.ts in envisioning/core) and answers its shapes.

interface CoreRegistration {
  id: string; event_id: string; name: string; email: string; join_token: string; status: 'registered' | 'cancelled';
  ics_uid: string; ics_sequence: number; confirmation_sent_at: string | null; reminder_sent_at: string | null;
  follow_up_sent_at: string | null; created_at: string;
}
const coreState = { events: [] as SeedEvent[], registrations: [] as CoreRegistration[], down: false };

function coreRecord(event: SeedEvent): SessionEventRecord {
  return {
    id: event.id, slug: event.slug, title: event.title, description: event.description, body: event.body, image_url: event.image_url,
    attendance: 'online', duration_minutes: Math.round((Date.parse(event.ends_at) - Date.parse(event.starts_at)) / 60_000),
    starts_at: event.starts_at, ends_at: event.ends_at,
    time_zone: 'Europe/Amsterdam', room_slug: event.room,
    cta_url: 'https://site.example/interest?source=artificial-insights', cta_label: 'Ask about a pilot', follow_up_note: null,
    registration_count: coreState.registrations.filter((row) => row.event_id === event.id && row.status === 'registered').length,
  };
}

function wire(row: CoreRegistration) {
  const { email: _email, ...rest } = row;
  return { ...rest, source: 'meet' as const };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function coreFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (coreState.down) throw new TypeError('fetch failed');
  const request = new Request(input, init);
  expect(request.headers.get('x-internal-signature')).toMatch(/^[0-9a-f]{64}$/u);
  const url = new URL(request.url);
  const body = request.method === 'POST' ? (await request.json()) as Record<string, string> : {};
  const path = url.pathname;
  const q = url.searchParams;
  const now = Date.now();

  if (path === '/api/public/meet-session-events') {
    const byId = (id: string | null) => coreState.events.find((event) => event.id === id);
    if (q.has('slug') || q.has('id')) {
      const event = q.has('slug') ? coreState.events.find((row) => row.slug === q.get('slug')) : byId(q.get('id'));
      return event ? json({ ok: true, events: [coreRecord(event)] }) : json({ ok: false, error: 'Not a session event' }, 404);
    }
    if (q.has('room')) {
      const at = Date.parse(q.get('at')!);
      const day = 86_400_000;
      return json({ ok: true, events: coreState.events.filter((event) => event.room === q.get('room') && Math.abs(Date.parse(event.starts_at) - at) <= day).map(coreRecord) });
    }
    return json({ ok: true, events: coreState.events.filter((event) => event.starts_at >= q.get('from')! && event.starts_at < q.get('to')!).map(coreRecord) });
  }
  const eventRoute = /^\/api\/public\/meet-session-events\/([^/]+)\/(registrations|token-hashes|mail-due)$/u.exec(path);
  if (eventRoute) {
    const event = coreState.events.find((row) => row.id === decodeURIComponent(eventRoute[1]!));
    if (!event) return json({ ok: false, error: 'Not a session event' }, 404);
    const live = coreState.registrations.filter((row) => row.event_id === event.id && row.status === 'registered');
    if (eventRoute[2] === 'registrations') {
      const existing = coreState.registrations.find((row) => row.event_id === event.id && row.email === body.email);
      if (Date.parse(event.starts_at) <= now) return json({ ok: false, reason: 'started' }, 409);
      if (existing) {
        existing.status = 'registered';
        existing.name = body.name!;
        return json({ ok: true, created: false, registration: wire(existing) });
      }
      if (live.length >= SESSION_REGISTRATION_CAP) return json({ ok: false, reason: 'full' }, 409);
      const row: CoreRegistration = {
        id: body.id ?? crypto.randomUUID(), event_id: event.id, name: body.name!, email: body.email!, join_token: body.join_token!,
        status: 'registered', ics_uid: body.ics_uid!, ics_sequence: 0, confirmation_sent_at: null, reminder_sent_at: null,
        follow_up_sent_at: null, created_at: new Date(now).toISOString(),
      };
      coreState.registrations.push(row);
      return json({ ok: true, created: true, registration: wire(row) }, 201);
    }
    if (eventRoute[2] === 'token-hashes') {
      return json({ ok: true, hashes: (await Promise.all(live.map((row) => sha256Hex(row.join_token)))).sort() });
    }
    const column = `${q.get('kind')}_sent_at` as 'reminder_sent_at';
    return json({ ok: true, registrations: live.filter((row) => row[column] === null).map((row) => ({ ...wire(row), email: row.email })) });
  }
  const tokenRow = coreState.registrations.find((row) => row.join_token === body.token);
  if (path === '/api/public/meet-session-registrations/resolve') {
    if (!tokenRow) return json({ ok: false, error: 'Unknown token' }, 404);
    const event = coreState.events.find((row) => row.id === tokenRow.event_id);
    return json({ ok: true, registration: { id: tokenRow.id, event_id: tokenRow.event_id, status: event ? tokenRow.status : 'cancelled', name: tokenRow.name } });
  }
  if (path === '/api/public/meet-session-registrations/cancel') {
    if (!tokenRow) return json({ ok: false, error: 'Unknown token' }, 404);
    tokenRow.status = 'cancelled';
    return json({ ok: true, registration: wire(tokenRow) });
  }
  if (path === '/api/public/meet-session-registrations/stamp') {
    const row = coreState.registrations.find((candidate) => candidate.id === body.id);
    const column = `${body.kind}_sent_at` as 'reminder_sent_at';
    if (!row || (body.kind !== 'confirmation' && row[column] !== null)) return json({ ok: true, stamped: false });
    row[column] = new Date(now).toISOString();
    return json({ ok: true, stamped: true });
  }
  return json({ ok: false }, 404);
}

const core: Harness = {
  name: 'core',
  env: { ...env, INTERNAL_REQUEST_SECRET: 'meet-core-shared-secret-at-least-32-chars' } as Env,
  async reset() {
    coreState.events = [];
    coreState.registrations = [];
    coreState.down = false;
    vi.stubGlobal('fetch', coreFetch);
  },
  async seed(event) {
    coreState.events.push(event);
  },
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function person(n: number) {
  return { name: `Person ${n}`, email: `person${n}@example.test`, join_token: `TOKEN${String(n).padStart(11, '0')}`, ics_uid: `uid-${n}@meet.example.test` };
}

describe.each([d1, core])('event sign-up store: $name', (store) => {
  beforeEach(async () => {
    vi.useFakeTimers({ now: BEFORE, toFake: ['Date'] });
    await store.reset();
    await store.seed(EVENT);
  });

  async function event(): Promise<SessionEventRecord> {
    const found = await sessionEventById(store.env, EVENT.id);
    if (!found) throw new Error('no event');
    return found;
  }

  it('reads a session event by slug and by id, and nothing for an unknown slug', async () => {
    const bySlug = await sessionEventBySlug(store.env, EVENT.slug);
    expect(bySlug).toMatchObject({ id: EVENT.id, slug: EVENT.slug, description: EVENT.description, starts_at: EVENT.starts_at, ends_at: EVENT.ends_at, room_slug: 'rosa', registration_count: 0 });
    expect(await sessionEventById(store.env, EVENT.id)).toEqual(bySlug);
    expect(await sessionEventBySlug(store.env, 'nothing-here-00000000')).toBeNull();
    expect(sessionEventFromRecord(bySlug!, BEFORE)).toMatchObject({ open: true, closed_reason: null, description: EVENT.description });
  });

  it('projects the page fields alike on both stores: body, cover image, attendance, duration', async () => {
    expect(sessionEventFromRecord(await event(), BEFORE)).toMatchObject({
      body: EVENT.body,
      image_url: EVENT.image_url,
      attendance: 'online',
      duration_minutes: 45,
      spots_left: null,
      going: null,
      host: null,
    });
  });

  it('shows the count from 5 sign-ups, and spots left at 20 or fewer', async () => {
    for (let n = 0; n < 5; n += 1) await registerForSession(store.env, await event(), person(n), BEFORE);
    expect(sessionEventFromRecord(await event(), BEFORE)).toMatchObject({ going: 5, spots_left: null });
    for (let n = 5; n < SESSION_REGISTRATION_CAP - 20; n += 1) await registerForSession(store.env, await event(), person(n), BEFORE);
    expect(sessionEventFromRecord(await event(), BEFORE)).toMatchObject({ spots_left: 20 });
  });

  it('reads an event with no description as null', async () => {
    await store.reset();
    await store.seed({ ...EVENT, description: null });
    expect((await event()).description).toBeNull();
  });

  it('registers idempotently by address: the same token, one row', async () => {
    const first = await registerForSession(store.env, await event(), { ...person(1), email: 'Person1@Example.test' }, BEFORE);
    const second = await registerForSession(store.env, await event(), { ...person(1), join_token: 'ANOTHERTOKEN0001' }, BEFORE);
    expect(first).toMatchObject({ kind: 'registered', created: true, registration: { join_token: person(1).join_token, ics_sequence: 0, status: 'registered' } });
    expect(second).toMatchObject({ kind: 'registered', created: false, registration: { join_token: person(1).join_token } });
    expect((await event()).registration_count).toBe(1);
    expect(first.kind === 'registered' && first.registration).not.toHaveProperty('email');
  });

  it('keeps a caller-given id', async () => {
    const id = '99999999-0000-4000-8000-000000000001';
    expect(await registerForSession(store.env, await event(), { ...person(1), id }, BEFORE)).toMatchObject({ registration: { id } });
  });

  it('closes at the start', async () => {
    const atStart = new Date(EVENT.starts_at);
    vi.setSystemTime(atStart);
    expect(await registerForSession(store.env, await event(), person(1), atStart)).toEqual({ kind: 'refused', reason: 'started' });
    expect(sessionEventFromRecord(await event(), atStart)).toMatchObject({ open: false, closed_reason: 'started' });
  });

  it('closes at the cap, and still gives an address that signed up its link', async () => {
    for (let n = 0; n < SESSION_REGISTRATION_CAP; n += 1) await registerForSession(store.env, await event(), person(n), BEFORE);
    const full = await event();
    expect(full.registration_count).toBe(SESSION_REGISTRATION_CAP);
    expect(sessionEventFromRecord(full, BEFORE)).toMatchObject({ open: false, closed_reason: 'full' });
    expect(await registerForSession(store.env, full, person(500), BEFORE)).toEqual({ kind: 'refused', reason: 'full' });
    expect(await registerForSession(store.env, full, person(3), BEFORE)).toMatchObject({ kind: 'registered', created: false, registration: { join_token: person(3).join_token } });
  });

  it('gives hashes of live tokens only, as SHA-256 hex', async () => {
    await registerForSession(store.env, await event(), person(1), BEFORE);
    expect(await sessionTokenHashes(store.env, EVENT.id)).toEqual([await sha256Hex(person(1).join_token)]);
  });

  it('cancels by token: resolves as cancelled, no hash, no count, no mail; a new sign-up brings back the same token', async () => {
    await registerForSession(store.env, await event(), person(1), BEFORE);
    expect(await resolveSessionToken(store.env, person(1).join_token)).toMatchObject({ event_id: EVENT.id, status: 'registered', name: 'Person 1' });
    expect(await cancelSessionRegistration(store.env, person(1).join_token)).toMatchObject({ status: 'cancelled' });
    expect(await resolveSessionToken(store.env, person(1).join_token)).toMatchObject({ status: 'cancelled' });
    expect(await sessionTokenHashes(store.env, EVENT.id)).toEqual([]);
    expect((await event()).registration_count).toBe(0);
    expect(await registrationsNeedingMail(store.env, EVENT.id, 'reminder')).toEqual([]);
    expect(await registerForSession(store.env, await event(), { ...person(1), join_token: 'ANOTHERTOKEN0001' }, BEFORE))
      .toMatchObject({ registration: { join_token: person(1).join_token, status: 'registered' } });
  });

  it('answers nothing for an unknown token', async () => {
    expect(await resolveSessionToken(store.env, 'UNKNOWNTOKEN0000')).toBeNull();
    expect(await cancelSessionRegistration(store.env, 'UNKNOWNTOKEN0000')).toBeNull();
  });

  it('lists who needs a mail, with the address, and stamps a reminder once', async () => {
    const result = await registerForSession(store.env, await event(), person(1), BEFORE);
    if (result.kind !== 'registered') throw new Error('refused');
    const due = await registrationsNeedingMail(store.env, EVENT.id, 'reminder');
    expect(due.map((row) => row.email)).toEqual(['person1@example.test']);
    expect(await stampSessionMail(store.env, result.registration.id, 'reminder')).toBe(true);
    expect(await stampSessionMail(store.env, result.registration.id, 'reminder')).toBe(false);
    expect(await registrationsNeedingMail(store.env, EVENT.id, 'reminder')).toEqual([]);
    expect(await registrationsNeedingMail(store.env, EVENT.id, 'follow_up')).toHaveLength(1);
    expect(await stampSessionMail(store.env, result.registration.id, 'confirmation')).toBe(true);
    expect(await stampSessionMail(store.env, result.registration.id, 'confirmation')).toBe(true);
  });

  it('finds the event that covers a moment in its room, 15 minutes either side', async () => {
    const at = (iso: string) => sessionEventsCovering(store.env, 'rosa', new Date(iso));
    expect((await at('2026-10-20T14:45:00.000Z')).map((row) => row.id)).toEqual([EVENT.id]);
    expect(await at('2026-10-20T14:44:00.000Z')).toEqual([]);
    expect((await at('2026-10-20T16:00:00.000Z')).map((row) => row.id)).toEqual([EVENT.id]);
    expect(await at('2026-10-20T16:01:00.000Z')).toEqual([]);
    expect(await sessionEventsCovering(store.env, 'other', new Date('2026-10-20T15:10:00.000Z'))).toEqual([]);
  });

  it('lists the events that start in a range', async () => {
    const list = await sessionEventsStarting(store.env, new Date('2026-10-20T14:00:00.000Z'), new Date('2026-10-20T15:30:00.000Z'));
    expect(list.map((row) => row.id)).toEqual([EVENT.id]);
    expect(await sessionEventsStarting(store.env, new Date('2026-10-20T15:00:01.000Z'), new Date('2026-10-21T00:00:00.000Z'))).toEqual([]);
  });
});

describe('event sign-up store: what one store has to hold on its own', () => {
  it('d1: a public slug is unique', async () => {
    await d1.reset();
    await d1.seed(EVENT);
    await expect(d1.seed({ ...EVENT, id: 'abcdef12-0000-4000-8000-000000000009' })).rejects.toThrow(/UNIQUE/u);
  });

  it('core: an unreachable Core is an error, never an empty answer', async () => {
    await core.reset();
    coreState.down = true;
    await expect(sessionEventBySlug(core.env, EVENT.slug)).rejects.toMatchObject({ status: 503 });
  });

  it('core: an answer from a Core without the description field reads as null, so either side deploys first', () => {
    const { description: _description, ...older } = { ...EVENT, time_zone: null, room_slug: 'rosa', cta_url: null, cta_label: null, follow_up_note: null, registration_count: 0 };
    expect(sessionEventRecordSchema.parse(older).description).toBeNull();
  });
});
