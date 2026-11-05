import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRoster, agentSub } from '@starlings/contracts';
import worker from '../src/index';
import { ensureAgentPeople } from '../src/agents';
import { hmacSHA256Hex } from '../src/crypto';
import { inboundKeyEnvName } from '../src/inbound-keys';
import { recordOwnerSignIn } from '../src/usage';

/**
 * The agent principal on `/mcp` (docs/MCP.md build order step 5). An agent
 * signs with its own inbound key, names itself and the person who addressed
 * it, and reads as that person — read-only, with the record saying so.
 */

const statusEmail = 'status-test@example.com';
const statusSub = agentSub(statusEmail);
const eventsEmail = 'events-test@example.com';
const eventsSub = agentSub(eventsEmail);
const rosa = { sub: 'mcp-agent-rosa', email: 'mcp-agent-rosa@example.com', name: 'Rosa' };
const stranger = { sub: 'mcp-agent-stranger', email: 'mcp-agent-stranger@example.com', name: 'Stranger' };
const secret = 'an-inbound-secret-for-the-agent-principal-test';

const configured = {
  ...env,
  // One key per agent, named by `x-internal-key-id` (meet#607).
  [inboundKeyEnvName(statusEmail)]: secret,
  [inboundKeyEnvName(eventsEmail)]: secret,
  // Keep the `now` tool's optional feed read inside the test. A developer's
  // .dev.vars may carry the real Core secret, and that turns this identity
  // test into a rate-limited network test.
  INTERNAL_REQUEST_SECRET: '',
  // No endpoint: the roster read behind `now` would otherwise probe it for a manifest.
  AGENT_ROSTER: JSON.stringify({
    [statusEmail]: 'Status',
    // Writes `cms` on `events` and nothing else (docs/EVENTS_AGENT.md §Blocker 1).
    [eventsEmail]: { name: 'Events', writes: [{ tool: 'cms', entity: 'events' }] },
  }),
} as Env;

async function seedThreadMember(threadId: string, memberSub: string, memberEmail: string) {
  await configured.USAGE.prepare(
    "INSERT INTO threads (id, kind, created_at) VALUES (?1, 'dm', ?2) ON CONFLICT(id) DO NOTHING",
  ).bind(threadId, Date.now()).run();
  await configured.USAGE.prepare(
    'INSERT INTO thread_members (thread_id, member_sub, member_email) VALUES (?1, ?2, ?3) ON CONFLICT(thread_id, member_sub) DO NOTHING',
  ).bind(threadId, memberSub, memberEmail).run();
}

interface CallOptions {
  agent?: string;
  actor?: string;
  /** The `x-internal-key-id` sent; the agent by default, null for none. */
  keyId?: string | null;
  sign?: (timestamp: string, body: string) => Promise<string>;
  extraHeaders?: Record<string, string>;
  env?: Env;
}

async function rpc(body: unknown, options: CallOptions = {}) {
  const agent = options.agent ?? statusEmail;
  const actor = options.actor ?? rosa.email;
  const keyId = options.keyId === undefined ? agent : options.keyId;
  const raw = JSON.stringify(body);
  const timestamp = String(Date.now());
  const signature = options.sign
    ? await options.sign(timestamp, raw)
    : await hmacSHA256Hex(secret, `${timestamp}.${agent}.${actor}.${raw}`);
  const context = createExecutionContext();
  const response = await worker.fetch(new Request('http://local/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...(keyId ? { 'x-internal-key-id': keyId } : {}),
      'x-meet-agent': agent,
      'x-meet-actor': actor,
      'x-internal-timestamp': timestamp,
      'x-internal-signature': signature,
      ...options.extraHeaders,
    },
    body: raw,
  }), options.env ?? configured, context);
  await waitOnExecutionContext(context);
  return response;
}

const request = (method: string, params: unknown = {}, id = 1) => ({ jsonrpc: '2.0', id, method, params });

