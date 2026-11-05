// The Worker's own Core tokens are shared between isolates (meet#602). Core's
// owner exchange revokes every live token under the same device name when it
// mints a new one, so two isolates that each minted their own would take turns
// invalidating each other.
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { corePatFetch, resetCorePatCache } from '../src/crm';

const secretEnv = { ...env, INTERNAL_REQUEST_SECRET: 'meet-core-shared-secret-at-least-32-chars', CRM_SYNC_MODE: 'on' } as Env;
const ACTOR = 'pat-rosa@example.com';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A Core that mints `core_pat_1`, `core_pat_2`, … and honours only the newest, as the real exchange does. */
function core() {
  const state = { mints: 0, live: '', seen: [] as string[] };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    if (url.pathname === '/api/public/meet-owner-exchange') {
      state.mints += 1;
      state.live = `core_pat_${state.mints}`;
      return json({ ok: true, token: state.live, scopes: ['search:read'], expires_at: '2099-01-01T00:00:00.000Z', email: ACTOR });
    }
    const token = (request.headers.get('authorization') ?? '').replace('Bearer ', '');
    state.seen.push(token);
    return token === state.live ? json({ data: [] }) : json({ error: 'unauthorized' }, 401);
  });
  return state;
}

const call = () => corePatFetch(secretEnv, ACTOR, '/api/agent/search', { method: 'GET', searchParams: { q: 'x' } });

beforeEach(() => resetCorePatCache());
afterEach(async () => {
  vi.restoreAllMocks();
  await resetCorePatCache();
});

describe('the Worker\'s Core token', () => {
  it('is minted once for all isolates', async () => {
    const upstream = core();
    expect((await call()).status).toBe(200);
    await resetCorePatCache({ isolateOnly: true });
    expect((await call()).status).toBe(200);
    expect(upstream.mints).toBe(1);
    expect(upstream.seen).toEqual(['core_pat_1', 'core_pat_1']);
  });

  it('is sealed at rest: the store holds no token and no address', async () => {
    core();
    await call();
    const { keys } = await secretEnv.CORE_CACHE.list({ prefix: 'pat/' });
    expect(keys).toHaveLength(1);
    expect(keys[0]!.name).not.toContain('pat-rosa');
    const stored = await secretEnv.CORE_CACHE.get(keys[0]!.name);
    expect(stored).not.toContain('core_pat');
    expect(stored).not.toContain('pat-rosa');
  });

  it('is replaced for everybody when Core says it is dead, and not before', async () => {
    const upstream = core();
    await call();
    // Somebody re-paired the device: Core now honours another token.
    upstream.live = 'core_pat_elsewhere';
    expect((await call()).status).toBe(200);
    expect(upstream.mints).toBe(2);
    // A new isolate takes the replacement from the store instead of minting a third.
    await resetCorePatCache({ isolateOnly: true });
    expect((await call()).status).toBe(200);
    expect(upstream.mints).toBe(2);
    expect(upstream.seen.at(-1)).toBe('core_pat_2');
  });

  it('uses the replacement another isolate stored while ours was dying, and leaves it in place', async () => {
    const upstream = core();
    const kv = secretEnv.CORE_CACHE;
    await call();
    const name = (await kv.list({ prefix: 'pat/' })).keys[0]!.name;
    const first = await kv.get(name);
    // Another isolate re-pairs: Core now honours core_pat_2, and the store holds it.
    await resetCorePatCache({ isolateOnly: true });
    await kv.delete(name);
    await call();
    const second = await kv.get(name);
    expect(upstream.live).toBe('core_pat_2');
    // This isolate still holds core_pat_1, which it took from the store before the other one re-paired.
    await kv.put(name, first!);
    await resetCorePatCache({ isolateOnly: true });
    upstream.live = 'core_pat_1';
    expect((await call()).status).toBe(200);
    upstream.live = 'core_pat_2';
    await kv.put(name, second!);
    upstream.seen.length = 0;
    const mintsBefore = upstream.mints;
    expect((await call()).status).toBe(200);
    expect(upstream.seen).toEqual(['core_pat_1', 'core_pat_2']);
    expect(upstream.mints).toBe(mintsBefore);
    expect(await kv.get(name)).toBe(second);
  });
});
