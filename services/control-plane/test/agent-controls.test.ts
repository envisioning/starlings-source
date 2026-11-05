import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentSub, type AdminAgentActivityResponse, type AdminAgentFreezeResponse, type ThreadMessagesResponse, type ThreadSummary } from '@starlings/contracts';
import type { McpGrantsResponse } from '@starlings/contracts/mcp';
import worker from '../src/index';
import { ensureAgentPeople, notifyThreadAgents } from '../src/agents';
import { hmacSHA256Hex, signingKey } from '../src/crypto';
import { inboundKeyEnvName } from '../src/inbound-keys';
import { recordOwnerSignIn } from '../src/usage';

/**
 * Agent controls (meet#711): a member pauses their own Claude, an admin
 * freezes a roster agent. Both bite on the next call, with no deploy.
 */

const secret = 'an-inbound-secret-for-the-agent-controls-test';
const vocabEmail = 'controls-vocab@example.com';
const vocabSub = agentSub(vocabEmail);
const rosa = { email: 'rosa@example.com', name: 'Rosa' };
const cleo = { email: 'controls-cleo@example.com', name: 'Cleo' };

const configured = {
  ...env,
  SESSION_SIGNING_SECRET: 'agent-controls-signing-secret-with-32-chars',
  [inboundKeyEnvName(vocabEmail)]: secret,
  INTERNAL_REQUEST_SECRET: '',
  AGENT_ROSTER: JSON.stringify({
    [vocabEmail]: { name: 'Vocab', endpoint: 'https://vocab.example.com/meet/handoff' },
  }),
} as Env;

async function fetchWorker(request: Request): Promise<Response> {
  const context = createExecutionContext();
  const response = await worker.fetch(request, configured, context);
  await waitOnExecutionContext(context);
  return response;
}

/** A signed-in member, as the dev door mints one, with a `people` row. */
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

function post(path: string, headers: Record<string, string>, body: unknown = {}): Promise<Response> {
  return fetchWorker(new Request(`http://local${path}`, { method: 'POST', headers, body: JSON.stringify(body) }));
}