describe('agent principal on /mcp', () => {
  beforeEach(async () => {
    await recordOwnerSignIn(configured, rosa, 'mac');
    await recordOwnerSignIn(configured, stranger, 'mac');
    await ensureAgentPeople(configured, Date.now());
    await seedThreadMember('mcp-agent-thread', statusSub, statusEmail);
    await seedThreadMember('mcp-agent-thread', rosa.sub, rosa.email);
  });

  afterEach(async () => {
    await configured.USAGE.prepare("DELETE FROM mcp_calls WHERE client_name IN ('Status', 'Events')").run();
  });

  it('reads as the person who addressed it, read-only, and the record says agent', async () => {
    const initialized = await rpc(request('initialize', { protocolVersion: '2025-06-18' }));
    expect(initialized.status).toBe(200);
    const { result } = await initialized.json<{ result: { instructions: string } }>();
    expect(result.instructions).toContain('You are the agent Status');
    expect(result.instructions).toContain(rosa.email);
    expect(result.instructions).toContain('read-only');

    const listed = await rpc(request('tools/list'));
    const { result: tools } = await listed.json<{ result: { tools: Array<{ name: string }> } }>();
    const names = tools.tools.map((tool) => tool.name);
    expect(names).toContain('search');
    expect(names).toContain('now');
    expect(names).not.toContain('send_message');
    expect(names).not.toContain('task');

    const called = await rpc(request('tools/call', { name: 'now', arguments: {} }));
    expect(called.status).toBe(200);
    const answer = await called.json<{ result: { isError?: boolean }; error?: unknown }>();
    expect(answer.error).toBeUndefined();
    expect(answer.result.isError).toBeFalsy();

    const row = await configured.USAGE.prepare(
      'SELECT principal, actor_email, grant_id, client_name, name, outcome FROM mcp_calls WHERE client_name = ?1 ORDER BY ts DESC LIMIT 1',
    ).bind('Status').first<{ principal: string; actor_email: string; grant_id: string | null; client_name: string; name: string; outcome: string }>();
    expect(row).toMatchObject({ principal: 'agent', actor_email: rosa.email, grant_id: null, client_name: 'Status', name: 'now', outcome: 'ok' });
  });

  it('refuses a write, and records the refusal', async () => {
    const response = await rpc(request('tools/call', { name: 'send_message', arguments: { thread_id: 'mcp-agent-thread', text: 'hi' } }));
    expect(response.status).toBe(200);
    const { result } = await response.json<{ result: {
      isError?: boolean;
      content: Array<{ text: string }>;
      structuredContent?: { error: { code: string; message: string; hint: string; retryable: boolean } };
    } }>();
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(
      'capability_denied: This connector is read-only. — An agent writes only what its AGENT_ROSTER entry names under `writes`. Tell the person what you would have written, so they can do it.',
    );
    expect(result.structuredContent).toEqual({
      error: {
        code: 'capability_denied',
        message: 'This connector is read-only.',
        hint: 'An agent writes only what its AGENT_ROSTER entry names under `writes`. Tell the person what you would have written, so they can do it.',
        retryable: false,
      },
    });
    const row = await configured.USAGE.prepare(
      'SELECT principal, outcome, detail FROM mcp_calls WHERE client_name = ?1 AND name = ?2',
    ).bind('Status', 'send_message').first<{ principal: string; outcome: string; detail: string }>();
    expect(row).toMatchObject({ principal: 'agent', outcome: 'refused', detail: 'scope' });
  });

  it('serves the review resources', async () => {
    const response = await rpc(request('resources/templates/list'));
    const { result } = await response.json<{ result: { resourceTemplates: Array<{ uriTemplate: string }> } }>();
    const templates = result.resourceTemplates.map((template) => template.uriTemplate);
    expect(templates).toEqual(expect.arrayContaining([
      'starlings://subjects/{kind}',
      'starlings://board/{days}',
      'starlings://feed/{limit}',
      'starlings://changes/{cursor}',
      'starlings://calendar/{days_back}/{days_ahead}',
    ]));

    const outOfRange = await rpc(request('resources/read', { uri: 'starlings://board/0' }));
    const refused = await outOfRange.json<{ error?: { message: string } }>();
    expect(refused.error?.message).toContain('No resource at that URI.');
  });

  it('refuses an actor who never addressed the agent, until a hand-off records that they did', async () => {
    await configured.USAGE.prepare('DELETE FROM agent_addressers WHERE agent_sub = ?1 AND actor_sub = ?2').bind(statusSub, stranger.sub).run();
    const response = await rpc(request('tools/list'), { actor: stranger.email });
    expect(response.status).toBe(403);
    const body = await response.json<{ error: string }>();
    expect(body.error).toContain('has not addressed');

    // A channel @mention has no thread_members row; the hand-off writes this instead.
    await configured.USAGE.prepare('INSERT INTO agent_addressers (agent_sub, actor_sub, last_at) VALUES (?1, ?2, ?3)').bind(statusSub, stranger.sub, Date.now()).run();
    const allowed = await rpc(request('tools/list'), { actor: stranger.email });
    expect(allowed.status).toBe(200);
  });

  it('refuses an agent the roster does not name, and a human posing as one', async () => {
    const unknown = await rpc(request('tools/list'), { agent: 'nobody@example.com' });
    expect(unknown.status).toBe(403);
    const posing = await rpc(request('tools/list'), { agent: rosa.email });
    expect(posing.status).toBe(403);
    // A real agent key may not claim another agent's identity.
    const borrowed = await rpc(request('tools/list'), { agent: eventsEmail, keyId: statusEmail });
    expect(borrowed.status).toBe(403);
  });

  it('refuses a bad signature, a session token, and a request with no key id', async () => {
    const forged = await rpc(request('tools/list'), { sign: async () => 'deadbeef'.repeat(8) });
    expect(forged.status).toBe(403);

    const replayedAsSomebodyElse = await rpc(request('tools/list'), {
      actor: stranger.email,
      // Signed for rosa, sent naming the stranger: the actor is inside the signed string.
      sign: async (timestamp, body) => hmacSHA256Hex(secret, `${timestamp}.${statusEmail}.${rosa.email}.${body}`),
    });
    expect(replayedAsSomebodyElse.status).toBe(403);

    const withSession = await rpc(request('tools/list'), { extraHeaders: { authorization: 'Bearer anything' } });
    expect(withSession.status).toBe(403);

    const unnamed = await rpc(request('tools/list'), { keyId: null });
    expect(unnamed.status).toBe(404);
  });
});

