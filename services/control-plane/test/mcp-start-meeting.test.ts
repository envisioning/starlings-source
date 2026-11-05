/**
 * `start_meeting`'s own half: the ask (meet#279, docs/MCP.md).
 *
 * The calendar write is `schedule`'s, already covered. What is new is
 * `askOwnerToHost`: one row in `rings`, refused when a colleague's ring is
 * already pending, refused when the member has no room. The Worker never
 * opens the room — a device does, or nobody does.
 */
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { askOwnerToHost } from '../src/peers';

const rosa = { sub: 'start-rosa', email: 'rosa@example.com' };
const mutable = env as unknown as { OWNER_ROOM_MAP: string };
let configured: string;

beforeEach(async () => {
  configured = mutable.OWNER_ROOM_MAP;
  mutable.OWNER_ROOM_MAP = JSON.stringify({ [rosa.email]: 'rosa' });
  await env.USAGE.prepare('DELETE FROM rings WHERE callee_sub = ?1').bind(rosa.sub).run();
});

afterEach(async () => {
  mutable.OWNER_ROOM_MAP = configured;
  await env.USAGE.prepare('DELETE FROM rings WHERE callee_sub = ?1').bind(rosa.sub).run();
});

async function ring() {
  return env.USAGE.prepare(
    'SELECT kind, caller_email, caller_name, caller_room_slug, expires_at FROM rings WHERE callee_sub = ?1',
  ).bind(rosa.sub).first<{ kind: string; caller_email: string; caller_name: string; caller_room_slug: string; expires_at: number }>();
}

describe('askOwnerToHost', () => {
  it('leaves one agent_start row naming the client, the member and their own room', async () => {
    const asked = await askOwnerToHost(env as Env, rosa, 'claude.ai');
    expect(asked).toEqual({ asked: true, room: 'rosa' });
    const row = await ring();
    expect(row?.kind).toBe('agent_start');
    // The member is both ends: their Claude asked, and the room is theirs.
    expect(row?.caller_email).toBe(rosa.email);
    expect(row?.caller_name).toBe('claude.ai');
    expect(row?.caller_room_slug).toBe('rosa');
    // The same 45-second clock a wave and a call keep.
    expect(row!.expires_at - Date.now()).toBeGreaterThan(30_000);
    expect(row!.expires_at - Date.now()).toBeLessThanOrEqual(45_000);
  });

  it('refuses rather than overwrite a colleague who is already waving', async () => {
    const now = Date.now();
    await env.USAGE.prepare(
      `INSERT INTO rings (callee_sub, kind, caller_email, caller_name, caller_room_slug, created_at, expires_at)
       VALUES (?1, 'wave', 'tarik@example.org', 'Tarik', NULL, ?2, ?3)`,
    ).bind(rosa.sub, now, now + 45_000).run();

    const asked = await askOwnerToHost(env as Env, rosa, 'claude.ai');
    expect(asked).toEqual({ asked: false, room: 'rosa', reason: 'ring_pending' });
    // `rings` holds one row per person, so the wave must still be the one there.
    expect((await ring())?.kind).toBe('wave');
    expect((await ring())?.caller_name).toBe('Tarik');
  });

  it('takes an expired ring as no ring', async () => {
    const now = Date.now();
    await env.USAGE.prepare(
      `INSERT INTO rings (callee_sub, kind, caller_email, caller_name, caller_room_slug, created_at, expires_at)
       VALUES (?1, 'wave', 'tarik@example.org', 'Tarik', NULL, ?2, ?3)`,
    ).bind(rosa.sub, now - 60_000, now - 15_000).run();

    expect(await askOwnerToHost(env as Env, rosa, 'claude.ai')).toEqual({ asked: true, room: 'rosa' });
    expect((await ring())?.kind).toBe('agent_start');
  });

  it('asks nobody when the member has no room to open', async () => {
    mutable.OWNER_ROOM_MAP = JSON.stringify({});
    expect(await askOwnerToHost(env as Env, rosa, 'claude.ai')).toEqual({ asked: false, room: null, reason: 'no_room' });
    expect(await ring()).toBeNull();
  });
});
