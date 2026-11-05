import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ThreadSummary } from '@starlings/contracts';
import { agentAddressDomain, type AdminAgentEnrollmentDecisionResponse, type AdminAgentEnrollmentsResponse, type AgentEnrollPollResponse, type AgentEnrollResponse } from '@starlings/contracts/agent-enrollment';
import worker from '../src/index';
import { notifyThreadAgents } from '../src/agents';
import { hmacSHA256Hex } from '../src/crypto';
import { recordOwnerSignIn } from '../src/usage';

/**
 * Agent enrollment (docs/AGENTS_SURFACE.md §Enrollment): any runtime asks to
 * join Team, an admin approves the code, the runtime collects its own keys
 * once, and from then on both directions are signed with them. No deploy, no
 * Worker secret, no roster var.
 */

const configured = {
  ...env,
  SESSION_SIGNING_SECRET: 'agent-enrollment-signing-secret-with-32-chars',
  GOOGLE_TOKEN_ENCRYPTION_KEY: 'agent-enrollment-sealing-key-material',
  INTERNAL_REQUEST_SECRET: '',
  AGENT_ROSTER: '',
} as Env;
const domain = agentAddressDomain(configured.WEB_ORIGIN);
const rosa = { email: 'rosa@example.com', name: 'Rosa' };
const cleo = { email: 'enroll-cleo@example.com', name: 'Cleo' };

async function fetchWorker(request: Request): Promise<Response> {
  const context = createExecutionContext();
  const response = await worker.fetch(request, configured, context);
  await waitOnExecutionContext(context);
  return response;
}

async function session(person: { email: string; name: string }): Promise<Record<string, string>> {
  const response = await fetchWorker(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(person),
  }));
  const { access_token } = await response.json<{ access_token: string }>();
  await recordOwnerSignIn(configured, { sub: `dev:${person.email}`, ...person }, 'mac');
  return { authorization: `Bearer ${access_token}`, 'content-type': 'application/json', origin: configured.WEB_ORIGIN };
}

function post(path: string, body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }): Promise<Response> {
  return fetchWorker(new Request(`http://local${path}`, { method: 'POST', headers, body: JSON.stringify(body) }));
}

async function enroll(name: string): Promise<AgentEnrollResponse> {
  const response = await post('/api/agents/enroll', {
    name,
    endpoint: 'https://hermes.example.com/meet/handoff',
    description: 'A Hermes agent.',
    runtime: 'hermes 0.21.5',
  });
  expect(response.status).toBe(201);
  return response.json<AgentEnrollResponse>();
}

async function poll(token: string): Promise<AgentEnrollPollResponse> {
  const response = await post('/api/agents/enroll/poll', { poll_token: token });
  expect(response.status).toBe(200);
  return response.json<AgentEnrollPollResponse>();
}

