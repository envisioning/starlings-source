/**
 * Creating an Envisioning event from Meet, through Core as the person
 * (meet#972, docs/SESSIONS.md §0 S8): the same form and routes as a `d1`
 * workspace (meet#971); Core's registry decides who may create.
 */
import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkEventOptions, WorkEventResponse } from '@starlings/contracts/event-signups';
import worker from '../src/index';
import { resetCorePatCache } from '../src/crm';
import { resetRoleCache } from '../src/capabilities';

const EVENT_ID = '585d3599-c813-4b98-a741-01a79b6736a1';
const core = {
  ...env,
  CRM_SYNC_MODE: 'on',
  INTERNAL_REQUEST_SECRET: 'a-shared-test-secret-with-at-least-32-characters',
} as Env;

const DRAFT = {
  title: 'Starlings at work',
  description: 'A live call where Starlings runs a real project.',
  body: '## What happens\n\nA real project, live.',
  date: '2099-10-20',
  start_time: '17:00',
  end_time: '17:45',
  time_zone: 'Europe/Amsterdam',
  public_slug: 'ignored-on-core',
  room_slug: 'rosa',
  cta_url: 'https://site.example/interest?source=artificial-insights',
  cta_label: 'Ask about a pilot',
  follow_up_note: 'Thanks for coming.',
};

async function invoke(request: Request): Promise<Response> {
  const context = createExecutionContext();
  const response = await worker.fetch(request, core, context);
  await waitOnExecutionContext(context);
  return response;
}

async function member(): Promise<Record<string, string>> {
  const session = await invoke(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'rosa@example.com', name: 'Rosa' }),
  }));
  return { authorization: `Bearer ${(await session.json<{ access_token: string }>()).access_token}` };
}

function call(headers: Record<string, string>, method: string, path: string, body?: unknown): Promise<Response> {
  return invoke(new Request(`http://local${path}`, {
    method,
    headers: { ...headers, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}

/** Core: the owner exchange, the CMS registry with or without the grant, and the event create. */
function mockCore(grant: boolean): Array<{ method: string; path: string; body: Record<string, unknown> | null }> {
  const agent: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === '/api/public/meet-owner-exchange') {
      return Response.json({
        ok: true,
        token: 'pat-cms-editor',
        scopes: ['cms:read', 'cms:write'],
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        email: 'rosa@example.com',
      });
    }
    if (url.pathname === '/api/agent/cms/meta/registry') {
      return Response.json({
        data: {
          entities: [{
            id: 'events', singularLabel: 'Event', pluralLabel: 'Events', primaryField: 'title',
            capabilities: { create: true, update: true }, fields: [], access: { canRead: true, canWrite: grant },
          }],
        },
      });
    }
    if (url.pathname.startsWith('/api/agent/cms/events')) {
      const body = request.method === 'GET' ? null : await request.json<Record<string, unknown>>();
      agent.push({ method: request.method, path: url.pathname, body });
      return Response.json({
        data: { id: EVENT_ID, ...body, start_at: '2099-10-20T15:00:00+00:00' },
      }, { status: request.method === 'POST' ? 201 : 200 });
    }
    return Response.json({ error: `unmocked ${request.method} ${url.pathname}` }, { status: 404 });
  });
  return agent;
}

beforeEach(() => {
  resetCorePatCache();
  resetRoleCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('an Envisioning event from the Work form', () => {
  it('creates the CMS event through Core, unpublished, with its sign-up fields', async () => {
    const agent = mockCore(true);
    const headers = await member();
    expect(await (await call(headers, 'GET', '/api/work/events/options')).json<WorkEventOptions>()).toMatchObject({ can_create: true });
    const created = await call(headers, 'POST', '/api/work/events', DRAFT);
    expect(created.status, await created.clone().text()).toBe(201);
    expect(agent).toEqual([{
      method: 'POST',
      path: '/api/agent/cms/events',
      body: {
        title: 'Starlings at work', description: DRAFT.description, body: DRAFT.body, event_date: '2099-10-20', start_time: '17:00', timezone: 'Europe/Amsterdam', duration_minutes: 45,
        meet_room_slug: 'rosa', cta_url: DRAFT.cta_url, cta_label: 'Ask about a pilot', follow_up_note: 'Thanks for coming.', is_published: false,
      },
    }]);
    const { event } = await created.json<WorkEventResponse>();
    expect(event).toMatchObject({
      id: EVENT_ID, description: DRAFT.description, start_time: '17:00', end_time: '17:45', room_slug: 'rosa',
      public_slug: 'starlings-at-work-585d3599',
      public_url: `${new URL(env.WEB_ORIGIN).origin}/event/starlings-at-work-585d3599`,
    });
  });

  it('offers no create, and refuses one, without the Core grant', async () => {
    const agent = mockCore(false);
    const headers = await member();
    expect(await (await call(headers, 'GET', '/api/work/events/options')).json<WorkEventOptions>()).toMatchObject({ can_create: false });
    expect((await call(headers, 'POST', '/api/work/events', DRAFT)).status).toBe(403);
    expect(agent).toEqual([]);
  });
});
