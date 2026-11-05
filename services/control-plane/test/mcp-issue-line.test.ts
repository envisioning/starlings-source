import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ThreadMessagesResponse, ThreadSummary } from '@starlings/contracts';
import filed from '../../../fixtures/core/meet-github-issues.post.json';
import worker from '../src/index';
import { signingKey } from '../src/crypto';
import { recordOwnerSignIn } from '../src/usage';
import { coreTask } from './core-rows';

/**
 * One issue, one line. An MCP `create_issue` used to leave two in the
 * project's channel: the route's "Rosa filed #12 · …" and the tool's own
 * "Rosa’s Claude (claude.ai) filed an issue: …". The route's line is now
 * the only one, named for the Claude from the borrowed token's `via`, and it
 * is keyed the way Core's webhook keys the same change, so the webhook
 * arriving later writes nothing.
 */

const person = { email: 'issue-line-rosa@example.com', name: 'Rosa' };
const SECRET = 'inbound-test-secret-with-at-least-32-characters';
const configured = {
  ...env,
  CRM_SYNC_MODE: 'on',
  CORE_API_BASE_URL: 'https://core.test',
  INTERNAL_REQUEST_SECRET: 'a-shared-test-secret-with-at-least-32-characters',
} as Env;

// A Durable Object's storage outlives the D1 cleanup, so each case files on
// its own project and its own channel.
const viaMcpProject = 'c1d2e3f4-0000-4a00-8000-00000000b001';
const byHandProject = 'c1d2e3f4-0000-4a00-8000-00000000b002';
const completedProject = 'c1d2e3f4-0000-4a00-8000-00000000b003';
const promotedProject = 'c1d2e3f4-0000-4a00-8000-00000000b004';
const taskID = 'c1d2e3f4-0000-4a00-8000-00000000c001';

const issue = filed.issue;
const ref = `${issue.owner}/${issue.repo}#${issue.number}`;

/** Core: the issue write, the subject lookup, and the project's linked repositories. */
function core() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === '/api/public/meet-github-issues' && request.method === 'POST') {
      return Response.json(filed, { status: 201 });
    }
    if (url.pathname === `/api/public/meet-crm-tasks/${taskID}` && request.method === 'PATCH') {
      return Response.json({ task: coreTask({ id: taskID, title: 'Run the scan', project_id: completedProject, lead_id: null, event_id: null, status: 'completed' }) });
    }
    if (url.pathname.includes('project-repos')) {
      return Response.json({ repos: [{ id: 'link-0', owner: issue.owner, repo: issue.repo, label: null, milestone: null, is_primary: true }] });
    }
    if (url.pathname.includes('meet-crm-subjects')) {
      return Response.json({ ok: true, subjects: [{ id: url.searchParams.get('id'), kind: 'project', title: 'Pilot', subtitle: null }] });
    }
    return Response.json({ error: `unmocked ${request.method} ${url.pathname}` }, { status: 500 });
  });
}

async function fetchWorker(request: Request): Promise<Response> {
  const context = createExecutionContext();
  const response = await worker.fetch(request, configured, context);
  await waitOnExecutionContext(context);
  return response;
}

async function session(): Promise<Record<string, string>> {
  const response = await fetchWorker(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(person),
  }));
  const body = await response.json<{ access_token: string }>();
  await recordOwnerSignIn(configured, { sub: `dev:${person.email}`, ...person }, 'mac');
  return { authorization: `Bearer ${body.access_token}`, 'content-type': 'application/json' };
}

async function mcpBearer(clientName: string): Promise<string> {
  const id = `issue-line-${crypto.randomUUID()}`;
  const now = Date.now();
  await configured.USAGE.prepare(
    `INSERT INTO mcp_clients (client_id, client_name, client_uri, redirect_uris, created_at)
     VALUES (?1, ?2, NULL, '["https://claude.ai/api/mcp/auth_callback"]', ?3)`,
  ).bind(id, clientName, now).run();
  await configured.USAGE.prepare(
    `INSERT INTO mcp_grants (id, client_id, sub, email, scope, refresh_jti, previous_refresh_jti, renewed_at, created_at, last_call_at, revoked_at)
     VALUES (?1, ?1, ?2, ?3, 'read write', 'jti', NULL, ?4, ?4, NULL, NULL)`,
  ).bind(id, `dev:${person.email}`, person.email, now).run();
  return new SignJWT({ email: person.email, name: person.name, scope: 'read write', grant: id, client: id })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('starlings.example')
    .setAudience('meet-mcp')
    .setSubject(`dev:${person.email}`)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(signingKey(configured.SESSION_SIGNING_SECRET));
}

