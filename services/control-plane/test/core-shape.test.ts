import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CrmSyncError, fetchCrmTasks, parseCoreBody, readCoreJson } from '../src/crm';
import worker from '../src/index';
import { coreTask } from './core-rows';

// meet#335: every Core answer runs through a zod schema. A mismatch is a
// logged 502 `upstream_shape` that names the field path and never the value.

const secretEnv = { ...env, INTERNAL_REQUEST_SECRET: 'meet-core-shared-secret-at-least-32-chars' } as Env;
const projectId = 'c0ffee00-0000-4000-8000-000000000335';
const route = 'GET /api/public/test';
const schema = z.looseObject({ rows: z.array(z.looseObject({ id: z.string(), title: z.string() })).nullish() });

function coreAnswers(body: unknown): void {
  vi.stubGlobal('fetch', async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('parseCoreBody', () => {
  it('passes a body that matches', () => {
    expect(parseCoreBody(schema, { rows: [{ id: 'a', title: 'A' }] }, route)).toEqual({ rows: [{ id: 'a', title: 'A' }] });
  });

  it('keeps a field Core added', () => {
    const parsed = parseCoreBody(schema, { rows: [{ id: 'a', title: 'A', added: 1 }], more: true }, route);
    expect(parsed).toEqual({ rows: [{ id: 'a', title: 'A', added: 1 }], more: true });
  });

  it('reads an absent list as absent, not as an error', () => {
    expect(parseCoreBody(schema, {}, route).rows ?? []).toEqual([]);
  });

  it('refuses a missing required field with 502 upstream_shape, and names the path', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    let caught: unknown;
    try {
      parseCoreBody(schema, { rows: [{ id: 'a', title: 'A' }, { id: 'b', secret: 'ana@acme.com' }] }, route);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CrmSyncError);
    expect(caught).toMatchObject({ status: 502, code: 'upstream_shape' });
    expect((caught as Error).message).toContain('rows.1.title');

    expect(logged).toHaveBeenCalledTimes(1);
    const line = String(logged.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toMatchObject({
      level: 'error',
      message: 'upstream.shape',
      source: 'core',
      route,
      issues: [{ path: 'rows.1.title', code: 'invalid_type' }],
    });
    // Paths only: no value from the body reaches the log.
    expect(line).not.toContain('ana@acme.com');
    expect(line).not.toContain('"b"');
  });

  it('refuses a wrong type the same way', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => parseCoreBody(schema, { rows: 'none' }, route)).toThrow(/rows/u);
  });
});

describe('readCoreJson', () => {
  it('refuses a body that is not JSON at (body)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(readCoreJson(new Response('<html>'), schema, route))
      .rejects.toMatchObject({ status: 502, code: 'upstream_shape', message: expect.stringContaining('(body)') });
  });
});

describe('a Core read through the schema', () => {
  it('passes a whole task row with a field the contract does not know yet', async () => {
    coreAnswers({ ok: true, tasks: [coreTask({ id: 't-1', project_id: projectId, added_by_core: 'x' })] });
    const tasks = await fetchCrmTasks(secretEnv, { projectId });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: 't-1', added_by_core: 'x' });
  });

  it('refuses a task row without a required field', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { title: _title, ...untitled } = coreTask({ id: 't-1', project_id: projectId });
    coreAnswers({ ok: true, tasks: [untitled] });
    await expect(fetchCrmTasks(secretEnv, { projectId }))
      .rejects.toMatchObject({ status: 502, code: 'upstream_shape', message: expect.stringContaining('tasks.0.title') });
  });

  it('answers the client 502 upstream_shape on the route', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const context = createExecutionContext();
    const configured = { ...env, CRM_SYNC_MODE: 'on', INTERNAL_REQUEST_SECRET: 'a-shared-test-secret-with-at-least-32-characters' } as Env;
    const sessionResponse = await worker.fetch(new Request('http://local/api/dev/session', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Rosa', email: 'rosa@example.com' }),
    }), configured, context);
    const session = await sessionResponse.json<{ access_token: string }>();
    const { status: _status, ...statusless } = coreTask({ id: 't-1', project_id: projectId });
    coreAnswers({ ok: true, tasks: [statusless] });

    const response = await worker.fetch(new Request(`http://local/api/crm/tasks?project_id=${projectId}`, {
      headers: { authorization: `Bearer ${session.access_token}` },
    }), configured, context);
    expect(response.status).toBe(502);
    const body = await response.json<{ error: string; code: string }>();
    expect(body.code).toBe('upstream_shape');
    expect(body.error).toContain('tasks.0.status');
    await waitOnExecutionContext(context);
  });
});
