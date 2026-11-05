/**
 * A registration link opens the join card, and the room knows it is a session
 * (meet#968, docs/SESSIONS.md §7 arming, §8 posture, §9 phase 2 acceptance).
 */
import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchPublicBookingProjection } from '../src/schedule-proxy';
import { armSessionIfDue } from '../src/session-arming';
import { registerForSession, sessionEventById } from '../src/event-signups';

const d1 = { ...env, WORK_STORE: 'd1' } as Env;
const ROOM = 'session-room';
const EVENT_ID = 'abcdef12-0000-4000-8000-0000000000bb';
const TOKEN = 'RegistrationToken0001';
const OWNER = { sub: 'session-owner', email: 'session-owner@example.com', name: 'Session Owner' };

async function seedEvent(startsAt: number, room = ROOM): Promise<void> {
  await env.USAGE.prepare(`
    INSERT INTO events (id, title, starts_on, public_slug, starts_at, ends_at, time_zone, room_slug, created_at, updated_at)
    VALUES (?1, 'Starlings at work', '2026-10-20', 'starlings-at-work', ?2, ?3, 'Europe/Amsterdam', ?4, 0, 0)`)
    .bind(EVENT_ID, startsAt, startsAt + 45 * 60_000, room)
    .run();
}

async function register(): Promise<void> {
  const event = await sessionEventById(d1, EVENT_ID);
  await registerForSession(d1, event!, { name: 'Ada Example', email: 'ada@example.test', join_token: TOKEN, ics_uid: 'uid-1@example.test' }, new Date(Date.now() - 60 * 60_000 * 24 * 365));
}

async function openRoom(slug: string) {
  const room = env.ROOMS.getByName(slug);
  await room.configureRoom({ slug, ownerSub: OWNER.sub, ownerEmail: OWNER.email, kind: 'permanent', expiresAt: null });
  return room;
}

beforeEach(async () => {
  await env.USAGE.batch([env.USAGE.prepare('DELETE FROM event_registrations'), env.USAGE.prepare('DELETE FROM events')]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a registration link on the join card', () => {
  it('shows the event title and time, the registrant name and no address', async () => {
    await seedEvent(Date.now() + 60 * 60_000);
    await register();
    const lookup = await fetchPublicBookingProjection(d1, ROOM, TOKEN);
    expect(lookup).toMatchObject({
      outcome: 'found',
      projection: { title: 'Starlings at work', status: 'scheduled', guest_name: 'Ada Example', guest_email: null, session: true },
    });
  });

  it('reads a cancelled registration, or one for another room, as unknown', async () => {
    await seedEvent(Date.now() + 60 * 60_000);
    await register();
    expect(await fetchPublicBookingProjection(d1, 'other-room', TOKEN)).toEqual({ outcome: 'unknown' });
    await env.USAGE.prepare("UPDATE event_registrations SET status = 'cancelled'").run();
    expect(await fetchPublicBookingProjection(d1, ROOM, TOKEN)).toEqual({ outcome: 'unknown' });
  });

  it('renders no card when the store does not answer, never an expired one', async () => {
    const core = { ...env, INTERNAL_REQUEST_SECRET: 'meet-core-shared-secret-at-least-32-chars' } as Env;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new Request(input).url;
      if (url.includes('/booking/')) return new Response('{}', { status: 404 });
      throw new TypeError('fetch failed');
    });
    expect(await fetchPublicBookingProjection(core, 'rosa', TOKEN)).toEqual({ outcome: 'unavailable' });
  });

  it('keeps the bare room door opaque during a session', async () => {
    const response = await exports.default.fetch(new Request('http://local/api/rooms/rosa'));
    const body = await response.json<Record<string, unknown>>();
    expect(body).not.toHaveProperty('title');
    expect(body).not.toHaveProperty('starts_at');
  });
});

describe('arming at room start', () => {
  it('arms a meeting the store has an event for, and only once', async () => {
    await seedEvent(Date.now() + 10 * 60_000);
    const room = await openRoom(ROOM);
    const meeting = await room.startMeeting(OWNER);
    expect(await armSessionIfDue(d1, ROOM, meeting.id)).toBe(true);
    expect(await room.meetingSession(meeting.id)).toMatchObject({ event_id: EVENT_ID });
    expect(await armSessionIfDue(d1, ROOM, meeting.id)).toBe(true);
  });

  it('leaves the meeting plain when no event covers now', async () => {
    await seedEvent(Date.now() + 5 * 60 * 60_000);
    const room = await openRoom('plain-room');
    const meeting = await room.startMeeting(OWNER);
    expect(await armSessionIfDue(d1, 'plain-room', meeting.id)).toBe(false);
    expect(await room.meetingSession(meeting.id)).toBeNull();
  });

  it('leaves the meeting plain when the store does not answer', async () => {
    const core = { ...env, INTERNAL_REQUEST_SECRET: 'meet-core-shared-secret-at-least-32-chars' } as Env;
    vi.stubGlobal('fetch', async () => { throw new TypeError('fetch failed'); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const room = await openRoom('down-room');
    const meeting = await room.startMeeting(OWNER);
    expect(await armSessionIfDue(core, 'down-room', meeting.id)).toBe(false);
    expect(await room.meetingSession(meeting.id)).toBeNull();
  });
});

describe('posture in a session', () => {
  it('flags the join status and the admission, and gives the artifact to the host only', async () => {
    const room = await openRoom('posture-room');
    const meeting = await room.startMeeting(OWNER);
    await room.armSession(meeting.id, { event_id: EVENT_ID, starts_at: Date.now(), ends_at: Date.now() + 60 * 60_000 });
    const receipt = await room.requestJoin({ name: 'Ada', email: 'ada@example.test' });
    expect(await room.joinStatus(receipt.requestId, receipt.lobbyToken)).toMatchObject({ status: 'waiting', session: true });
    await room.decide(OWNER.sub, receipt.requestId, true);
    const admission = await room.exchangeAdmission(receipt.requestId, receipt.lobbyToken);
    expect(admission.session).toBe(true);
    await room.finalizeMeeting(OWNER.sub, meeting.id);
    // Caught directly: a rejected RPC promise left to `expect` is reported as unhandled.
    let denied: unknown;
    try {
      await room.artifactForViewer(meeting.id, admission.identity, 'guest');
    } catch (error) {
      denied = error;
    }
    expect(String(denied)).toMatch(/denied/iu);
    expect((await room.artifactForViewer(meeting.id, OWNER.email, 'owner')).meetingId ?? meeting.id).toBe(meeting.id);
  });

  it('carries no flag on a plain meeting', async () => {
    const room = await openRoom('plain-posture-room');
    await room.startMeeting(OWNER);
    const receipt = await room.requestJoin({ name: 'Ben', email: 'ben@example.test' });
    expect(await room.joinStatus(receipt.requestId, receipt.lobbyToken)).not.toHaveProperty('session');
  });
});