async function channel(headers: Record<string, string>, projectID: string) {
  const opened = await fetchWorker(new Request('http://local/api/threads', {
    method: 'POST',
    headers,
    body: JSON.stringify({ kind: 'project', subject_id: projectID }),
  }));
  const { thread } = await opened.json<{ thread: ThreadSummary }>();
  const response = await fetchWorker(new Request(`http://local/api/threads/${thread.id}/messages`, { headers }));
  return (await response.json<ThreadMessagesResponse>()).messages.filter((message) => message.type === 'event');
}

/** Core's GitHub webhook reporting the same issue opened, as `fixtures/core/meet-channel-events-issue.post.json` does a close. */
async function webhook(projectID: string) {
  const raw = JSON.stringify({
    subject: { kind: 'project', id: projectID },
    type: 'event',
    text: `${issue.author.login} opened #${issue.number} · ${issue.title}`,
    refs: [{ kind: 'issue', id: ref }],
    idempotency_key: `github:${ref}:opened`,
  });
  const timestamp = String(Date.now());
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${raw}`)))]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return fetchWorker(new Request('http://local/api/internal/channel-events', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-key-id': 'core', 'x-internal-timestamp': timestamp, 'x-internal-signature': signature },
    body: raw,
  }));
}

afterEach(async () => {
  vi.restoreAllMocks();
  await configured.USAGE.prepare('DELETE FROM thread_members').run();
  await configured.USAGE.prepare('DELETE FROM threads').run();
});

describe('the line an issue filing leaves', () => {
  it('is one line naming the Claude when a Claude filed it over MCP, and the webhook adds none', async () => {
    core();
    const headers = await session();
    const token = await mcpBearer('claude.ai');

    const response = await fetchWorker(new Request('http://local/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'create_issue', arguments: { subject: `subject:project:${viaMcpProject}`, title: issue.title } },
      }),
    }));
    const answer = await response.json<{ result?: { isError?: boolean } }>();
    expect(answer.result?.isError).not.toBe(true);

    const lines = await channel(headers, viaMcpProject);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      text: `Rosa via claude.ai filed #${issue.number} · ${issue.title}`,
      sender_email: 'meet@org.example',
      refs: [{ kind: 'issue', id: ref }],
    });

    expect((await webhook(viaMcpProject)).status).toBe(200);
    expect(await channel(headers, viaMcpProject)).toHaveLength(1);
  });

  it('files a task on GitHub when the Claude passes `task`, so the two stay one card', async () => {
    core();
    const filedBodies: unknown[] = [];
    const mocked = vi.mocked(globalThis.fetch);
    const answer = mocked.getMockImplementation()!;
    mocked.mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === '/api/public/meet-github-issues' && request.method === 'POST') {
        filedBodies.push(await request.clone().json());
      }
      return answer(input, init);
    });
    await session();
    const token = await mcpBearer('claude.ai');

    const response = await fetchWorker(new Request('http://local/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'create_issue', arguments: { subject: `subject:project:${promotedProject}`, title: issue.title, task: `task:${taskID}` } },
      }),
    }));
    const result = await response.json<{ result?: { isError?: boolean } }>();
    expect(result.result?.isError).not.toBe(true);
    expect(filedBodies).toHaveLength(1);
    expect(filedBodies[0]).toMatchObject({ task_id: taskID });
  });

  it('names the member when the member filed it, and stays one line', async () => {
    core();
    const headers = await session();

    const response = await fetchWorker(new Request('http://local/api/crm/issue', {
      method: 'POST',
      headers,
      body: JSON.stringify({ project_id: byHandProject, title: issue.title }),
    }));
    expect(response.status).toBe(201);

    const lines = await channel(headers, byHandProject);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ text: `Rosa filed #${issue.number} · ${issue.title}`, refs: [{ kind: 'issue', id: ref }] });

    expect((await webhook(byHandProject)).status).toBe(200);
    expect(await channel(headers, byHandProject)).toHaveLength(1);
  });

  it('names the Claude on a task it completed over MCP, once', async () => {
    // Not a double before this change (the tool already left completion to
    // the route), but the route's line named the member, not the Claude.
    core();
    const headers = await session();
    const token = await mcpBearer('claude.ai');

    const response = await fetchWorker(new Request('http://local/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'task', arguments: { task: taskID, status: 'completed' } },
      }),
    }));
    expect((await response.json<{ result?: { isError?: boolean } }>()).result?.isError).not.toBe(true);

    const lines = await channel(headers, completedProject);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ text: 'Rosa via claude.ai completed: Run the scan', refs: [{ kind: 'task', id: taskID }] });
  });
});