describe('agent writes named on the roster', () => {
  beforeEach(async () => {
    await recordOwnerSignIn(configured, rosa, 'mac');
    await ensureAgentPeople(configured, Date.now());
    await seedThreadMember('mcp-agent-events-thread', eventsSub, eventsEmail);
    await seedThreadMember('mcp-agent-events-thread', rosa.sub, rosa.email);
    await seedThreadMember('mcp-agent-thread', statusSub, statusEmail);
    await seedThreadMember('mcp-agent-thread', rosa.sub, rosa.email);
  });

  afterEach(async () => {
    await configured.USAGE.prepare("DELETE FROM mcp_calls WHERE client_name IN ('Status', 'Events')").run();
  });

  const cmsWrite = (entity: string, key: string) => request('tools/call', {
    name: 'cms',
    arguments: { entity, body: { title: 'Roster writes probe' }, idempotency_key: key },
  });

  async function lastRow(client: string) {
    return configured.USAGE.prepare(
      'SELECT principal, outcome, detail FROM mcp_calls WHERE client_name = ?1 AND name = ?2 ORDER BY ts DESC LIMIT 1',
    ).bind(client, 'cms').first<{ principal: string; outcome: string; detail: string | null }>();
  }

  it('parses writes strictly: a malformed rule is dropped, never widened', () => {
    const [agent] = agentRoster(JSON.stringify({
      [eventsEmail]: {
        name: 'Events',
        writes: [
          { tool: 'cms', entity: 'events' },
          { tool: 'cms', entity: 'Events!' },
          { tool: 'cms', entity: 'events', extra: true },
          'cms',
        ],
      },
    }));
    expect(agent?.writes).toEqual([{ tool: 'cms', entity: 'events' }]);
    const [plain] = agentRoster(JSON.stringify({ [statusEmail]: 'Status' }));
    expect(plain?.writes).toBeUndefined();
  });

  it('says the exception in its instructions', async () => {
    const initialized = await rpc(request('initialize', { protocolVersion: '2025-06-18' }), { agent: eventsEmail });
    const { result } = await initialized.json<{ result: { instructions: string } }>();
    expect(result.instructions).toContain('You are the agent Events');
    expect(result.instructions).toContain('except `cms` on `events`');
  });

  it('lets the named write through the scope check', async () => {
    const response = await rpc(cmsWrite('events', 'roster-writes-events'), { agent: eventsEmail });
    expect(response.status).toBe(200);
    const row = await lastRow('Events');
    // Core is not reachable in the test Worker, so the write fails past the
    // gate. What matters is that it was not refused for scope.
    expect(row?.principal).toBe('agent');
    expect(row?.detail).not.toBe('scope');
  });

  it('refuses the same agent on another entity, with the agent hint', async () => {
    const response = await rpc(cmsWrite('research', 'roster-writes-research'), { agent: eventsEmail });
    const { result } = await response.json<{ result: { isError?: boolean; structuredContent?: { error: { code: string; hint: string } } } }>();
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error.code).toBe('capability_denied');
    expect(result.structuredContent?.error.hint).toContain('AGENT_ROSTER');
    expect(await lastRow('Events')).toMatchObject({ principal: 'agent', outcome: 'refused', detail: 'scope' });
  });

  it('refuses the same agent on another write tool', async () => {
    const response = await rpc(request('tools/call', { name: 'send_message', arguments: { thread_id: 'mcp-agent-events-thread', text: 'hi' } }), { agent: eventsEmail });
    const { result } = await response.json<{ result: { isError?: boolean } }>();
    expect(result.isError).toBe(true);
  });

  it('lets the named agent ask for an event image through the same rule', async () => {
    const response = await rpc(request('tools/call', {
      name: 'cms',
      arguments: { entity: 'events', id: 'b8dc234b-da7a-4bf0-9bc9-e041663d7ad9', image: { look: 'appearance', scene: 'Museu do Amanhã at blue hour' }, idempotency_key: 'roster-writes-image' },
    }), { agent: eventsEmail });
    expect(response.status).toBe(200);
    const row = await lastRow('Events');
    // Core is not reachable here either: past the gate, not refused for scope.
    expect(row?.principal).toBe('agent');
    expect(row?.detail).not.toBe('scope');
  });

  it('lets the named agent copy another event\'s image through the same rule', async () => {
    const response = await rpc(request('tools/call', {
      name: 'cms',
      arguments: { entity: 'events', id: 'b8dc234b-da7a-4bf0-9bc9-e041663d7ad9', image: { from_event_id: '5b0f3c2e-8d1a-4f6b-9c7e-2a4d6e8f0b1c' }, idempotency_key: 'roster-writes-image-copy' },
    }), { agent: eventsEmail });
    expect(response.status).toBe(200);
    const row = await lastRow('Events');
    expect(row?.principal).toBe('agent');
    expect(row?.detail).not.toBe('scope');
  });

  it('refuses an image from an agent with no writes', async () => {
    const response = await rpc(request('tools/call', {
      name: 'cms',
      arguments: { entity: 'events', id: 'b8dc234b-da7a-4bf0-9bc9-e041663d7ad9', image: { look: 'appearance', scene: 'Museu do Amanhã' }, idempotency_key: 'roster-writes-image-status' },
    }));
    const { result } = await response.json<{ result: { isError?: boolean } }>();
    expect(result.isError).toBe(true);
    expect(await lastRow('Status')).toMatchObject({ principal: 'agent', outcome: 'refused', detail: 'scope' });
  });

  it('refuses an agent whose roster names no writes', async () => {
    const response = await rpc(cmsWrite('events', 'roster-writes-status'));
    const { result } = await response.json<{ result: { isError?: boolean } }>();
    expect(result.isError).toBe(true);
    expect(await lastRow('Status')).toMatchObject({ principal: 'agent', outcome: 'refused', detail: 'scope' });
  });
});
