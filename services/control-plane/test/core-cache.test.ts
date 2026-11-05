// The Worker-side cache in front of the board's and feed's Core fan-out
// (core-cache.ts): a second read inside the TTL costs Core nothing, and a
// write Meet makes purges what it changed.
import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordOwnerSignIn } from '../src/usage';
import { taskCacheKeys } from '../src/crm';
import { cachedRead, purgeAllCoreCache, purgeCoreCache, staleOnError } from '../src/core-cache';

const rosa = { sub: 'cache-rosa', email: 'cache-rosa@example.com', name: 'Rosa' };
const CORE_SECRET = 'core-test-secret-with-at-least-32-characters';
const project = { id: 'c0ffee00-0000-4000-8000-00000000c0de', kind: 'project', title: 'Acme rollout', subtitle: 'Acme', has_repo: false, open_tasks: 1 };

async function session(person: { email: string; name: string }) {
  const response = await exports.default.fetch(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(person),
  }));
  const body = await response.json<{ access_token: string }>();
  await recordOwnerSignIn(env as Env, { sub: `dev:${person.email}`, ...person }, 'mac');
  return { authorization: `Bearer ${body.access_token}` };
}

function withCore() {
  const configured = (env as Env).INTERNAL_REQUEST_SECRET;
  (env as Env).INTERNAL_REQUEST_SECRET = CORE_SECRET;
  const calls = { subjects: 0, interactions: 0 };
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    if (url.pathname.endsWith('meet-crm-subjects')) {
      calls.subjects += 1;
      const active = url.searchParams.get('kind') === 'project' && url.searchParams.get('status') === 'Active';
      return json({ ok: true, subjects: active ? [project] : [], has_more: false });
    }
    if (url.pathname.endsWith('meet-crm-interactions')) {
      calls.interactions += 1;
      return json({ ok: true, interactions: [] });
    }
    return new Response('{}', { status: 404 });
  });
  return { calls, restore: () => { (env as Env).INTERNAL_REQUEST_SECRET = configured ?? ''; } };
}

beforeEach(async () => {
  await purgeAllCoreCache();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await env.USAGE.prepare("DELETE FROM people WHERE email LIKE 'cache-%'").run();
});

describe('taskCacheKeys', () => {
  it('a partner-only task purges the all-partners read too; a task on something else does not', () => {
    expect(taskCacheKeys({ organization_id: 'org-1' })).toEqual(['tasks/organization/org-1', 'tasks/partner/all']);
    expect(taskCacheKeys({ organization_id: 'org-1', project_id: 'p-1' })).toEqual(['tasks/project/p-1']);
  });
});

describe('cachedRead', () => {
  it('reads once inside the TTL and again after a purge', async () => {
    let reads = 0;
    const read = () => cachedRead(`tasks/project/${project.id}`, async () => { reads += 1; return [reads]; });
    expect(await read()).toEqual([1]);
    expect(await read()).toEqual([1]);
    await purgeCoreCache([`tasks/project/${project.id}`]);
    expect(await read()).toEqual([2]);
  });

  it('does not keep a value the reader disowns', async () => {
    let reads = 0;
    const read = () => cachedRead(`issues/${project.id}`, async () => { reads += 1; return reads; }, { keep: (value) => value > 1 });
    expect(await read()).toBe(1);
    expect(await read()).toBe(2);
    expect(await read()).toBe(2);
  });
});

describe('GET /api/crm/feed through the cache', () => {
  it('fans out to Core once for two reads', async () => {
    const headers = await session(rosa);
    const core = withCore();
    try {
      const first = await exports.default.fetch(new Request('http://local/api/crm/feed', { headers }));
      expect(first.status).toBe(200);
      const afterFirst = { ...core.calls };
      expect(afterFirst.subjects).toBeGreaterThan(0);
      expect(afterFirst.interactions).toBe(1);
      const second = await exports.default.fetch(new Request('http://local/api/crm/feed', { headers }));
      expect(second.status).toBe(200);
      expect(core.calls).toEqual(afterFirst);
    } finally {
      core.restore();
    }
  });
});

