import { env } from 'cloudflare:workers';
import { coreTask } from './core-rows';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';

const taskID = '11111111-1111-4111-8111-111111111111';
const personID = '22222222-2222-4222-8222-222222222222';
afterEach(() => vi.restoreAllMocks());

describe('Task edits reach Core', () => {
  it('reads a task by id for a direct Work destination', async () => {
    const context = createExecutionContext();
    const configured = { ...env, CRM_SYNC_MODE: 'on', CORE_API_ORIGIN: 'https://core.test',
      INTERNAL_REQUEST_SECRET: 'a-shared-test-secret-with-at-least-32-characters' } as Env;
    const sessionResponse = await worker.fetch(new Request('http://local/api/dev/session', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Rosa', email: 'rosa@example.com' }),
    }), configured, context);
    const session = await sessionResponse.json<{ access_token: string }>();
    let receivedURL = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      receivedURL = new Request(input, init).url;
      return Response.json({ task: coreTask({ id: taskID, title: 'A task' }) });
    });
    const response = await worker.fetch(new Request(`http://local/api/crm/tasks/${taskID}`, {
      method: 'GET', headers: { authorization: `Bearer ${session.access_token}` },
    }), configured, context);
    expect(response.status).toBe(200);
    expect((await response.json<{ task: { id: string } }>()).task.id).toBe(taskID);
    expect(receivedURL).toBe(`https://core.test/api/public/meet-crm-tasks/${taskID}`);
    await waitOnExecutionContext(context);
  });

  it('deletes a task in Core, signed, with who deleted it (meet#1222)', async () => {
    const context = createExecutionContext();
    const configured = { ...env, CRM_SYNC_MODE: 'on', CORE_API_ORIGIN: 'https://core.test',
      INTERNAL_REQUEST_SECRET: 'a-shared-test-secret-with-at-least-32-characters' } as Env;
    const sessionResponse = await worker.fetch(new Request('http://local/api/dev/session', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Rosa', email: 'rosa@example.com' }),
    }), configured, context);
    const session = await sessionResponse.json<{ access_token: string }>();
    const sent: Array<{ method: string; url: string; body: string; signed: boolean }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      sent.push({ method: request.method, url: request.url, body: await request.text(), signed: request.headers.has('x-internal-signature') });
      return request.method === 'DELETE' ? Response.json({ ok: true }) : Response.json({ task: coreTask({ id: taskID, title: 'A task' }) });
    });
    const response = await worker.fetch(new Request(`http://local/api/crm/tasks/${taskID}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${session.access_token}`, origin: 'http://local' },
    }), configured, context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: taskID, deleted: true });
    const deleted = sent.find((call) => call.method === 'DELETE');
    expect(deleted).toMatchObject({ url: `https://core.test/api/public/meet-crm-tasks/${taskID}`, signed: true });
    expect(JSON.parse(deleted!.body)).toEqual({ actor_email: 'rosa@example.com' });
    await waitOnExecutionContext(context);
  });

  it.each([
    { assigned_to: personID, due_date: '2026-09-08T12:00:00.000Z' },
    { assigned_to: null, due_date: null },
    { title: 'Keep existing assignment and date' },
  ])('preserves assigned, cleared, and omitted values: %j', async patch => {
    const context = createExecutionContext();
    const configured = { ...env, CRM_SYNC_MODE: 'on', CORE_API_BASE_URL: 'https://core.test',
      INTERNAL_REQUEST_SECRET: 'a-shared-test-secret-with-at-least-32-characters' } as Env;
    const sessionResponse = await worker.fetch(new Request('http://local/api/dev/session', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Rosa', email: 'rosa@example.com' }),
    }), configured, context);
    const session = await sessionResponse.json<{ access_token: string }>();
    let forwarded: unknown;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      forwarded = await request.json();
      return Response.json({ task: coreTask({ id: taskID, title: 'A task' }) });
    });
    const response = await worker.fetch(new Request(`http://local/api/crm/tasks/${taskID}`, {
      method: 'PATCH', headers: { authorization: `Bearer ${session.access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }), configured, context);
    expect(response.status).toBe(200);
    // The signed-in owner rides along so Core can say who moved the task (core#196).
    expect(forwarded).toEqual({ ...patch, actor_email: 'rosa@example.com' });
    await waitOnExecutionContext(context);
  });

  it('files a task on a partner by its organization, and lists them back', async () => {
    const context = createExecutionContext();
    const organizationID = '33333333-3333-4333-8333-333333333333';
    const configured = { ...env, CRM_SYNC_MODE: 'on', CORE_API_BASE_URL: 'https://core.test',
      INTERNAL_REQUEST_SECRET: 'a-shared-test-secret-with-at-least-32-characters' } as Env;
    const sessionResponse = await worker.fetch(new Request('http://local/api/dev/session', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Rosa', email: 'rosa@example.com' }),
    }), configured, context);
    const session = await sessionResponse.json<{ access_token: string }>();
    const headers = { authorization: `Bearer ${session.access_token}`, 'content-type': 'application/json' };
    let forwarded: unknown;
    let listedURL = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (request.method === 'POST') forwarded = await request.json();
      else listedURL = request.url;
      return Response.json(request.method === 'POST'
        ? { task: coreTask({ id: taskID, title: 'Send the deck', organization_id: organizationID }) }
        : { tasks: [] });
    });
    const created = await worker.fetch(new Request('http://local/api/crm/tasks', {
      method: 'POST', headers, body: JSON.stringify({ title: 'Send the deck', organization_id: organizationID }),
    }), configured, context);
    expect(created.status).toBe(201);
    expect(forwarded).toMatchObject({ title: 'Send the deck', organization_id: organizationID, project_id: null, lead_id: null, event_id: null, actor_email: 'rosa@example.com' });
    const listed = await worker.fetch(new Request(`http://local/api/crm/tasks?organization_id=${organizationID}`, { headers }), configured, context);
    expect(listed.status).toBe(200);
    expect(new URL(listedURL).searchParams.get('organization_id')).toBe(organizationID);
    // A task has one home: a partner and a project together is refused.
    const both = await worker.fetch(new Request('http://local/api/crm/tasks', {
      method: 'POST', headers, body: JSON.stringify({ title: 'Twice', organization_id: organizationID, project_id: taskID }),
    }), configured, context);
    expect(both.status).toBe(400);
    await waitOnExecutionContext(context);
  });
});
