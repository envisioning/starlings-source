import { env } from 'cloudflare:workers';
import { coreSubjectDetail, coreTask } from './core-rows';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { signingKey } from '../src/crypto';

/**
 * The folded `task` tool (docs/MCP.md, tool surface). The grant row and the
 * bearer are minted the way `mcpToken` mints them; Core is a
 * mock that records what it was asked, the same shape crm-task-forwarding
 * uses for the route underneath.
 */

// The signed-in owner rides along on a task write so Core can record who (core#196).
const owner = 'rosa@example.com';
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

async function callTool(token: string, name: string, args: Record<string, unknown>, workspace: Env = configured) {
  const context = createExecutionContext();
  const response = await worker.fetch(new Request('http://local/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }), workspace, context);
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

describe('folded task tool', () => {
  it('lists task for write scope and keeps the tool set to fourteen', async () => {
    const list = async (token: string) => {
      const context = createExecutionContext();
      const response = await worker.fetch(new Request('http://local/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }), configured, context);
      await waitOnExecutionContext(context);
      const { result } = await response.json<{ result: { tools: Array<{ name: string }> } }>();
      return result.tools.map((tool) => tool.name);
    };
    const read = await list(await bearer('read'));
    const write = await list(await bearer('read write'));
    expect(read).toHaveLength(5);
    expect(read).not.toContain('task');
    expect(write).toContain('task');
    expect(write).toHaveLength(14);
  });

  it('routes updates through task and assigns by member email', async () => {
    let forwarded: Record<string, unknown> | undefined;
    mockCore((body) => { forwarded = body; });
    const answer = await callTool(await bearer('read write'), 'task', { task: `task:${taskID}`, assign_to_me: true });
    expect(answer.error).toBeUndefined();
    expect(answer.result?.isError).toBeFalsy();
    expect(forwarded).toEqual({ assigned_to: memberID, responsible_party: 'team', actor_email: owner });
  });

  it('routes creation through task when no task door is present', async () => {
    let forwarded: Record<string, unknown> | undefined;
    mockCore((body) => { forwarded = body; });
    const answer = await callTool(await bearer('read write'), 'task', {
      subject: `subject:event:${eventID}`,
      title: 'Prepare workshop notes',
    });
    expect(answer.result?.isError).toBeFalsy();
    expect(forwarded).toMatchObject({ title: 'Prepare workshop notes', event_id: eventID, responsible_party: 'team' });
  });

  it('reads the flags as strings from a client with a stale tool list, and "false" as false', async () => {
    let forwarded: Record<string, unknown> | undefined;
    mockCore((body) => { forwarded = body; });
    const token = await bearer('read write');
    const yes = await callTool(token, 'task', { task: taskID, assign_to_me: 'true' });
    expect(yes.result?.isError).toBeFalsy();
    expect(forwarded).toEqual({ assigned_to: memberID, responsible_party: 'team', actor_email: owner });
    const no = await callTool(token, 'task', { task: taskID, assign_to_me: 'false', title: 'Renamed' });
    expect(no.result?.isError).toBeFalsy();
    expect(forwarded).toEqual({ title: 'Renamed', actor_email: owner });
  });

  it('takes a bare id, clears a due date with an empty string, and unassigns', async () => {
    let forwarded: Record<string, unknown> | undefined;
    mockCore((body) => { forwarded = body; });
    const answer = await callTool(await bearer('read write'), 'task', { task: taskID, due_date: '', unassign: true, status: 'in_progress' });
    expect(answer.result?.isError).toBeFalsy();
    expect(forwarded).toEqual({ due_date: null, assigned_to: null, status: 'in_progress', actor_email: owner });
  });

  it('refuses an empty change, a malformed door, and both assignment flags at once', async () => {
    const patch = vi.fn();
    mockCore(patch);
    const token = await bearer('read write');
    for (const args of [
      { task: `task:${taskID}` },
      { task: 'task:not-a-uuid', title: 'x' },
      { task: taskID, assign_to_me: true, unassign: true },
    ]) {
      const answer = await callTool(token, 'task', args);
      expect(answer.result?.isError ?? answer.error !== undefined).toBe(true);
    }
    expect(patch).not.toHaveBeenCalled();
  });

  it('rejects the retired names with the standard unknown-tool error', async () => {
    const core = mockCore(() => undefined);
    const token = await bearer('read write');
    for (const name of ['create_task', 'update_task', 'cms_read', 'cms_write']) {
      const answer = await callTool(token, name, {});
      expect(answer.error?.message).toContain(`No tool named ${name}.`);
    }
    expect(core).not.toHaveBeenCalled();
  });
});

describe('open on a subject door', () => {
  it('returns the subject channel as thread_id, made to exist', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.endsWith('meet-crm-subjects')) {
        return Response.json({ ok: true, subjects: [{ id: eventID, kind: 'event', title: 'Napoli workshop', subtitle: null, open_tasks: 0 }], has_more: false });
      }
      if (url.pathname === '/api/public/meet-team') return Response.json({ members: [] });
      // Tasks and decisions are read quietly: a failure only lands in `partial`.
      return Response.json({ error: `unmocked ${request.method} ${url.pathname}` }, { status: 500 });
    });
    const answer = await callTool(await bearer('read'), 'open', { door: `subject:event:${eventID}` });
    expect(answer.error).toBeUndefined();
    const opened = JSON.parse(answer.result?.content?.[0]?.text ?? '{}') as { thread_id?: string; subject?: { id: string } };
    expect(opened.subject?.id).toBe(eventID);
    expect(opened.thread_id).toMatch(/^[A-Za-z0-9_-]{4,72}$/u);
    const row = await configured.USAGE.prepare('SELECT kind, parent_id, title FROM threads WHERE id = ?1')
      .bind(opened.thread_id).first<{ kind: string; parent_id: string; title: string }>();
    expect(row).toEqual({ kind: 'event', parent_id: eventID, title: 'Napoli workshop' });
  });
});

describe('task create_lead', () => {
  const leadID = '7d1f4a52-2c1e-4c55-9d0a-5e6b1f0c9a11';
  const organizationID = '0f0e0d0c-0b0a-4908-8706-050403020100';

  /** Core's subject create, as `createCrmSubject` reaches it. */
  function mockLeadCore(onCreate: (body: Record<string, unknown>) => void) {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === '/api/public/meet-crm-subjects' && request.method === 'POST') {
        const body = await request.json<Record<string, unknown>>();
        onCreate(body);
        return Response.json({
          subject: coreSubjectDetail({ id: leadID, kind: 'lead', title: String(body.title), status: String(body.status) }),
        }, { status: 201 });
      }
      return Response.json({ error: `unmocked ${request.method} ${url.pathname}` }, { status: 500 });
    });
  }

  it('creates the lead through the Worker route as the member and answers its door and channel', async () => {
    const created: Array<Record<string, unknown>> = [];
    mockLeadCore((body) => created.push(body));
    const answer = await callTool(await bearer('read write'), 'task', {
      action: 'create_lead',
      title: 'Acme foresight sprint',
      organization_id: organizationID,
      notes: 'Met at the Lisbon summit.',
    });
    expect(answer.error).toBeUndefined();
    expect(answer.result?.isError).toBeFalsy();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      title: 'Acme foresight sprint',
      status: 'Conversations',
      organization_id: organizationID,
      notes: 'Met at the Lisbon summit.',
      actor: 'rosa@example.com',
    });
    expect(created[0]!.start_date).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    const result = answer.result?.structuredContent as { door: string; thread_id: string; subject: { id: string; title: string } };
    expect(result.door).toBe(`subject:lead:${leadID}`);
    expect(result.subject).toMatchObject({ id: leadID, title: 'Acme foresight sprint' });
    const row = await configured.USAGE.prepare('SELECT kind, parent_id, title FROM threads WHERE id = ?1')
      .bind(result.thread_id).first<{ kind: string; parent_id: string; title: string }>();
    expect(row).toEqual({ kind: 'lead', parent_id: leadID, title: 'Acme foresight sprint' });
  });

  it('passes status and start_date through, and replays a retried idempotency key', async () => {
    const created: Array<Record<string, unknown>> = [];
    mockLeadCore((body) => created.push(body));
    const token = await bearer('read write');
    const args = {
      action: 'create_lead',
      title: 'Globex horizon scan',
      organization_id: organizationID,
      status: 'Proposal Out',
      start_date: '2026-09-29',
      idempotency_key: `lead-${crypto.randomUUID()}`,
    };
    const first = await callTool(token, 'task', args);
    const second = await callTool(token, 'task', args);
    expect(first.result?.isError).toBeFalsy();
    expect(second.result?.replayed).toBe(true);
    expect(second.result?.structuredContent).toEqual(first.result?.structuredContent);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ status: 'Proposal Out', start_date: '2026-09-29' });
  });

  it('refuses a missing or long title, a bad id, an unknown field and an unknown action before Core', async () => {
    const create = vi.fn();
    mockLeadCore(create);
    const token = await bearer('read write');
    for (const args of [
      { action: 'create_lead' },
      { action: 'create_lead', title: 'x'.repeat(101) },
      { action: 'create_lead', title: 'Lead' },
      { action: 'create_lead', title: 'Lead', organization_id: 'not-a-uuid' },
      { action: 'create_lead', title: 'Lead', status: 'Won' },
      { action: 'create_lead', title: 'Lead', description: 'not a lead field' },
      { action: 'create_lead', title: 'Lead', organization_id: organizationID, organization: 'Acme' },
      { action: 'delete_lead', title: 'Lead' },
    ]) {
      const answer = await callTool(token, 'task', args);
      expect(answer.result?.isError ?? answer.error !== undefined, JSON.stringify(args)).toBe(true);
    }
    expect(create).not.toHaveBeenCalled();
  });

  it('creates a lead with its qualification checks, and answers the count (meet#625)', async () => {
    const created: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === '/api/public/meet-crm-subjects' && request.method === 'POST') {
        const body = await request.json<Record<string, unknown>>();
        created.push(body);
        return Response.json({ subject: coreSubjectDetail({ id: leadID, kind: 'lead', title: 'Innocean', status: 'Opportunity Identified', characteristics: body.characteristics }) }, { status: 201 });
      }
      return Response.json({ error: 'unmocked' }, { status: 500 });
    });
    const answer = await callTool(await bearer('read write'), 'task', {
      action: 'create_lead', title: 'Innocean', organization_id: organizationID,
      qualification: { budget_availability: true, project_fit: true },
    });
    expect(answer.result?.isError).toBeFalsy();
    expect(created[0]!.characteristics).toEqual({ budget_availability: true, project_fit: true });
    expect(answer.result?.structuredContent).toMatchObject({
      qualification: { budget_availability: true, project_fit: true, event_timeline: false, done: 2, total: 5 },
    });
  });

  it('updates the named checks and keeps the rest of the characteristics (meet#625)', async () => {
    const patched: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === '/api/public/meet-crm-subjects' && request.method === 'GET') {
        return Response.json({ subject: coreSubjectDetail({ id: leadID, kind: 'lead', title: 'Innocean', status: 'Conversations', characteristics: { project_fit: true, custom_flag: true } }) });
      }
      if (url.pathname === '/api/public/meet-crm-subjects' && request.method === 'PATCH') {
        const body = await request.json<Record<string, unknown>>();
        patched.push(body);
        return Response.json({ subject: coreSubjectDetail({ id: leadID, kind: 'lead', title: 'Innocean', status: 'Conversations', characteristics: body.characteristics }) });
      }
      return Response.json({ error: 'unmocked' }, { status: 500 });
    });
    const token = await bearer('read write');
    const answer = await callTool(token, 'task', {
      action: 'update_lead', lead: `subject:lead:${leadID}`, qualification: { budget_availability: true },
    });
    expect(answer.result?.isError).toBeFalsy();
    expect(patched[0]!.characteristics).toEqual({ project_fit: true, custom_flag: true, budget_availability: true });
    expect(answer.result?.structuredContent).toMatchObject({ qualification: { done: 2, total: 5, budget_availability: true } });
    const nothing = await callTool(token, 'task', { action: 'update_lead', lead: leadID });
    expect(nothing.result?.isError ?? nothing.error !== undefined).toBe(true);
    const unknownCheck = await callTool(token, 'task', { action: 'update_lead', lead: leadID, qualification: { vibes: true } });
    expect(unknownCheck.result?.isError ?? unknownCheck.error !== undefined).toBe(true);
    expect(patched).toHaveLength(1);
  });

  it('is refused on a read-only pairing', async () => {
    const create = vi.fn();
    mockLeadCore(create);
    const answer = await callTool(await bearer('read'), 'task', { action: 'create_lead', title: 'Initech' });
    expect(answer.result?.isError ?? answer.error !== undefined).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });

  it('describes the branch in the task schema', async () => {
    const context = createExecutionContext();
    const response = await worker.fetch(new Request('http://local/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${await bearer('read write')}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }), configured, context);
    await waitOnExecutionContext(context);
    const { result } = await response.json<{ result: { tools: Array<{ name: string; inputSchema: { oneOf: Array<{ properties: Record<string, { enum?: string[] }>; required: string[] }> } }> } }>();
    const task = result.tools.find((tool) => tool.name === 'task')!;
    const lead = task.inputSchema.oneOf.find((variant) => variant.properties.action?.enum?.includes('create_lead'));
    expect(lead?.required).toEqual(['action', 'title']);
    expect(lead?.properties.status?.enum).toContain('Conversations');
    const project = task.inputSchema.oneOf.find((variant) => variant.properties.action?.enum?.includes('create_project'));
    expect(project?.required).toEqual(['action', 'title']);
    expect(project?.properties.status?.enum).toEqual(['Active', 'Paused', 'Archived']);
  });
});

