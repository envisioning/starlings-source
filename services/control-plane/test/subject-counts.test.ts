import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CrmSubjectCountsResponse } from '@starlings/contracts';
import { purgeAllCoreCache } from '../src/core-cache';

// The Work sidebar's status badges: one Worker request per kind, answered
// from Core's `counts=1` mode on meet-crm-subjects (docs/WORK.md). These pin
// the split into envisioning / client for projects, the plain shape for
// leads, and the sixty-second cache that a subject write purges.

const rosa = { email: 'counts-rosa@example.com', name: 'Rosa' };
const CORE_SECRET = 'core-test-secret-with-at-least-32-characters';

async function session() {
  const response = await exports.default.fetch(new Request('http://local/api/dev/session', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rosa),
  }));
  const body = await response.json<{ access_token: string }>();
  return { authorization: `Bearer ${body.access_token}` };
}

function withCore() {
  const configured = (env as Env).INTERNAL_REQUEST_SECRET;
  (env as Env).INTERNAL_REQUEST_SECRET = CORE_SECRET;
  const seen: URL[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    seen.push(url);
    const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    if (url.pathname.endsWith('meet-crm-subjects') && url.searchParams.get('counts') === '1') {
      if (url.searchParams.get('kind') === 'project') {
        return json({ ok: true, counts: { all: 5, open: 3, Active: 2, Paused: 1, Archived: 2 }, internal: { all: 2, open: 1, Active: 1, Archived: 1 } });
      }
      return json({ ok: true, counts: { all: 3, open: 3, Conversations: 2, 'Closed Won': 1 } });
    }
    if (url.pathname.endsWith('meet-crm-subjects') && (init?.method ?? 'GET') === 'PATCH') {
      return json({ ok: true, subject: { id: url.searchParams.get('id'), kind: 'project', title: 'Renamed', subtitle: null, organization_logo_url: null, open_tasks: 0, overdue_tasks: 0, has_repo: false, status: 'Active', updated_at: null, fields: {} } });
    }
    return new Response('{}', { status: 404 });
  });
  return { seen, restore: () => { (env as Env).INTERNAL_REQUEST_SECRET = configured ?? ''; } };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await purgeAllCoreCache();
  await env.USAGE.prepare("DELETE FROM people WHERE email LIKE 'counts-%'").run();
});

describe('subject counts', () => {
  it('splits project counts into envisioning and client', async () => {
    const core = withCore();
    const headers = await session();
    const response = await exports.default.fetch(new Request('http://local/api/crm/subject-counts?kind=project', { headers }));
    expect(response.status).toBe(200);
    const body = await response.json<CrmSubjectCountsResponse>();
    expect(body.counts).toEqual({ all: 5, open: 3, Active: 2, Paused: 1, Archived: 2 });
    expect(body.internal).toEqual({ all: 2, open: 1, Active: 1, Archived: 1 });
    expect(body).not.toHaveProperty('envisioning');
    expect(body.client).toEqual({ all: 3, open: 2, Active: 1, Paused: 1, Archived: 1 });
    expect(response.headers.get('etag')).toBeTruthy();
    core.restore();
  });

  it('answers leads with counts alone and passes the query through', async () => {
    const core = withCore();
    const headers = await session();
    const response = await exports.default.fetch(new Request('http://local/api/crm/subject-counts?kind=lead&q=acme', { headers }));
    const body = await response.json<CrmSubjectCountsResponse>();
    expect(body).toEqual({ counts: { all: 3, open: 3, Conversations: 2, 'Closed Won': 1 } });
    expect(core.seen.some((url) => url.searchParams.get('kind') === 'lead' && url.searchParams.get('q') === 'acme')).toBe(true);
    core.restore();
  });

  it('refuses partners', async () => {
    const core = withCore();
    const headers = await session();
    const response = await exports.default.fetch(new Request('http://local/api/crm/subject-counts?kind=partner', { headers }));
    expect(response.status).toBe(400);
    core.restore();
  });

  it('serves the plain read from the Core cache until a subject write', async () => {
    const core = withCore();
    const headers = await session();
    const countCalls = () => core.seen.filter((url) => url.searchParams.get('counts') === '1').length;
    await exports.default.fetch(new Request('http://local/api/crm/subject-counts?kind=project', { headers }));
    await exports.default.fetch(new Request('http://local/api/crm/subject-counts?kind=project', { headers }));
    expect(countCalls()).toBe(1);
    const id = 'c0ffee00-0000-4000-8000-0000000000bb';
    const patched = await exports.default.fetch(new Request(`http://local/api/crm/subjects/project/${id}`, {
      method: 'PATCH', headers: { ...headers, 'content-type': 'application/json', origin: 'http://local' }, body: JSON.stringify({ title: 'Renamed' }),
    }));
    expect(patched.status).toBe(200);
    await exports.default.fetch(new Request('http://local/api/crm/subject-counts?kind=project', { headers }));
    expect(countCalls()).toBe(2);
    core.restore();
  });
});