async function agentSays(threadId: string, agent: string, key: string, idempotency: string): Promise<Response> {
  const raw = JSON.stringify({ thread_id: threadId, type: 'text', sender: agent, text: 'done', idempotency_key: idempotency });
  const timestamp = String(Date.now());
  return fetchWorker(new Request('http://local/api/internal/channel-events', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-timestamp': timestamp,
      'x-internal-signature': await hmacSHA256Hex(key, `${timestamp}.${raw}`),
      'x-internal-key-id': agent,
    },
    body: raw,
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('agent enrollment', () => {
  it('refuses an endpoint that is not https', async () => {
    const response = await post('/api/agents/enroll', { name: 'Plain', endpoint: 'ftp://agent.example.com/handoff' });
    expect(response.status).toBe(400);
  });

  it('waits for an admin, then hands the keys out once, and the agent works with them', async () => {
    const asked = await enroll('Hermes');
    expect(asked.user_code).toMatch(/^[A-Z2-9]{8}$/u);
    expect(asked.approve_url).toContain(`/admin/agents?code=${asked.user_code}`);
    expect(await poll(asked.poll_token)).toMatchObject({ status: 'pending' });

    // A member who is not an admin can neither see nor approve it.
    const member = await session(cleo);
    expect((await fetchWorker(new Request('http://local/api/admin/agent-enrollments', { headers: member }))).status).toBe(403);
    expect((await post(`/api/admin/agent-enrollments/${asked.user_code}/approve`, {}, member)).status).toBe(403);

    const admin = await session(rosa);
    const listed = await (await fetchWorker(new Request('http://local/api/admin/agent-enrollments', { headers: admin }))).json<AdminAgentEnrollmentsResponse>();
    expect(listed.enrollments.find((row) => row.user_code === asked.user_code)).toMatchObject({ status: 'pending', requested_name: 'Hermes', runtime: 'hermes 0.21.5' });
    // No secret ever reaches Admin.
    expect(JSON.stringify(listed)).not.toMatch(/secret|inbound_key|poll_token/u);

    const dashed = `${asked.user_code.slice(0, 4)}-${asked.user_code.slice(4)}`;
    const approved = await post(`/api/admin/agent-enrollments/${dashed}/approve`, {}, admin);
    expect(approved.status).toBe(200);
    const { enrollment } = await approved.json<AdminAgentEnrollmentDecisionResponse>();
    const address = `hermes@${domain}`;
    expect(enrollment).toMatchObject({ status: 'approved', agent_email: address });

    const keys = await poll(asked.poll_token);
    if (keys.status !== 'approved') throw new Error(`expected approved, got ${keys.status}`);
    expect(keys.agent_email).toBe(address);
    expect(keys.webhook_secret).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(keys.inbound_key).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(await poll(asked.poll_token)).toEqual({ status: 'collected' });

    // The runtime, stubbed: its manifest (Team reads it) and its hand-off route.
    const calls: Request[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      calls.push(request);
      if (request.url.endsWith('/manifest')) return Response.json({ description: 'A Hermes agent.' });
      return new Response(JSON.stringify({ accepted: true }), { status: 202 });
    });

    // The agent is on the roster: Team lists it, and a member can open a conversation with it.
    const roster = await (await fetchWorker(new Request('http://local/api/peers', { headers: admin }))).json<{ peers: Array<{ email: string }> }>();
    expect(roster.peers.map((peer) => peer.email)).toContain(address);
    const opened = await post('/api/threads', { peer_email: address }, admin);
    expect(opened.status).toBeLessThan(300);
    const threadId = (await opened.json<{ thread: ThreadSummary }>()).thread.id;

    // A hand-off is signed with the agent's own webhook secret.
    await notifyThreadAgents(configured, {
      threadId,
      threadKind: 'dm',
      messageId: 'enroll-m1',
      text: 'hello',
      sentAt: Date.now(),
      sender: { email: rosa.email, name: rosa.name },
    });
    const handoff = calls.find((call) => call.url === 'https://hermes.example.com/meet/handoff');
    expect(handoff).toBeDefined();
    const body = await handoff!.text();
    const timestamp = handoff!.headers.get('x-internal-timestamp')!;
    expect(handoff!.headers.get('x-internal-signature')).toBe(await hmacSHA256Hex(keys.webhook_secret, `${timestamp}.${body}`));
    vi.unstubAllGlobals();

    // Its reply verifies with its own inbound key, and with nothing else.
    expect((await agentSays(threadId, address, 'not-the-key-but-long-enough-to-try-0123456789', 'enroll-r0')).status).toBe(403);
    expect((await agentSays(threadId, address, keys.inbound_key, 'enroll-r1')).status).toBeLessThan(300);

    // Removed: its keys stop working at once.
    expect((await post(`/api/admin/agents/${encodeURIComponent(address)}/remove`, {}, admin)).status).toBe(200);
    expect((await agentSays(threadId, address, keys.inbound_key, 'enroll-r2')).status).toBe(403);
  });

  it('never reuses an address, and a denied request gets no keys', async () => {
    const admin = await session(rosa);
    const second = await enroll('Hermes');
    const approved = await post(`/api/admin/agent-enrollments/${second.user_code}/approve`, { name: 'Hermes' }, admin);
    expect((await approved.json<AdminAgentEnrollmentDecisionResponse>()).enrollment.agent_email).toBe(`hermes-2@${domain}`);

    const third = await enroll('Stranger');
    expect((await post(`/api/admin/agent-enrollments/${third.user_code}/deny`, {}, admin)).status).toBe(200);
    expect(await poll(third.poll_token)).toEqual({ status: 'denied' });
    expect((await post(`/api/admin/agent-enrollments/${third.user_code}/approve`, {}, admin)).status).toBe(404);
  });
});