// envisioning/starlings#602: the Cache API does nothing on workers.dev, so the
// last-known copy never existed in production. These run against KV.
describe('the last-known copy', () => {
  const key = `tasks/project/${project.id}` as const;
  const unavailable = (status?: number) => Object.assign(new Error(status ? `Core task list failed (${status})` : 'network'), status ? { status } : {});

  function warnings() {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    return () => warn.mock.calls.map(([line]) => JSON.parse(String(line)) as { event: string; key?: string });
  }

  for (const status of [429, 500, 503, undefined]) {
    it(`serves it when Core answers ${status ?? 'nothing at all'}, and says so`, async () => {
      const logged = warnings();
      expect(await cachedRead(key, async () => ['from core'])).toEqual(['from core']);
      // The sixty-second copy is gone (a write purged it, or its time ran out); the week-long one stays.
      await purgeCoreCache([key]);
      const answer = await cachedRead(key, async () => { throw unavailable(status); });
      expect(answer).toEqual(['from core']);
      expect(logged()).toContainEqual({ event: 'core-cache.stale_served', key, error: expect.any(String) });
    });
  }

  it('still errors on a cold cache', async () => {
    await expect(cachedRead(key, async () => { throw unavailable(500); })).rejects.toMatchObject({ status: 500 });
  });

  it('does not hide a 4xx that means no', async () => {
    await cachedRead(key, async () => ['from core']);
    await purgeCoreCache([key]);
    await expect(cachedRead(key, async () => { throw unavailable(404); })).rejects.toMatchObject({ status: 404 });
  });

  it('covers a read that must stay live (staleOnError) without caching it fresh', async () => {
    let reads = 0;
    const live = () => staleOnError('tasks-open/all', async () => { reads += 1; return [reads]; });
    expect(await live()).toEqual([1]);
    expect(await live()).toEqual([2]);
    expect(reads).toBe(2);
    expect(await staleOnError('tasks-open/all', async () => { throw unavailable(429); })).toEqual([1]);
  });

  it('keeps an answer that was legitimately empty', async () => {
    await cachedRead(key, async () => null);
    await purgeCoreCache([key]);
    expect(await cachedRead(key, async () => { throw unavailable(500); })).toBeNull();
  });

  it('survives a KV that fails: the read is live, never an error', async () => {
    const kv = (env as Env).CORE_CACHE;
    vi.spyOn(kv, 'get').mockRejectedValue(new Error('KV GET failed: 503'));
    vi.spyOn(kv, 'put').mockRejectedValue(new Error('KV PUT failed: 429'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await cachedRead(key, async () => ['live'])).toEqual(['live']);
  });
});

describe('GET /api/crm/tasks when Core cannot answer', () => {
  it('answers from the last-known list, and fails when there is none', async () => {
    const headers = await session(rosa);
    const core = withCore();
    const task = {
      id: 't-1', title: 'Call Acme', status: 'todo', notes: null, responsible_party: 'us', assignee_id: null, assignee_name: null,
      assignee_email: null, due_date: null, project_id: project.id, lead_id: null, updated_at: '2026-10-01T00:00:00Z',
    };
    let mode: 'ok' | 'down' = 'ok';
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (!url.pathname.endsWith('meet-crm-tasks')) return new Response('{}', { status: 404 });
      return mode === 'down'
        ? new Response('upstream', { status: 500 })
        : new Response(JSON.stringify({ ok: true, tasks: [task] }), { headers: { 'content-type': 'application/json' } });
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const read = (id: string) => exports.default.fetch(new Request(`http://local/api/crm/tasks?project_id=${id}`, { headers }));
      expect((await read(project.id)).status).toBe(200);
      mode = 'down';
      const stale = await read(project.id);
      expect(stale.status).toBe(200);
      expect((await stale.json<{ tasks: Array<{ id: string }> }>()).tasks.map((row) => row.id)).toEqual(['t-1']);
      expect((await read('c0ffee00-0000-4000-8000-00000000beef')).status).toBeGreaterThanOrEqual(500);
    } finally {
      core.restore();
    }
  });
});