describe('pausing a Claude', () => {
  const grantID = 'grant-controls';

  async function bearer(): Promise<string> {
    const now = Date.now();
    await configured.USAGE.prepare(
      `INSERT OR REPLACE INTO mcp_clients (client_id, client_name, client_uri, redirect_uris, created_at) VALUES ('client-controls', 'claude.ai', NULL, '["https://claude.ai/api/mcp/auth_callback"]', ?1)`,
    ).bind(now).run();
    await configured.USAGE.prepare(
      `INSERT OR REPLACE INTO mcp_grants (id, client_id, sub, email, scope, refresh_jti, previous_refresh_jti, renewed_at, created_at, last_call_at, revoked_at, paused_at)
       VALUES (?1, 'client-controls', ?2, ?3, 'read', 'jti', NULL, ?4, ?4, NULL, NULL, NULL)`,
    ).bind(grantID, `dev:${rosa.email}`, rosa.email, now).run();
    return new SignJWT({ email: rosa.email, name: rosa.name, scope: 'read', grant: grantID, client: 'client-controls' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('starlings.example')
      .setAudience('meet-mcp')
      .setSubject(`dev:${rosa.email}`)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(signingKey(configured.SESSION_SIGNING_SECRET));
  }

  type Answer = { result?: { isError?: boolean; content?: Array<{ text: string }>; structuredContent?: { error?: { code: string } }; instructions?: string }; error?: { message: string; data?: { code: string } } };

  async function rpc(token: string, method: string, params: unknown = {}): Promise<Answer> {
    const response = await fetchWorker(new Request('http://local/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }));
    expect(response.status).toBe(200);
    return response.json<Answer>();
  }

  // `now` reads the roster, which probes an agent's manifest; it has none here.
  beforeEach(() => {
    vi.stubGlobal('fetch', async () => new Response(null, { status: 404 }));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await configured.USAGE.prepare('DELETE FROM mcp_calls WHERE grant_id = ?1').bind(grantID).run();
  });

  it('refuses every call that reads while paused, says who paused it, and lets the next call through on resume', async () => {
    const token = await bearer();
    const owner = await session(rosa);
    expect((await rpc(token, 'tools/call', { name: 'now', arguments: {} })).result?.isError).toBe(false);

    const paused = await post(`/api/mcp/grants/${grantID}/pause`, owner);
    expect(paused.status).toBe(200);
    const listed = await paused.json<McpGrantsResponse>();
    expect(listed.grants.find((grant) => grant.id === grantID)?.paused_at).toBeGreaterThan(0);

    const refused = await rpc(token, 'tools/call', { name: 'now', arguments: {} });
    expect(refused.result?.isError).toBe(true);
    expect(refused.result?.structuredContent?.error?.code).toBe('connector_paused');
    expect(refused.result?.content?.[0]?.text).toContain('paused by Rosa in Starlings Settings');

    const read = await rpc(token, 'resources/read', { uri: 'starlings://board/7' });
    expect(read.error?.data?.code).toBe('connector_paused');

    // Still connected, and the handshake says why.
    const initialized = await rpc(token, 'initialize', { protocolVersion: '2025-06-18' });
    expect(initialized.result?.instructions).toContain('paused by Rosa');

    const recorded = await configured.USAGE.prepare(
      "SELECT outcome, detail FROM mcp_calls WHERE grant_id = ?1 AND detail = 'paused'",
    ).bind(grantID).all<{ outcome: string; detail: string }>();
    expect(recorded.results.length).toBe(2);
    expect(recorded.results.every((row) => row.outcome === 'refused')).toBe(true);

    const resumed = await post(`/api/mcp/grants/${grantID}/resume`, owner);
    expect(resumed.status).toBe(200);
    expect((await resumed.json<McpGrantsResponse>()).grants.find((grant) => grant.id === grantID)?.paused_at).toBeNull();
    expect((await rpc(token, 'tools/call', { name: 'now', arguments: {} })).result?.isError).toBe(false);
  });

  it('will not let another member pause or resume somebody else’s Claude', async () => {
    await bearer();
    const other = await session(cleo);
    for (const verb of ['pause', 'resume']) {
      const response = await post(`/api/mcp/grants/${grantID}/${verb}`, other);
      expect(response.status, verb).toBe(404);
    }
    const row = await configured.USAGE.prepare('SELECT paused_at FROM mcp_grants WHERE id = ?1').bind(grantID).first<{ paused_at: number | null }>();
    expect(row?.paused_at).toBeNull();
  });

  it('keeps a pause through a refresh, so Resume needs no new pairing', async () => {
    await bearer();
    const owner = await session(rosa);
    await post(`/api/mcp/grants/${grantID}/pause`, owner);
    const refreshToken = await new SignJWT({ grant: grantID })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('starlings.example')
      .setAudience('meet-mcp-refresh')
      .setSubject(`dev:${rosa.email}`)
      .setJti('jti')
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(signingKey(configured.SESSION_SIGNING_SECRET));
    const refreshed = await fetchWorker(new Request('http://local/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
    }));
    expect(refreshed.status).toBe(200);
    const row = await configured.USAGE.prepare('SELECT paused_at FROM mcp_grants WHERE id = ?1').bind(grantID).first<{ paused_at: number | null }>();
    expect(row?.paused_at).toBeGreaterThan(0);
  });
});

describe('freezing a roster agent', () => {
  const delivered: string[] = [];

  beforeEach(async () => {
    delivered.length = 0;
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      delivered.push((JSON.parse(String(init?.body)) as { message_id: string }).message_id);
      return new Response(null, { status: 202 });
    });
    await configured.USAGE.prepare('DELETE FROM agent_freezes').run();
    await ensureAgentPeople(configured, Date.now());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A DM between rosa and Vocab: the thread an agent is addressed in and answers into. */
  async function dmWithVocab(headers: Record<string, string>): Promise<string> {
    const response = await post('/api/threads', headers, { peer_email: vocabEmail });
    return (await response.json<{ thread: ThreadSummary }>()).thread.id;
  }

  async function agentDoor(actor: string): Promise<Response> {
    const raw = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const timestamp = String(Date.now());
    return fetchWorker(new Request('http://local/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-key-id': vocabEmail,
        'x-meet-agent': vocabEmail,
        'x-meet-actor': actor,
        'x-internal-timestamp': timestamp,
        'x-internal-signature': await hmacSHA256Hex(secret, `${timestamp}.${vocabEmail}.${actor}.${raw}`),
      },
      body: raw,
    }));
  }

  async function agentSays(threadId: string, key: string): Promise<Response> {
    const raw = JSON.stringify({ thread_id: threadId, type: 'text', sender: vocabEmail, text: 'done', idempotency_key: key });
    const timestamp = String(Date.now());
    return fetchWorker(new Request('http://local/api/internal/channel-events', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-key-id': vocabEmail,
        'x-internal-timestamp': timestamp,
        'x-internal-signature': await hmacSHA256Hex(secret, `${timestamp}.${raw}`),
      },
      body: raw,
    }));
  }

  function handOff(threadId: string, messageId: string): Promise<void> {
    return notifyThreadAgents(configured, {
      threadId,
      threadKind: 'dm',
      messageId,
      text: 'hello',
      sentAt: Date.now(),
      sender: { email: rosa.email, name: rosa.name },
    });
  }

  it('refuses the agent at every door until an admin unfreezes it, and tells the person who wrote', async () => {
    const admin = await session(rosa);
    const threadId = await dmWithVocab(admin);
    await handOff(threadId, 'controls-before');
    expect(delivered).toEqual(['controls-before']);
    expect((await agentDoor(rosa.email)).status).toBe(200);

    const frozen = await post(`/api/admin/agents/${vocabEmail}/freeze`, admin);
    expect(frozen.status).toBe(200);
    expect(await frozen.json<AdminAgentFreezeResponse>()).toMatchObject({ agent_email: vocabEmail, frozen_by_email: rosa.email });

    // The /mcp agent door.
    const door = await agentDoor(rosa.email);
    expect(door.status).toBe(403);
    expect((await door.json<{ error: string }>()).error).toContain('Vocab is frozen');

    // No hand-off, and a quiet line in its place.
    await handOff(threadId, 'controls-during');
    expect(delivered).toEqual(['controls-before']);
    const page = await fetchWorker(new Request(`http://local/api/threads/${threadId}/messages`, { headers: admin }));
    const { messages } = await page.json<ThreadMessagesResponse>();
    const notice = messages.find((message) => message.type === 'event' && message.text.includes('Vocab is frozen'));
    expect(notice).toBeDefined();

    // Its own messages.
    const said = await agentSays(threadId, 'controls-frozen-reply');
    expect(said.status).toBe(403);

    // Admin lists it as frozen, and the trail says who.
    const activity = await fetchWorker(new Request('http://local/api/admin/agent-activity', { headers: admin }));
    const body = await activity.json<AdminAgentActivityResponse>();
    expect(body.agents.find((agent) => agent.agent_email === vocabEmail)).toMatchObject({ frozen_by_email: rosa.email });
    const audit = await configured.USAGE.prepare(
      "SELECT actor_email FROM admin_audit WHERE action = 'agent.freeze' AND subject = ?1",
    ).bind(vocabEmail).first<{ actor_email: string }>();
    expect(audit?.actor_email).toBe(rosa.email);

    const unfrozen = await post(`/api/admin/agents/${encodeURIComponent(vocabEmail)}/unfreeze`, admin);
    expect(unfrozen.status).toBe(200);
    expect((await unfrozen.json<AdminAgentFreezeResponse>()).frozen_at).toBeNull();
    expect((await agentDoor(rosa.email)).status).toBe(200);
    await handOff(threadId, 'controls-after');
    expect(delivered).toEqual(['controls-before', 'controls-after']);
    expect((await agentSays(threadId, 'controls-thawed-reply')).status).toBe(200);
  });

  it('needs an admin to freeze or unfreeze', async () => {
    const member = await session(cleo);
    for (const verb of ['freeze', 'unfreeze']) {
      const response = await post(`/api/admin/agents/${vocabEmail}/${verb}`, member);
      expect(response.status, verb).toBe(403);
      await expect(response.json(), verb).resolves.toMatchObject({ code: 'not_org_admin' });
    }
    const row = await configured.USAGE.prepare('SELECT 1 AS yes FROM agent_freezes WHERE agent_sub = ?1').bind(vocabSub).first();
    expect(row).toBeNull();
  });

  it('refuses an address that is not a roster agent', async () => {
    const admin = await session(rosa);
    const response = await post(`/api/admin/agents/${cleo.email}/freeze`, admin);
    expect(response.status).toBe(404);
  });
});
