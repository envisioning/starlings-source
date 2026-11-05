import { env, exports } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ThreadMessagesResponse, ThreadSummary } from '@starlings/contracts';
import worker from '../src/index';
import { hmacSHA256Hex } from '../src/crypto';
import { inboundKeyEnvName } from '../src/inbound-keys';
import { recordOwnerSignIn } from '../src/usage';

/**
 * One inbound key per caller (meet#607). Each caller names its key in
 * `x-internal-key-id`; the Worker looks the secret up by that id and holds the
 * key to the one identity it was issued for. The old shared secret is gone
 * (meet#1019): a request that names no key is not found.
 */

// `agent-vocab` is the roster's own agent in wrangler.test.jsonc; the second is
// named only in the roster these tests hand the Worker.
const statusEmail = 'agent-vocab@example.com';
const eventsEmail = 'agent-events@example.com';
const rosa = { email: 'inbound-key-rosa@example.com', name: 'Rosa' };
const coreKey = 'core-key-for-the-inbound-key-tests-0123456789';
const statusKey = 'status-key-for-the-inbound-key-tests-0123456789';
const eventsKey = 'events-key-for-the-inbound-key-tests-0123456789';
let THREAD = '';

function configured(overrides: Record<string, string> = {}): Env {
  return {
    ...env,
    INTERNAL_REQUEST_SECRET: '',
    [inboundKeyEnvName('core')]: coreKey,
    [inboundKeyEnvName(statusEmail)]: statusKey,
    [inboundKeyEnvName(eventsEmail)]: eventsKey,
    AGENT_ROSTER: JSON.stringify({ [statusEmail]: 'Vocab', [eventsEmail]: 'Events' }),
    ...overrides,
  } as Env;
}

async function send(path: string, init: {
  body: unknown;
  secret: string;
  keyId?: string;
  headers?: Record<string, string>;
  /** The string the HMAC covers, from the timestamp and raw body. */
  message?: (timestamp: string, raw: string) => string;
  env?: Env;
}) {
  const raw = JSON.stringify(init.body);
  const timestamp = String(Date.now());
  const signature = await hmacSHA256Hex(init.secret, init.message ? init.message(timestamp, raw) : `${timestamp}.${raw}`);
  const context = createExecutionContext();
  const response = await worker.fetch(new Request(`http://local${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'x-internal-timestamp': timestamp,
      'x-internal-signature': signature,
      ...(init.keyId ? { 'x-internal-key-id': init.keyId } : {}),
      ...init.headers,
    },
    body: raw,
  }), init.env ?? configured(), context);
  await waitOnExecutionContext(context);
  return response;
}

const event = (sender: string | null, key: string) => ({
  thread_id: THREAD,
  type: 'text',
  ...(sender ? { sender } : {}),
  text: `hello from ${sender ?? 'nobody'} (${key})`,
  idempotency_key: key,
});

async function inboundRow(caller: string) {
  return env.USAGE.prepare('SELECT last_keyed_at, last_refused_at FROM ops_inbound WHERE caller = ?1')
    .bind(caller).first<{ last_keyed_at: number | null; last_refused_at: number | null }>();
}

async function lastFailureDetail(): Promise<string | null> {
  const row = await env.USAGE.prepare("SELECT last_detail FROM ops_failures WHERE kind = 'inbound_signature' ORDER BY last_at DESC LIMIT 1")
    .first<{ last_detail: string | null }>();
  return row?.last_detail ?? null;
}

let ownerHeaders: Record<string, string> = {};

async function threadText(): Promise<string[]> {
  const response = await exports.default.fetch(new Request(`http://local/api/threads/${THREAD}/messages`, { headers: ownerHeaders }));
  return (await response.json<ThreadMessagesResponse>()).messages.map((row) => row.text);
}

beforeEach(async () => {
  await env.USAGE.prepare('DELETE FROM ops_inbound').run();
  await env.USAGE.prepare("DELETE FROM ops_failures WHERE kind = 'inbound_signature'").run();
  const login = await exports.default.fetch(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(rosa),
  }));
  const { access_token } = await login.json<{ access_token: string }>();
  await recordOwnerSignIn(env as Env, { sub: `dev:${rosa.email}`, ...rosa }, 'mac');
  ownerHeaders = { authorization: `Bearer ${access_token}`, 'content-type': 'application/json' };
  const opened = await exports.default.fetch(new Request('http://local/api/threads', {
    method: 'POST', headers: ownerHeaders, body: JSON.stringify({ peer_email: statusEmail }),
  }));
  THREAD = (await opened.json<{ thread: ThreadSummary }>()).thread.id;
});

