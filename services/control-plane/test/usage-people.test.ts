import { env, exports } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { decodeJwt } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { signOwnerSession } from '../src/auth';
import { recordOwnerSignIn } from '../src/usage';

const rosa = { sub: 'google-sub-rosa', email: 'rosa@example.com', name: 'Rosa' };
const colleague = { sub: 'google-sub-ada', email: 'ada@example.com', name: 'Ada' };

async function people(sub: string) {
  return env.USAGE.prepare('SELECT * FROM people WHERE sub = ?1').bind(sub).first<{
    sub: string;
    email: string;
    name: string;
    first_seen_at: number;
    last_seen_at: number;
    room_slug: string | null;
    calendar_connected: number;
    last_client: string | null;
  }>();
}

async function peopleCount() {
  const row = await env.USAGE.prepare('SELECT COUNT(*) AS n FROM people').first<{ n: number }>();
  return row?.n ?? 0;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await env.USAGE.prepare('DELETE FROM people WHERE sub IN (?1, ?2, ?3)')
    .bind(rosa.sub, colleague.sub, `dev:${rosa.email}`)
    .run();
  await env.USAGE.prepare('DELETE FROM rooms').run();
});

describe('people ledger', () => {
  it('inserts one row per Google sub and moves last_seen_at on re-auth', async () => {
    await recordOwnerSignIn(env as Env, rosa, 'web', 1_700_000_000_000);
    await recordOwnerSignIn(env as Env, { ...rosa, name: 'ROSA' }, 'mac', 1_700_000_100_000);

    expect(await peopleCount()).toBe(1);
    const row = await people(rosa.sub);
    expect(row).toMatchObject({
      email: 'rosa@example.com',
      name: 'ROSA',
      first_seen_at: 1_700_000_000_000,
      last_seen_at: 1_700_000_100_000,
      room_slug: 'rosa',
      last_client: 'mac',
      calendar_connected: 0,
    });
  });

  it('gives a member who is not in OWNER_ROOM_MAP a room of their own in D1 (meet#878)', async () => {
    await recordOwnerSignIn(env as Env, colleague, 'ios', 1_700_000_000_000);
    const row = await people(colleague.sub);
    expect(row?.room_slug).toBe('ada');
    expect(row?.last_client).toBe('ios');
  });

  it('marks calendar_connected when a refresh token is stored', async () => {
    await env.CALENDAR_TOKENS.put(`calendar:refresh:${rosa.sub}`, 'sealed-token');
    await recordOwnerSignIn(env as Env, rosa, 'web', 1_700_000_000_000);
    expect((await people(rosa.sub))?.calendar_connected).toBe(1);
    await env.CALENDAR_TOKENS.delete(`calendar:refresh:${rosa.sub}`);
  });

  it('does not fail a session mint when D1 throws', async () => {
    const broken = {
      ...env,
      USAGE: { prepare() { throw new Error('d1 down'); } },
    } as unknown as Env;
    const token = await signOwnerSession(rosa, broken, { lastClient: 'web' });
    expect(decodeJwt(token).sub).toBe(rosa.sub);
    expect(await peopleCount()).toBe(0);
  });

  it('records a people row behind waitUntil on /api/dev/session', async () => {
    const ctx = createExecutionContext();
    await signOwnerSession(rosa, env as Env, { lastClient: 'web', ctx });
    await waitOnExecutionContext(ctx);
    expect((await people(rosa.sub))?.last_client).toBe('web');
  });

  it('still mints a dev session when the ledger write is in flight', async () => {
    const response = await exports.default.fetch(new Request('http://local/api/dev/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Rosa', email: 'rosa@example.com' }),
    }));
    expect(response.status).toBe(200);
  });
});
