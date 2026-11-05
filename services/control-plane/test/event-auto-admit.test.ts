/**
 * Auto-admit with a registration link (meet#969, docs/SESSIONS.md §7, §9
 * phase 3): the five conditions, the roster refetch, the host's door, and the
 * store failing at arm and mid-session.
 */
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../src/crypto';
import { registerForSession, sessionEventById, cancelSessionRegistration } from '../src/event-signups';
import { armSessionIfDue, refreshRosterBeforeKnock } from '../src/session-arming';

const d1 = { ...env, WORK_STORE: 'd1' } as Env;
const OWNER = { sub: 'admit-owner', email: 'admit-owner@example.com', name: 'Admit Owner' };
const EVENT_ID = 'abcdef12-0000-4000-8000-0000000000cc';
const TOKEN = 'RegisteredToken00001';
const MINUTE = 60_000;

let roomCounter = 0;

async function openRoom() {
  roomCounter += 1;
  const slug = `admit-room-${roomCounter}`;
  const room = env.ROOMS.getByName(slug);
  await room.configureRoom({ slug, ownerSub: OWNER.sub, ownerEmail: OWNER.email, kind: 'permanent', expiresAt: null });
  const meeting = await room.startMeeting(OWNER);
  return { slug, room, meeting };
}

/** An armed meeting whose window is [start, start + 45 min], with TOKEN on the roster. */
async function armedRoom(startOffset = 0) {
  const opened = await openRoom();
  const startsAt = Date.now() + startOffset;
  await opened.room.armSession(opened.meeting.id, { event_id: EVENT_ID, starts_at: startsAt, ends_at: startsAt + 45 * MINUTE }, [await sha256Hex(TOKEN)]);
  return opened;
}

function knock(room: Awaited<ReturnType<typeof openRoom>>['room'], token: string | null = TOKEN, name = 'Ada') {
  return room.requestJoin({ name, email: 'ada@example.test', ...(token ? { booking_token: token } : {}) });
}

beforeEach(async () => {
  await env.USAGE.batch([env.USAGE.prepare('DELETE FROM event_registrations'), env.USAGE.prepare('DELETE FROM events')]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('auto-admit', () => {
  it('lets a registered guest in with no host click, and the host sees "registered"', async () => {
    const { room } = await armedRoom();
    const receipt = await knock(room);
    expect(receipt.status).toBe('admitted');
    const lobby = await room.lobbySnapshot(OWNER.sub);
    expect(lobby.requests.find((request) => request.id === receipt.requestId)).toMatchObject({ registered: true });
    expect(lobby.meeting).toMatchObject({ session_door_open: true });
    const admission = await room.exchangeAdmission(receipt.requestId, receipt.lobbyToken);
    expect(admission).toMatchObject({ registered: true, session: true });
  });

  it('lets one token in three times; the fourth knocks', async () => {
    const { room } = await armedRoom();
    for (let attempt = 0; attempt < 3; attempt += 1) expect((await knock(room)).status).toBe('admitted');
    expect((await knock(room)).status).toBe('waiting');
  });

  it('makes an unknown token and a bare knock wait', async () => {
    const { room } = await armedRoom();
    expect((await knock(room, 'SomeOtherToken0001')).status).toBe('waiting');
    expect((await knock(room, null)).status).toBe('waiting');
  });

  it('admits from 15 minutes before the start, not earlier', async () => {
    expect((await knock((await armedRoom(14 * MINUTE)).room)).status).toBe('admitted');
    expect((await knock((await armedRoom(16 * MINUTE)).room)).status).toBe('waiting');
  });

  it('admits until 15 minutes after the end, not later', async () => {
    expect((await knock((await armedRoom(-59 * MINUTE)).room)).status).toBe('admitted');
    expect((await knock((await armedRoom(-61 * MINUTE)).room)).status).toBe('waiting');
  });

  it('makes everyone knock once the host closes the door', async () => {
    const { room } = await armedRoom();
    expect(await room.closeSessionDoor(OWNER.sub)).toEqual({ session_door_open: false });
    expect((await knock(room)).status).toBe('waiting');
    expect((await room.lobbySnapshot(OWNER.sub)).meeting).toMatchObject({ session_door_open: false });
  });

  it('has no door to close on a plain meeting', async () => {
    const { room } = await openRoom();
    let refused: unknown;
    try {
      await room.closeSessionDoor(OWNER.sub);
    } catch (error) {
      refused = error;
    }
    expect(String(refused)).toMatch(/No event session/u);
  });

  it('stops at the capacity guard', async () => {
    const { room, meeting } = await armedRoom();
    await runInDurableObject(room, async (_instance, state) => {
      for (let n = 0; n < 99; n += 1) {
        state.storage.sql.exec(
          `INSERT INTO join_requests (id, meeting_id, name, email, transcript_opt_in, identity, lobby_token_hash, status, created_at)
           VALUES (?, ?, 'Guest', '', 0, ?, 'x', 'joined', ?)`,
          `full-${n}`, meeting.id, `guest:full-${n}`, Date.now() - MINUTE,
        );
      }
    });
    expect((await knock(room)).status).toBe('waiting');
  });
});

describe('the roster from the store', () => {
  async function seed(room: string): Promise<void> {
    const start = Date.now();
    await env.USAGE.prepare(`
      INSERT INTO events (id, title, starts_on, public_slug, starts_at, ends_at, room_slug, created_at, updated_at)
      VALUES (?1, 'Starlings at work', '2026-10-20', 'starlings-at-work', ?2, ?3, ?4, 0, 0)`)
      .bind(EVENT_ID, start + 5 * MINUTE, start + 50 * MINUTE, room)
      .run();
    const event = await sessionEventById(d1, EVENT_ID);
    await registerForSession(d1, event!, { name: 'Ada', email: 'ada@example.test', join_token: TOKEN, ics_uid: 'uid-1' }, new Date(start - 24 * 60 * MINUTE));
  }

  it('arms with the live hashes, so a registered guest walks in', async () => {
    const { slug, room, meeting } = await openRoom();
    await seed(slug);
    expect(await armSessionIfDue(d1, slug, meeting.id)).toBe(true);
    expect((await knock(room)).status).toBe('admitted');
  });

  it('refetches a minute later: a registration cancelled after arming knocks', async () => {
    const { slug, room, meeting } = await openRoom();
    await seed(slug);
    await armSessionIfDue(d1, slug, meeting.id);
    await cancelSessionRegistration(d1, TOKEN);
    await refreshRosterBeforeKnock(d1, slug, Date.now() + 61_000);
    expect((await knock(room)).status).toBe('waiting');
  });

  it('refetches at most once a minute', async () => {
    const { slug, room, meeting } = await openRoom();
    await seed(slug);
    await armSessionIfDue(d1, slug, meeting.id);
    await cancelSessionRegistration(d1, TOKEN);
    await refreshRosterBeforeKnock(d1, slug, Date.now() + 30_000);
    expect((await knock(room)).status).toBe('admitted');
  });

  it('keeps the roster it has when the store fails mid-session', async () => {
    const { slug, room, meeting } = await openRoom();
    await seed(slug);
    await armSessionIfDue(d1, slug, meeting.id);
    const core = { ...env, INTERNAL_REQUEST_SECRET: 'meet-core-shared-secret-at-least-32-chars' } as Env;
    vi.stubGlobal('fetch', async () => { throw new TypeError('fetch failed'); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await refreshRosterBeforeKnock(core, slug, Date.now() + 61_000);
    expect((await knock(room)).status).toBe('admitted');
    expect((await knock(room, 'SomeOtherToken0001')).status).toBe('waiting');
  });
});