describe('the key a caller names', () => {
  it('derives the Worker secret name from the key id', () => {
    expect(inboundKeyEnvName('core')).toBe('INBOUND_KEY_CORE');
    expect(inboundKeyEnvName('vocab@example.com')).toBe('INBOUND_KEY_VOCAB_EXAMPLE_COM');
  });

  it('lets an agent speak with its own key, and records that it did', async () => {
    const response = await send('/api/internal/channel-events', {
      body: event(statusEmail, 'k-status-own'), secret: statusKey, keyId: statusEmail,
    });
    expect(response.status).toBe(200);
    expect(await threadText()).toContain(`hello from ${statusEmail} (k-status-own)`);
    const row = await inboundRow('agent:agent-vocab');
    expect(row?.last_keyed_at).toBeGreaterThan(Date.now() - 60_000);
  });

  it('refuses an agent key that names another agent, and writes nothing', async () => {
    const response = await send('/api/internal/channel-events', {
      body: event(statusEmail, 'k-events-as-status'), secret: eventsKey, keyId: eventsEmail,
    });
    expect(response.status).toBe(403);
    expect(await threadText()).not.toContain(`hello from ${statusEmail} (k-events-as-status)`);
    expect(await lastFailureDetail()).toBe('agent:agent-events: identity');
  });

  it('refuses an agent key that names no agent', async () => {
    const response = await send('/api/internal/channel-events', {
      body: { thread_id: THREAD, type: 'event', text: 'a quiet system line', idempotency_key: 'k-status-nosender' },
      secret: statusKey,
      keyId: statusEmail,
    });
    expect(response.status).toBe(403);
    expect(await lastFailureDetail()).toBe('agent:agent-vocab: identity');
  });

  it("refuses Core's key naming an agent, and accepts it naming none", async () => {
    const asAgent = await send('/api/internal/channel-events', {
      body: event(statusEmail, 'k-core-as-status'), secret: coreKey, keyId: 'core',
    });
    expect(asAgent.status).toBe(403);
    expect(await lastFailureDetail()).toBe('core: identity');

    const ownLine = await send('/api/internal/channel-events', {
      body: { thread_id: THREAD, type: 'event', text: 'Core says hi', idempotency_key: 'k-core-own' },
      secret: coreKey,
      keyId: 'core',
    });
    // Past the lock: Core's own lines address a subject, so this thread id is
    // simply not one it can write to. What matters is that it was not a 403.
    expect(ownLine.status).not.toBe(403);
    expect((await inboundRow('core'))?.last_keyed_at).toBeGreaterThan(Date.now() - 60_000);
  });

  it("answers Core's ping only to Core's key", async () => {
    expect((await send('/api/internal/ping', { body: { ping: true }, secret: coreKey, keyId: 'core' })).status).toBe(200);
    expect((await send('/api/internal/ping', { body: { ping: true }, secret: statusKey, keyId: statusEmail })).status).toBe(403);
  });

  it('refuses a key id signed with somebody else\'s secret', async () => {
    const response = await send('/api/internal/channel-events', {
      body: event(statusEmail, 'k-swapped'), secret: eventsKey, keyId: statusEmail,
    });
    expect(response.status).toBe(403);
    expect(await lastFailureDetail()).toBe('agent:agent-vocab: mismatch');
  });

  it('refuses a key id nobody issued, and one that has no secret yet', async () => {
    const unknown = await send('/api/internal/channel-events', {
      body: event(statusEmail, 'k-unknown'), secret: statusKey, keyId: 'vocab@example.com',
    });
    expect(unknown.status).toBe(403);
    expect(await lastFailureDetail()).toBe('unknown-key: unknown_key');

    const unprovisioned = await send('/api/internal/channel-events', {
      body: event(statusEmail, 'k-unprovisioned'),
      secret: statusKey,
      keyId: statusEmail,
      env: configured({ [inboundKeyEnvName(statusEmail)]: '' }),
    });
    expect(unprovisioned.status).toBe(403);
  });
});

