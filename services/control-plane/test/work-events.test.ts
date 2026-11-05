/**
 * Creating and editing an event on a `d1` workspace (meet#971,
 * docs/EVENTS.md §An event on a `d1` workspace, docs/SESSIONS.md §0 S8):
 * the slug rule, the room rule, the work-module gate, and the sign-up page
 * the event then has.
 */
import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkEventOptions, WorkEventResponse } from '@starlings/contracts/event-signups';
import { zonedInstant, zonedWallClock } from '@starlings/contracts/event-signups';
import worker from '../src/index';
import { resetRoleCache } from '../src/capabilities';

const d1 = { ...env, WORK_STORE: 'd1' } as Env;
const MEMBER = 'workevent-ana@example.com';

async function invoke(request: Request): Promise<Response> {
  const context = createExecutionContext();
  const response = await worker.fetch(request, d1, context);
  await waitOnExecutionContext(context);
  return response;
}

async function member(): Promise<Record<string, string>> {
  const session = await invoke(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: MEMBER, name: 'Ana' }),
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

const DRAFT = {
  title: 'Starlings at work',
  description: 'A live call where Starlings runs a real project.',
  body: '## What happens\n\nA real project, live.',
  date: '2099-10-20',
  start_time: '17:00',
  end_time: '17:45',
  time_zone: 'Europe/Amsterdam',
  public_slug: 'Starlings-At-Work',
  room_slug: 'rosa',
  cta_url: 'https://site.example/interest?source=artificial-insights',
  cta_label: 'Ask about a pilot',
  follow_up_note: 'Thanks for coming.',
};

async function setModules(on: string[]): Promise<void> {
  await env.USAGE.prepare(
    "INSERT OR REPLACE INTO workspace_settings (key, value, updated_by, updated_at) VALUES ('work_modules', ?1, 'test', 0)",
  ).bind(JSON.stringify({ on })).run();
}

beforeEach(async () => {
  resetRoleCache();
  await env.USAGE.batch([env.USAGE.prepare('DELETE FROM event_registrations'), env.USAGE.prepare('DELETE FROM events')]);
  await setModules(['events']);
});

afterEach(async () => {
  await env.USAGE.prepare("DELETE FROM workspace_settings WHERE key = 'work_modules'").run();
});

describe('zone arithmetic', () => {
  it('turns a wall clock in a zone into an instant and back', () => {
    expect(zonedInstant('2099-10-20', '17:00', 'Europe/Amsterdam')).toBe('2099-10-20T15:00:00.000Z');
    expect(zonedInstant('2099-01-20', '17:00', 'Europe/Amsterdam')).toBe('2099-01-20T16:00:00.000Z');
    expect(zonedWallClock('2099-10-20T15:00:00.000Z', 'Europe/Amsterdam')).toEqual({ date: '2099-10-20', time: '17:00' });
  });
});

describe('an event in Work on a d1 workspace', () => {
  it('creates an event with a sign-up page and reads it back', async () => {
    const headers = await member();
    const options = await (await call(headers, 'GET', '/api/work/events/options')).json<WorkEventOptions>();
    // The member's own room, made at sign-in (meet#878), and the map's.
    expect(options).toEqual({ rooms: ['ana', 'rosa'], can_create: true });
    const created = await call(headers, 'POST', '/api/work/events', DRAFT);
    expect(created.status, await created.clone().text()).toBe(201);
    const { event } = await created.json<WorkEventResponse>();
    expect(event).toMatchObject({
      title: 'Starlings at work', description: DRAFT.description, body: DRAFT.body, date: '2099-10-20', start_time: '17:00', end_time: '17:45',
      starts_at: '2099-10-20T15:00:00.000Z', public_slug: 'starlings-at-work', room_slug: 'rosa',
      public_url: `${new URL(env.WEB_ORIGIN).origin}/event/starlings-at-work`,
    });
    const page = await invoke(new Request('http://local/api/events/starlings-at-work'));
    expect(page.status).toBe(200);
    expect((await page.json<{ event: { description: string | null; body: string | null } }>()).event).toMatchObject({ description: DRAFT.description, body: DRAFT.body });
    const subjects = await (await call(headers, 'GET', '/api/crm/subjects?kind=event')).json<{ subjects: Array<{ id: string; event_date: string }> }>();
    expect(subjects.subjects).toEqual([expect.objectContaining({ id: event.id, event_date: '2099-10-20' })]);
  });

  it('edits only the fields it is given, and null clears one', async () => {
    const headers = await member();
    const { event } = await (await call(headers, 'POST', '/api/work/events', DRAFT)).json<WorkEventResponse>();
    const response = await call(headers, 'PATCH', `/api/work/events/${event.id}`, { end_time: '18:00', cta_label: null, description: null });
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await response.json<WorkEventResponse>()).event).toMatchObject({ title: 'Starlings at work', end_time: '18:00', cta_label: null, description: null, cta_url: DRAFT.cta_url });
  });

  it('keeps the slug unique, lower case, letters, digits and hyphens', async () => {
    const headers = await member();
    expect((await call(headers, 'POST', '/api/work/events', DRAFT)).status).toBe(201);
    expect((await call(headers, 'POST', '/api/work/events', { ...DRAFT, public_slug: 'starlings-at-work' })).status).toBe(409);
    expect((await call(headers, 'POST', '/api/work/events', { ...DRAFT, public_slug: 'no spaces here' })).status).toBe(400);
    expect((await call(headers, 'POST', '/api/work/events', { ...DRAFT, public_slug: '-edge-' })).status).toBe(400);
  });

  it('takes only one of the workspace’s rooms', async () => {
    const headers = await member();
    expect((await call(headers, 'POST', '/api/work/events', { ...DRAFT, room_slug: 'someone-else' })).status).toBe(400);
  });

  it('refuses an end before the start and a zone nobody knows', async () => {
    const headers = await member();
    expect((await call(headers, 'POST', '/api/work/events', { ...DRAFT, end_time: '16:00' })).status).toBe(400);
    expect((await call(headers, 'POST', '/api/work/events', { ...DRAFT, time_zone: 'Mars/Olympus' })).status).toBe(400);
  });

  it('hides events and refuses the write when the Events work module is off', async () => {
    const headers = await member();
    await setModules([]);
    expect((await call(headers, 'GET', '/api/work/events/options')).status).toBe(404);
    expect((await call(headers, 'POST', '/api/work/events', DRAFT)).status).toBe(409);
  });
});
