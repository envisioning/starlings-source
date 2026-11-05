import { env } from 'cloudflare:workers';
import { coreSubjectDetail, coreTask } from './core-rows';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { signingKey } from '../src/crypto';

/**
 * Quick Note triage over MCP (docs/MCP.md §Quick Notes): a filing write names
 * the note with `quick_note`, and the note is pointed at what was made. The
 * bearer and Core mock are mcp-update-task's.
 */

const taskID = '5256cbbb-fc7a-40fc-b5d4-c426baaddbc8';
const eventID = 'b6278fa9-ffb4-4a04-996d-f51485b95db4';
const memberID = '33333333-3333-4333-8333-333333333333';
const configured = {
  ...env,
  CRM_SYNC_MODE: 'on',
  CORE_API_BASE_URL: 'https://core.test',
  INTERNAL_REQUEST_SECRET: 'a-shared-test-secret-with-at-least-32-characters',
  SESSION_SIGNING_SECRET: 'mcp-update-task-signing-secret-32-chars',
} as Env;

afterEach(() => vi.restoreAllMocks());

async function bearer(scope: string): Promise<string> {
  const now = Date.now();
  await configured.USAGE.prepare(
    `INSERT OR REPLACE INTO mcp_clients (client_id, client_name, client_uri, redirect_uris, created_at) VALUES (?1, ?2, NULL, '["https://claude.ai/api/mcp/auth_callback"]', ?3)`,
  ).bind('client-test', 'claude.ai', now).run();
  await configured.USAGE.prepare(
    `INSERT OR REPLACE INTO mcp_grants (id, client_id, sub, email, scope, refresh_jti, previous_refresh_jti, renewed_at, created_at, last_call_at, revoked_at)
     VALUES (?1, 'client-test', ?2, ?3, ?4, 'jti', NULL, ?5, ?5, NULL, NULL)`,
  ).bind('grant-test', 'dev:rosa@example.com', 'rosa@example.com', scope, now).run();
  return new SignJWT({ email: 'rosa@example.com', name: 'Rosa', scope, grant: 'grant-test', client: 'client-test' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('starlings.example')
    .setAudience('meet-mcp')
    .setSubject('dev:rosa@example.com')
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(signingKey(configured.SESSION_SIGNING_SECRET));
}

async function callTool(token: string, name: string, args: Record<string, unknown>) {
  const context = createExecutionContext();
  const response = await worker.fetch(new Request('http://local/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }), configured, context);
  await waitOnExecutionContext(context);
  return response.json<{ result?: { isError?: boolean; replayed?: boolean; content?: Array<{ text?: string }>; structuredContent?: unknown }; error?: { message: string } }>();
}

/** Core, as far as the tool reaches it: the team list and task writes. */
function mockCore(onPatch: (body: Record<string, unknown>) => void) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === '/api/public/meet-team') {
      return Response.json({ members: [{ id: memberID, name: 'Rosa Ortiz', email: 'ROSA@example.com' }] });
    }
    if (url.pathname === '/api/public/meet-crm-tasks' && request.method === 'POST') {
      const body = await request.json<Record<string, unknown>>();
      onPatch(body);
      return Response.json({ task: coreTask({ id: taskID, title: String(body.title ?? 'Created task'), project_id: null, lead_id: null, event_id: eventID, ...body }) }, { status: 201 });
    }
    if (url.pathname === `/api/public/meet-crm-tasks/${taskID}` && request.method === 'PATCH') {
      const body = await request.json<Record<string, unknown>>();
      onPatch(body);
      return Response.json({ task: coreTask({ id: taskID, title: 'Run the scan', project_id: null, lead_id: null, event_id: eventID, ...body }) });
    }
    return Response.json({ error: `unmocked ${request.method} ${url.pathname}` }, { status: 500 });
  });
}

async function seedNote(text: string): Promise<string> {
  const notes = configured.QUICK_NOTES.getByName('owner:dev:rosa@example.com');
  const response = await notes.fetch(new Request('https://quick-notes/notes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: text, source: 'home' }),
  }));
  return (await response.json<{ note: { id: string } }>()).note.id;
}

async function noteState(id: string) {
  const notes = configured.QUICK_NOTES.getByName('owner:dev:rosa@example.com');
  const { notes: rows } = await (await notes.fetch('https://quick-notes/notes')).json<{ notes: Array<{ id: string; state: string; promotion: { kind: string; id: string } | null }> }>();
  return rows.find((row) => row.id === id);
}

describe('quick_note on a filing write', () => {
  it('creates the task, then marks the note filed as that task', async () => {
    const created = vi.fn();
    mockCore(created);
    const noteID = await seedNote('Prep the workshop deck');
    const answer = await callTool(await bearer('read write'), 'task', {
      subject: `subject:event:${eventID}`,
      title: 'Prep the workshop deck',
      quick_note: noteID,
    });
    expect(answer.result?.isError).toBeFalsy();
    expect(created).toHaveBeenCalledOnce();
    const result = answer.result?.structuredContent as { task: { id: string }; quick_note: { state: string } };
    expect(result.quick_note.state).toBe('promoted');
    expect(await noteState(noteID)).toMatchObject({ state: 'promoted', promotion: { kind: 'task', id: taskID } });
  });

  it('refuses an unknown or already-filed note before writing anything', async () => {
    const created = vi.fn();
    mockCore(created);
    const token = await bearer('read write');
    const missing = await callTool(token, 'task', {
      subject: `subject:event:${eventID}`,
      title: 'Nothing',
      quick_note: '00000000-0000-4000-8000-000000000000',
    });
    expect(missing.result?.isError).toBe(true);
    expect(missing.result?.content?.[0]?.text).toContain('quick_note_not_found');

    const noteID = await seedNote('Already done');
    const notes = configured.QUICK_NOTES.getByName('owner:dev:rosa@example.com');
    await notes.fetch(new Request(`https://quick-notes/notes/${noteID}/promote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'task', id: taskID }),
    }));
    const filed = await callTool(token, 'task', { subject: `subject:event:${eventID}`, title: 'Again', quick_note: noteID });
    expect(filed.result?.isError).toBe(true);
    expect(filed.result?.content?.[0]?.text).toContain('quick_note_filed');
    expect(created).not.toHaveBeenCalled();
  });

  it('is a write: a read-only pairing cannot triage', async () => {
    const created = vi.fn();
    mockCore(created);
    const noteID = await seedNote('Read only');
    const answer = await callTool(await bearer('read'), 'task', { subject: `subject:event:${eventID}`, title: 'x', quick_note: noteID });
    expect(answer.result?.isError ?? answer.error !== undefined).toBe(true);
    expect((await noteState(noteID))?.state).toBe('open');
  });
});