describe('task create_project on a D1 workspace', () => {
  // A workspace without Core: no `cms`, so `task` is the only way an agent
  // starts a project, and naming the organization is the only way it finds one.
  const d1 = { ...configured, CRM_SYNC_MODE: 'off', WORK_STORE: 'd1' } as Env;

  it('creates the project, finds or creates its organization by name, and answers its door and channel', async () => {
    const token = await bearer('read write');
    const first = await callTool(token, 'task', { action: 'create_project', title: 'Starlings growth', organization: 'Starlings HQ', description: 'Search, social and the growth agent.' }, d1);
    expect(first.result?.isError, JSON.stringify(first)).toBeFalsy();
    const created = first.result?.structuredContent as { door: string; thread_id: string; organization_created: boolean; subject: { id: string; title: string; status: string } };
    expect(created.organization_created).toBe(true);
    expect(created.subject).toMatchObject({ title: 'Starlings growth', status: 'Active' });
    expect(created.door).toBe(`subject:project:${created.subject.id}`);
    const thread = await d1.USAGE.prepare('SELECT kind, parent_id FROM threads WHERE id = ?1').bind(created.thread_id).first();
    expect(thread).toEqual({ kind: 'project', parent_id: created.subject.id });

    const second = await callTool(token, 'task', { action: 'create_project', title: 'Pilot onboarding', organization: '  starlings hq ' }, d1);
    expect(second.result?.isError, JSON.stringify(second)).toBeFalsy();
    expect((second.result?.structuredContent as { organization_created: boolean }).organization_created).toBe(false);
    const organizations = await d1.USAGE.prepare('SELECT COUNT(*) AS n FROM organizations WHERE lower(name) = ?1').bind('starlings hq').first<{ n: number }>();
    expect(organizations?.n).toBe(1);
  });

  it('creates a project with no organization (meet#1046)', async () => {
    const token = await bearer('read write');
    const answer = await callTool(token, 'task', { action: 'create_project', title: 'Alpha alone' }, d1);
    expect(answer.result?.isError ?? false).toBe(false);
    const row = await d1.USAGE.prepare("SELECT organization_id FROM projects WHERE title = 'Alpha alone'").first<{ organization_id: string | null }>();
    expect(row).toEqual({ organization_id: null });
  });

  it('refuses a project with both organizations, or with a bad lead, before writing', async () => {
    const token = await bearer('read write');
    for (const args of [
      { action: 'create_project', title: 'Both', organization: 'Acme', organization_id: crypto.randomUUID() },
      { action: 'create_project', title: 'Bad lead', organization: 'Acme', lead: 'not-a-lead' },
      { action: 'create_project', title: 'Bad status', organization: 'Acme', status: 'Done' },
    ]) {
      const answer = await callTool(token, 'task', args, d1);
      expect(answer.result?.isError ?? answer.error !== undefined, JSON.stringify(args)).toBe(true);
    }
    const projects = await d1.USAGE.prepare("SELECT COUNT(*) AS n FROM projects WHERE title IN ('Both', 'Bad lead', 'Bad status')").first<{ n: number }>();
    expect(projects?.n).toBe(0);
  });

  it('names the server and the instructions after the workspace', async () => {
    const hq = { ...d1, WORKSPACE_NAME: 'HQ' } as Env;
    const context = createExecutionContext();
    const response = await worker.fetch(new Request('http://local/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${await bearer('read')}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
    }), hq, context);
    await waitOnExecutionContext(context);
    const { result } = await response.json<{ result: { serverInfo: { name: string }; instructions: string } }>();
    expect(result.serverInfo.name).toBe('Starlings · HQ');
    expect(result.instructions).toContain('HQ\'s people and agents');
    expect(result.instructions).not.toContain('Envisioning');
  });
});