describe('a request that names no key', () => {
  // The old shared secret verified these until it was removed on 2026-10-06
  // (meet#1019). Now no secret verifies them, and every door answers 404.
  it('is not found on every door, even signed with a real key', async () => {
    expect((await send('/api/internal/ping', { body: { ping: true }, secret: coreKey })).status).toBe(404);
    expect((await send('/api/internal/channel-events', { body: event(statusEmail, 'k-no-key-id'), secret: statusKey })).status).toBe(404);
    expect(await threadText()).not.toContain(`hello from ${statusEmail} (k-no-key-id)`);
    expect(await inboundRow('core')).toBeNull();
    expect(await inboundRow('agent:agent-vocab')).toBeNull();
  });
});

describe('a Keep release fetch', () => {
  const release = (sender: string, key: string) => ({ sender, thread_id: THREAD, message_id: `msg-${key}` });

  it("refuses Core's key, and counts it", async () => {
    const response = await send('/api/internal/keep-release', {
      body: release(statusEmail, 'k-core-release'), secret: coreKey, keyId: 'core',
    });
    expect(response.status).toBe(403);
    expect(await lastFailureDetail()).toBe('core: identity');
    expect((await inboundRow('core'))?.last_keyed_at ?? null).toBeNull();
  });

  it("refuses one agent's key fetching as another", async () => {
    const response = await send('/api/internal/keep-release', {
      body: release(statusEmail, 'k-events-release'), secret: eventsKey, keyId: eventsEmail,
    });
    expect(response.status).toBe(403);
    expect(await lastFailureDetail()).toBe('agent:agent-events: identity');
  });

  it("lets an agent's own key past the identity lock", async () => {
    const response = await send('/api/internal/keep-release', {
      body: release(statusEmail, 'k-status-release'), secret: statusKey, keyId: statusEmail,
    });
    // Past the lock: there is no Keep and no such card here, so this is a 404,
    // never the identity 403.
    expect(response.status).not.toBe(403);
    expect((await inboundRow('agent:agent-vocab'))?.last_keyed_at).toBeGreaterThan(Date.now() - 60_000);
  });

  it('is not found with no key id', async () => {
    const response = await send('/api/internal/keep-release', {
      body: release(statusEmail, 'k-no-key-release'), secret: statusKey,
    });
    expect(response.status).toBe(404);
  });
});

describe('/mcp as an agent', () => {
  const agentCall = (agent: string, secret: string, keyId?: string) => send('/mcp', {
    body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    secret,
    ...(keyId ? { keyId } : {}),
    headers: { 'x-meet-agent': agent, 'x-meet-actor': rosa.email },
    message: (timestamp, raw) => `${timestamp}.${agent}.${rosa.email}.${raw}`,
  });

  it('reads as the person who addressed the agent, with the agent\'s own key', async () => {
    const response = await agentCall(statusEmail, statusKey, statusEmail);
    expect(response.status).toBe(200);
    expect((await inboundRow('agent:agent-vocab'))?.last_keyed_at).toBeGreaterThan(Date.now() - 60_000);
  });

  it('refuses one agent\'s key speaking as another, and Core\'s key speaking as any', async () => {
    // events-test has never addressed anyone, so this would fail at the actor
    // lock too; what matters is that it fails before it gets that far.
    const swapped = await agentCall(statusEmail, eventsKey, eventsEmail);
    expect(swapped.status).toBe(403);
    expect(await lastFailureDetail()).toBe('agent:agent-events: identity');

    const fromCore = await agentCall(statusEmail, coreKey, 'core');
    expect(fromCore.status).toBe(403);
    expect(await lastFailureDetail()).toBe('core: identity');
  });

  it('is not found with no key id, even signed with the agent\'s own key', async () => {
    const response = await agentCall(statusEmail, statusKey);
    expect(response.status).toBe(404);
  });
});
