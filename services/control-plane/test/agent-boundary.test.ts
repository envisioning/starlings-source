import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { agentSub } from '@starlings/contracts';
import worker from '../src/index';
import { ensureAgentPeople } from '../src/agents';
import { hmacSHA256Hex } from '../src/crypto';
import { inboundKeyEnvName } from '../src/inbound-keys';
import { admitRoomHost, ensureOwnerRoom } from '../src/room-access';

/**
 * The agent boundary (meet#913, src/agent-boundary.ts). A workspace agent
 * reads through `/mcp` as the person who addressed it, and still never reads
 * what is that person's alone: their Quick Notes, their calendar, a private
 * conversation the agent is not in, or their room.
 */

const agentEmail = 'boundary-test@example.com';
const secret = 'an-inbound-secret-for-the-agent-boundary-test';
const mzEmail = 'rosa@example.com';
const adaEmail = 'boundary-ada@example.com';
const configured = {
  ...env,
  [inboundKeyEnvName(agentEmail)]: secret,
  // Keep `now`'s feed read inside the test (see mcp-agent-principal.test.ts).
  INTERNAL_REQUEST_SECRET: '',
  AGENT_ROSTER: JSON.stringify({ [agentEmail]: 'Boundary' }),
} as Env;

async function fetchWorker(path: string, init: RequestInit) {
  const context = createExecutionContext();
  const response = await worker.fetch(new Request(`http://local${path}`, init), configured, context);
  await waitOnExecutionContext(context);
  return response;
}

async function session(email: string, name: string) {
  const response = await fetchWorker('/api/dev/session', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, email }),
  });
  const { access_token: token } = await response.json<{ access_token: string }>();
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', origin: configured.WEB_ORIGIN };
  await fetchWorker('/api/peers', { headers });
  return headers;
}

async function asAgent(method: string, params: unknown) {
  const raw = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  const timestamp = String(Date.now());
  const signature = await hmacSHA256Hex(secret, `${timestamp}.${agentEmail}.${mzEmail}.${raw}`);
  const response = await fetchWorker('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'x-internal-key-id': agentEmail,
      'x-meet-agent': agentEmail,
      'x-meet-actor': mzEmail,
      'x-internal-timestamp': timestamp,
      'x-internal-signature': signature,
    },
    body: raw,
  });
  return JSON.stringify(await response.json());
}

async function openDM(headers: Record<string, string>, peer: string, text: string): Promise<string> {
  const opened = await fetchWorker('/api/threads', { method: 'POST', headers, body: JSON.stringify({ peer_email: peer }) });
  const body = await opened.json<{ thread?: { id: string }; id?: string }>();
  const id = body.thread?.id ?? body.id!;
  const sent = await fetchWorker(`/api/threads/${id}/messages`, { method: 'POST', headers, body: JSON.stringify({ text }) });
  expect(sent.status).toBe(201);
  return id;
}

describe('agent boundary', () => {
  it('keeps the person\'s Quick Notes and private conversations from an agent acting as them', async () => {
    const rosa = await session(mzEmail, 'Rosa');
    await session(adaEmail, 'Ada');
    await ensureAgentPeople(configured, Date.now());

    const note = await fetchWorker('/api/quick-notes', {
      method: 'POST', headers: rosa, body: JSON.stringify({ body: 'Boundary note canary', source: 'home' }),
    });
    expect(note.status).toBe(201);
    const withAda = await openDM(rosa, adaEmail, 'boundarydmcanary with Ada');
    // ROSA addresses the agent: the agent may read this one, it is in it.
    const withAgent = await openDM(rosa, agentEmail, 'boundaryagentcanary for the agent');

    const now = await asAgent('tools/call', { name: 'now', arguments: {} });
    expect(now).not.toContain('Boundary note canary');

    const privateThread = await asAgent('resources/read', { uri: `starlings://thread/${withAda}` });
    expect(privateThread).not.toContain('boundarydmcanary');
    expect(privateThread).toContain('Conversation not found');

    const ownThread = await asAgent('resources/read', { uri: `starlings://thread/${withAgent}` });
    expect(ownThread).toContain('boundaryagentcanary');

    const since = encodeURIComponent(new Date(Date.now() - 3_600_000).toISOString());
    const changes = await asAgent('resources/read', { uri: `starlings://changes/${since}` });
    expect(changes).not.toContain('boundarydmcanary');

    const search = await asAgent('tools/call', { name: 'search', arguments: { query: 'boundarydmcanary' } });
    expect(search).not.toContain(withAda);

    const calendar = await asAgent('resources/read', { uri: 'starlings://calendar/0/7' });
    expect(calendar).toContain('private to the member');

    // The person still reads all of it.
    const notes = await fetchWorker('/api/quick-notes', { headers: rosa });
    expect(await notes.text()).toContain('Boundary note canary');
    const messages = await fetchWorker(`/api/threads/${withAda}/messages`, { headers: rosa });
    expect(await messages.text()).toContain('boundarydmcanary');
  });

  it('is never the room owner or host', async () => {
    const agent = { sub: 'dev:rosa@example.com', email: mzEmail, name: 'Rosa', agentSub: agentSub(agentEmail) };
    await expect(ensureOwnerRoom(configured, 'boundary-room', agent)).rejects.toMatchObject({ code: 'not_room_owner' });
    await expect(admitRoomHost(configured, 'boundary-room', agent)).rejects.toMatchObject({ code: 'not_room_owner' });
  });
});
