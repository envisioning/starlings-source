import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { coreTask } from './core-rows';
import { awaitBounded, CORE_CONCURRENCY, memoCore, resetCoreGate, retryAfterMs, withCoreRetry } from '../src/core-gate';

// meet#616: Core's 429s. A create retries and lands once; reads share one
// answer; what still fails reads as "busy" and keeps the code.

const rosa = { email: 'gate-rosa@example.com', name: 'Rosa' };
const CORE_SECRET = 'core-test-secret-with-at-least-32-characters';

async function session() {
  const response = await exports.default.fetch(new Request('http://local/api/dev/session', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rosa),
  }));
  const body = await response.json<{ access_token: string }>();
  return { authorization: `Bearer ${body.access_token}`, 'content-type': 'application/json' };
}

const busy = () => new Response('{"error":"rate limited"}', { status: 429, headers: { 'retry-after': '0' } });

afterEach(async () => {
  vi.unstubAllGlobals();
  await env.USAGE.prepare("DELETE FROM people WHERE email LIKE 'gate-%'").run();
});

describe('withCoreRetry', () => {
  it('reads Retry-After as seconds or a date', () => {
    expect(retryAfterMs(new Response(null, { headers: { 'retry-after': '2' } }))).toBe(2000);
    expect(retryAfterMs(new Response(null, { headers: { 'retry-after': 'Wed, 21 Oct 2015 07:28:05 GMT' } }), Date.parse('Wed, 21 Oct 2015 07:28:00 GMT'))).toBe(5000);
    expect(retryAfterMs(new Response(null))).toBeNull();
  });

  it('retries a 429 and stops at the first answer that is not one', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce(busy())
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    expect((await withCoreRetry(send)).status).toBe(200);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('hands back the last 429 after the retries run out', async () => {
    const send = vi.fn(async () => busy());
    expect((await withCoreRetry(send, { retries: 1 })).status).toBe(429);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('never retries a 5xx, which may have been applied', async () => {
    const send = vi.fn(async () => new Response('', { status: 500 }));
    expect((await withCoreRetry(send)).status).toBe(500);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('memoCore', () => {
  it('shares one in-flight read and forgets a failure', async () => {
    const read = vi.fn(async () => 'ok');
    const [a, b] = await Promise.all([memoCore('k', read), memoCore('k', read)]);
    expect([a, b]).toEqual(['ok', 'ok']);
    expect(read).toHaveBeenCalledTimes(1);
    const failing = vi.fn(async () => { throw new Error('no'); });
    await expect(memoCore('bad', failing)).rejects.toThrow('no');
    await expect(memoCore('bad', failing)).rejects.toThrow('no');
    expect(failing).toHaveBeenCalledTimes(2);
  });
});

// meet#613: a Workers request can be cancelled mid-await, and then it runs no
// `finally` and settles no promise. A call that never returns plays one.
const never = () => new Promise<Response>(() => undefined);

describe('a cancelled request cannot jam the gate (meet#613)', () => {
  it('lets a call through after the bounded wait when every slot is held', async () => {
    resetCoreGate({ slotWaitMs: 50 });
    for (let index = 0; index < CORE_CONCURRENCY; index += 1) void withCoreRetry(never);
    const response = await withCoreRetry(async () => new Response('{}', { status: 200 }));
    expect(response.status).toBe(200);
  });

  it('stops counting a slot once its lease has aged out', async () => {
    resetCoreGate({ slotWaitMs: 60_000, slotLeaseMs: 50 });
    for (let index = 0; index < CORE_CONCURRENCY; index += 1) void withCoreRetry(never);
    const response = await withCoreRetry(async () => new Response('{}', { status: 200 }));
    expect(response.status).toBe(200);
  });

  it('reads for itself when a shared read never settles', async () => {
    resetCoreGate({ sharedWaitMs: 50 });
    void memoCore('stuck', () => new Promise<string>(() => undefined));
    const own = vi.fn(async () => 'own');
    await expect(memoCore('stuck', own)).resolves.toBe('own');
    expect(own).toHaveBeenCalledTimes(1);
  });

  it('still shares a read that settles within the bound', async () => {
    let finish: (value: string) => void = () => undefined;
    void memoCore('slow', () => new Promise<string>((resolve) => { finish = resolve; }));
    const second = memoCore('slow', vi.fn(async () => 'second'));
    finish('first');
    await expect(second).resolves.toBe('first');
  });

  it('awaitBounded answers null past the bound and drops a late rejection', async () => {
    let fail: (error: Error) => void = () => undefined;
    const late = new Promise<string>((_, reject) => { fail = reject; });
    await expect(awaitBounded(late, 10)).resolves.toBeNull();
    fail(new Error('late'));
    await expect(awaitBounded(Promise.resolve('now'), 10)).resolves.toEqual({ value: 'now' });
  });
});

describe('task create against a busy Core', () => {
  const configured = () => {
    (env as Env).INTERNAL_REQUEST_SECRET = CORE_SECRET;
    (env as Env).CRM_SYNC_MODE = 'on';
    (env as Env).CORE_API_ORIGIN = 'https://core.test';
  };

  it('retries the POST after a 429 and files the task once', async () => {
    configured();
    let posts = 0;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method === 'POST') {
        posts += 1;
        if (posts === 1) return busy();
        return Response.json({ task: coreTask({ id: '11111111-1111-4111-8111-111111111111', title: 'Rename Team' }) });
      }
      return new Response('{}', { status: 404 });
    });
    const response = await exports.default.fetch(new Request('http://local/api/crm/tasks', {
      method: 'POST', headers: await session(), body: JSON.stringify({ title: 'Rename Team', project_id: '22222222-2222-4222-8222-222222222222' }),
    }));
    expect(response.status).toBe(201);
    expect(posts).toBe(2);
  });

  it('says Core is busy, with the code, when every attempt is refused', async () => {
    configured();
    let posts = 0;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new Request(input, init).method === 'POST') posts += 1;
      return busy();
    });
    const response = await exports.default.fetch(new Request('http://local/api/crm/tasks', {
      method: 'POST', headers: await session(), body: JSON.stringify({ title: 'Rename Team', project_id: '22222222-2222-4222-8222-222222222222' }),
    }));
    expect(response.status).toBe(429);
    const body = await response.json<{ error: string; code: string }>();
    expect(body.code).toBe('rate_limited');
    expect(body.error).toBe('Core is busy, try again in a moment. (task create 429)');
    expect(posts).toBe(3);
  });
});
