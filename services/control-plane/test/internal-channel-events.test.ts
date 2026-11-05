// The one inbound trust edge. See docs/AGENTS_SURFACE.md.
import { coreIssueDetail, coreTask } from './core-rows';
import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InternalChannelEventResponse, ThreadMessagesResponse, ThreadSummary } from '@starlings/contracts';
import { recordOwnerSignIn } from '../src/usage';
import { openSubjectThread } from '../src/threads';
import { purgeAllCoreCache } from '../src/core-cache';

import { requireCapability } from '../src/capabilities';
// The person a route's gate has already read: what a thread function takes now.
const memberOf = (request: Request) => requireCapability(request, env as Env, 'conversations');

const rosa = { sub: 'ag-rosa', email: 'ag-rosa@example.com', name: 'Rosa' };
const vocab = { email: 'agent-vocab@example.com', name: 'Vocab' };
// One inbound key per caller (meet#607), set in vitest.config.ts: Core's,
// and Vocab's own.
const SECRET = 'inbound-test-secret-with-at-least-32-characters';
const VOCAB_KEY = 'vocab-inbound-test-key-with-at-least-32-characters';

/** The same envelope Core already verifies in the other direction. */
async function sign(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function post(
  body: unknown,
  options: {
    secret?: string;
    /** The `x-internal-key-id` sent: by default the body's sender, else Core; null for none. */
    keyId?: string | null;
    timestamp?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const raw = JSON.stringify(body);
  const timestamp = options.timestamp ?? String(Date.now());
  const sender = (body as { sender?: string }).sender;
  const keyId = options.keyId === undefined ? (sender ?? 'core') : options.keyId;
  const signature = await sign(options.secret ?? (keyId === 'core' ? SECRET : VOCAB_KEY), timestamp, raw);
  return exports.default.fetch(
    new Request('http://local/api/internal/channel-events', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(keyId ? { 'x-internal-key-id': keyId } : {}),
        'x-internal-timestamp': timestamp,
        'x-internal-signature': signature,
        ...options.headers,
      },
      body: raw,
    }),
  );
}

async function session(person: { email: string; name: string }) {
  const response = await exports.default.fetch(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(person),
  }));
  const body = await response.json<{ access_token: string }>();
  await recordOwnerSignIn(env as Env, { sub: `dev:${person.email}`, ...person }, 'mac');
  return { authorization: `Bearer ${body.access_token}`, 'content-type': 'application/json' };
}

/** A DM with the agent, opened by a person — the shape an agent replies into. */
async function openAgentThread(headers: Record<string, string>): Promise<ThreadSummary> {
  const response = await exports.default.fetch(new Request('http://local/api/threads', {
    method: 'POST',
    headers,
    body: JSON.stringify({ peer_email: vocab.email }),
  }));
  return (await response.json<{ thread: ThreadSummary }>()).thread;
}

async function messages(headers: Record<string, string>, id: string) {
  const response = await exports.default.fetch(
    new Request(`http://local/api/threads/${id}/messages`, { headers }),
  );
  return (await response.json<ThreadMessagesResponse>()).messages;
}

async function react(headers: Record<string, string>, threadID: string, messageID: string, emoji: string) {
  return exports.default.fetch(new Request(
    `http://local/api/threads/${threadID}/messages/${messageID}/reactions`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ emoji }),
    },
  ));
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await env.USAGE.prepare('DELETE FROM thread_members').run();
  await env.USAGE.prepare('DELETE FROM threads').run();
  await env.USAGE.prepare("DELETE FROM people WHERE email LIKE 'ag-%' OR kind = 'agent'").run();
});

describe('the inbound door', () => {
  it('does not exist for a request that names no key', async () => {
    // The door must not advertise itself by answering 401 (meet#1019: the
    // old shared secret that verified such a request is gone).
    const response = await post(
      { thread_id: 'team', text: 'hello', idempotency_key: 'k-no-key-id' },
      { keyId: null },
    );
    expect(response.status).toBe(404);
  });

  it('refuses a request carrying a session', async () => {
    const headers = await session(rosa);
    const response = await post(
      { thread_id: 'team', text: 'hello', idempotency_key: 'k-session' },
      { headers: { authorization: headers.authorization } },
    );
    expect(response.status).toBe(403);
  });

  it('refuses a signature made with the wrong secret', async () => {
    const response = await post(
      { thread_id: 'team', text: 'hello', idempotency_key: 'k-wrong' },
      { secret: 'not-the-inbound-secret-but-long-enough-to-pass' },
    );
    expect(response.status).toBe(403);
  });

  it('refuses a signature from outside the clock window', async () => {
    const response = await post(
      { thread_id: 'team', text: 'hello', idempotency_key: 'k-stale' },
      { timestamp: String(Date.now() - 3_600_000) },
    );
    expect(response.status).toBe(403);
  });

  it('refuses an unsigned request', async () => {
    const response = await exports.default.fetch(
      new Request('http://local/api/internal/channel-events', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-key-id': 'core' },
        body: JSON.stringify({ thread_id: 'team', text: 'hi', idempotency_key: 'k-unsigned' }),
      }),
    );
    expect(response.status).toBe(403);
  });

  it('refuses an unknown thread', async () => {
    const response = await post({
      thread_id: 'prj_nothing_here',
      text: 'opened #1',
      idempotency_key: 'k-nothread',
    });
    expect(response.status).toBe(404);
  });
});

describe('the canary ping (core#195)', () => {
  async function ping(options: { secret?: string; keyId?: string | null; timestamp?: string; sign?: boolean; headers?: Record<string, string> } = {}) {
    const raw = JSON.stringify({ ping: true, sent_at: Date.now() });
    const timestamp = options.timestamp ?? String(Date.now());
    const headers: Record<string, string> = { 'content-type': 'application/json', ...options.headers };
    if (options.sign !== false) {
      headers['x-internal-timestamp'] = timestamp;
      headers['x-internal-signature'] = await sign(options.secret ?? SECRET, timestamp, raw);
    }
    if (options.keyId !== null) headers['x-internal-key-id'] = options.keyId ?? 'core';
    return exports.default.fetch(new Request('http://local/api/internal/ping', { method: 'POST', headers, body: raw }));
  }

  async function acceptedAt(): Promise<number | null> {
    const row = await (env as Env).USAGE.prepare('SELECT last_accepted_at FROM ops_inbound WHERE caller = ?1')
      .bind('core').first<{ last_accepted_at: number | null }>();
    return row?.last_accepted_at ?? null;
  }

  it('answers a signed call, writes no line, and counts as Core having called', async () => {
    await (env as Env).USAGE.prepare('DELETE FROM ops_inbound').run();
    const response = await ping();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, pong: true });
    expect(await acceptedAt()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('refuses the wrong secret, a stale clock, no signature and a session; and 404s without a key id', async () => {
    await (env as Env).USAGE.prepare('DELETE FROM ops_inbound').run();
    expect((await ping({ secret: 'not-the-inbound-secret-but-long-enough-to-pass' })).status).toBe(403);
    expect((await ping({ timestamp: String(Date.now() - 3_600_000) })).status).toBe(403);
    expect((await ping({ sign: false })).status).toBe(403);
    const headers = await session(rosa);
    expect((await ping({ headers: { authorization: headers.authorization! } })).status).toBe(403);
    expect(await acceptedAt()).toBeNull();

    expect((await ping({ keyId: null })).status).toBe(404);
  });
});

describe('who may speak', () => {
  it('refuses a sender that is not in the agent roster', async () => {
    const headers = await session(rosa);
    await exports.default.fetch(new Request('http://local/api/threads', {
      method: 'POST', headers, body: JSON.stringify({ kind: 'team' }),
    }));
    const human = {
      thread_id: 'team',
      type: 'text',
      sender: rosa.email,
      text: 'not me',
      idempotency_key: 'k-human-sender',
    };
    // No key carries a person's address, and no agent key may claim one.
    expect((await post(human)).status).toBe(403);
    expect((await post(human, { keyId: vocab.email })).status).toBe(403);
  });

  it('refuses a text message with no sender', async () => {
    // An event may carry a sender since the board (docs/BOARD.md): that is an
    // agent narrating its own work. An answer never goes unsigned.
    const noSender = await post({
      thread_id: 'team', type: 'text', text: 'anonymous', idempotency_key: 'k-nosender',
    });
    expect(noSender.status).toBe(400);
  });

  it('refuses an agent writing into a conversation it is not in', async () => {
    const headers = await session(rosa);
    // A note to self: one member, and it is not the agent.
    const response = await exports.default.fetch(new Request('http://local/api/threads', {
      method: 'POST', headers, body: JSON.stringify({ peer_email: rosa.email }),
    }));
    const solo = (await response.json<{ thread: ThreadSummary }>()).thread;

    const attempt = await post({
      thread_id: solo.id, type: 'text', sender: vocab.email, text: 'listening', idempotency_key: 'k-outsider',
    });
    expect(attempt.status).toBe(404);
  });
});

describe('an agent answering', () => {
  it('lands in the DM and reorders the conversation list', async () => {
    const headers = await session(rosa);
    const thread = await openAgentThread(headers);

    const response = await post({
      thread_id: thread.id,
      type: 'text',
      sender: vocab.email,
      text: 'Found 3 new terms on that page.',
      idempotency_key: 'k-answer-1',
    });
    expect(response.status).toBe(200);
    const body = await response.json<InternalChannelEventResponse>();
    expect(body).toMatchObject({ ok: true, duplicate: false });

    const rows = await messages(headers, thread.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sender_email: vocab.email,
      text: 'Found 3 new terms on that page.',
      type: 'text',
      is_mine: false,
    });

    // A message from an agent is somebody talking to you: it badges.
    const indexed = await env.USAGE.prepare(
      'SELECT last_message_preview, last_sender_email FROM threads WHERE id = ?1',
    ).bind(thread.id).first<{ last_message_preview: string; last_sender_email: string }>();
    expect(indexed?.last_sender_email).toBe(vocab.email);
    expect(indexed?.last_message_preview).toBe('Found 3 new terms on that page.');
  });

  it('says the same thing once, however many times it retries', async () => {
    const headers = await session(rosa);
    const thread = await openAgentThread(headers);
    const message = {
      thread_id: thread.id,
      type: 'text',
      sender: vocab.email,
      text: 'Working on it.',
      idempotency_key: 'k-retry-once',
    };

    const first = await post(message);
    const again = await post(message);
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);

    const firstBody = await first.json<InternalChannelEventResponse>();
    const againBody = await again.json<InternalChannelEventResponse>();
    expect(againBody.duplicate).toBe(true);
    expect(againBody.message_id).toBe(firstBody.message_id);
    // Counted by text rather than by page length: a Durable Object outlives
    // the D1 rows this file clears, so the conversation still holds whatever
    // the test before it said.
    const said = (await messages(headers, thread.id)).filter((row) => row.text === 'Working on it.');
    expect(said).toHaveLength(1);
  });
});

describe('an event from Core', () => {
  it('lands in a channel as a system line, and never badges it', async () => {
    const headers = await session(rosa);
    await exports.default.fetch(new Request('http://local/api/threads', {
      method: 'POST', headers, body: JSON.stringify({ kind: 'team' }),
    }));

    const response = await post({
      thread_id: 'team',
      type: 'event',
      text: 'closed #142 — Give the end-meeting button its danger colour',
      refs: [{ kind: 'issue', id: 'envisioning/starlings#142' }],
      idempotency_key: 'k-issue-142-closed',
    });
    expect(response.status).toBe(200);

    const rows = await messages(headers, 'team');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'event',
      sender_email: 'meet@org.example',
      refs: [{ kind: 'issue', id: 'envisioning/starlings#142' }],
    });

    // Pinned since 1.4.1: an event never reorders the list or badges anybody.
    const indexed = await env.USAGE.prepare(
      'SELECT last_message_at, last_message_preview FROM threads WHERE id = ?1',
    ).bind('team').first<{ last_message_at: number | null; last_message_preview: string | null }>();
    expect(indexed?.last_message_at).toBeNull();
    expect(indexed?.last_message_preview).toBeNull();
  });
});

describe('waking an agent', () => {
  /** The map the test Worker runs with names Vocab but gives it no endpoint. */
  function withEndpoint(url: string) {
    (env as Env).AGENT_ROSTER = JSON.stringify({
      [vocab.email]: { name: vocab.name, endpoint: url },
    });
  }

  it('hands the message to the agent in the conversation, and to nobody else', async () => {
    const configured = (env as Env).AGENT_ROSTER;
    withEndpoint('https://runtime.example/hook');
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      calls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response('{}', { status: 200 });
    });

    try {
      const headers = await session(rosa);
      const thread = await openAgentThread(headers);
      const sent = await exports.default.fetch(new Request(`http://local/api/threads/${thread.id}/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ text: 'What is on this page?' }),
      }));
      expect(sent.status).toBe(201);

      // The hand-off rides `waitUntil`, so it lands after the response — that
      // is the whole point of it, and the test has to wait the way a runtime
      // would rather than assume it happened synchronously.
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0]?.url).toBe('https://runtime.example/hook');
      expect(calls[0]?.body).toMatchObject({
        kind: 'message',
        agent_email: vocab.email,
        thread_id: thread.id,
        thread_kind: 'dm',
        text: 'What is on this page?',
        sender_email: rosa.email,
        refs: [],
      });
    } finally {
      (env as Env).AGENT_ROSTER = configured;
    }
  });

  it('a Hand off carries what done looks like and what comes back, to the runtime and on the message (meet#284)', async () => {
    const configured = (env as Env).AGENT_ROSTER;
    withEndpoint('https://runtime.example/hook');
    const calls: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', async (_input: RequestInfo, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body ?? '{}')));
      return new Response('{}', { status: 200 });
    });

    try {
      const headers = await session(rosa);
      const thread = await openAgentThread(headers);
      const handoff = { done_when: 'The footer links work on mobile.', deliverable: 'A draft PR' };
      const send = (body: Record<string, unknown>) => exports.default.fetch(new Request(`http://local/api/threads/${thread.id}/messages`, {
        method: 'POST', headers, body: JSON.stringify(body),
      }));

      // A hand-off names its card; one without is refused before anything is said.
      const bare = await send({ text: 'Take this', handoff });
      expect(bare.status).toBe(400);

      const sent = await send({ text: 'Take #7: Fix footer', refs: [{ kind: 'issue', id: 'acme/site#7' }], handoff });
      expect(sent.status).toBe(201);
      const body = await sent.json<{ message: { handoff?: unknown } }>();
      expect(body.message.handoff).toEqual(handoff);

      await vi.waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0]).toMatchObject({ kind: 'message', refs: [{ kind: 'issue', id: 'acme/site#7' }], handoff });
    } finally {
      (env as Env).AGENT_ROSTER = configured;
    }
  });

  it('wakes a project\'s own agent on every line in its channel, with no @mention (MZ, 2026-10-06)', async () => {
    const configured = (env as Env).AGENT_ROSTER;
    const secret = (env as Env).INTERNAL_REQUEST_SECRET;
    (env as Env).INTERNAL_REQUEST_SECRET = 'core-test-secret-with-at-least-32-characters';
    withEndpoint('https://runtime.example/hook');
    await purgeAllCoreCache();
    const project = 'c0ffee00-0000-4000-8000-00000000a6e7';
    const row = { id: project, kind: 'project', title: 'Agent rollout', subtitle: null, agent_email: vocab.email };
    const hooks: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
      if (url.startsWith('https://runtime.example/')) {
        hooks.push(JSON.parse(String(init?.body ?? '{}')));
        return new Response('{}', { status: 200 });
      }
      if (url.includes('meet-crm-subjects')) {
        const query = new URL(url).searchParams;
        if (query.get('id')) return json({ ok: true, subject: row });
        return json({ ok: true, subjects: query.get('kind') === 'project' ? [row] : [], has_more: false });
      }
      return json({ ok: true, tasks: [], interactions: [], issues: [] });
    });

    try {
      const headers = await session(rosa);
      const channel = await openSubjectThread(
        await memberOf(new Request('http://local/api/threads', { method: 'POST', headers })),
        env as Env, 'project', project,
      );
      const sent = await exports.default.fetch(new Request(`http://local/api/threads/${channel.id}/messages`, {
        method: 'POST', headers, body: JSON.stringify({ text: 'The client moved the launch to Friday.' }),
      }));
      expect(sent.status).toBe(201);
      await vi.waitFor(() => expect(hooks).toHaveLength(1));
      expect(hooks[0]).toMatchObject({ kind: 'message', agent_email: vocab.email, thread_id: channel.id, thread_kind: 'project' });
    } finally {
      (env as Env).AGENT_ROSTER = configured;
      (env as Env).INTERNAL_REQUEST_SECRET = secret ?? '';
      await purgeAllCoreCache();
    }
  });

  it('hands reactions on an agent message to that runtime without marking it working', async () => {
    const configured = (env as Env).AGENT_ROSTER;
    withEndpoint('https://runtime.example/hook');
    const calls: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', async (_input: RequestInfo, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body ?? '{}')));
      return new Response('{}', { status: 202 });
    });

    try {
      const headers = await session(rosa);
      const thread = await openAgentThread(headers);
      const answer = await post({
        thread_id: thread.id,
        type: 'text',
        sender: vocab.email,
        text: 'Here is the answer.',
        idempotency_key: 'k-reaction-answer',
      });
      const answerBody = await answer.json<InternalChannelEventResponse>();

      const added = await react(headers, thread.id, answerBody.message_id, '👍');
      expect(added.status).toBe(200);
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0]).toMatchObject({
        kind: 'reaction',
        agent_email: vocab.email,
        thread_id: thread.id,
        message_id: answerBody.message_id,
        emoji: '👍',
        on: true,
        sender_email: rosa.email,
        sender_name: rosa.name,
      });

      const busy = await env.USAGE.prepare('SELECT agent_busy_until FROM people WHERE email = ?1')
        .bind(vocab.email).first<{ agent_busy_until: number | null }>();
      expect(busy?.agent_busy_until ?? null).toBeNull();

      const removed = await react(headers, thread.id, answerBody.message_id, '👍');
      expect(removed.status).toBe(200);
      await vi.waitFor(() => expect(calls).toHaveLength(2));
      expect(calls[1]).toMatchObject({
        kind: 'reaction',
        message_id: answerBody.message_id,
        emoji: '👍',
        on: false,
      });
    } finally {
      (env as Env).AGENT_ROSTER = configured;
    }
  });

  it('carries the card a message was sent from, so the runtime never parses for its ticket', async () => {
    const configured = (env as Env).AGENT_ROSTER;
    withEndpoint('https://runtime.example/hook');
    const calls: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', async (_input: RequestInfo, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body ?? '{}')));
      return new Response('{}', { status: 202 });
    });

    try {
      const headers = await session(rosa);
      const thread = await openAgentThread(headers);
      const sent = await exports.default.fetch(new Request(`http://local/api/threads/${thread.id}/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          text: 'Take this one.',
          refs: [{ kind: 'issue', id: 'envisioning/starlings#142' }],
        }),
      }));
      expect(sent.status).toBe(201);

      await vi.waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0]).toMatchObject({
        kind: 'message',
        refs: [{ kind: 'issue', id: 'envisioning/starlings#142' }],
      });
    } finally {
      (env as Env).AGENT_ROSTER = configured;
    }
  });

  it('tells the agent to stop when a card is taken back, without calling it working', async () => {
    const configured = (env as Env).AGENT_ROSTER;
    withEndpoint('https://runtime.example/hook');
    const calls: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', async (_input: RequestInfo, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body ?? '{}')));
      return new Response('{}', { status: 202 });
    });

    try {
      const headers = await session(rosa);
      const response = await exports.default.fetch(new Request('http://local/api/agents/cancel', {
        method: 'POST',
        headers,
        body: JSON.stringify({ agent_email: vocab.email, ref: { kind: 'issue', id: 'envisioning/starlings#142' } }),
      }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, told: true, delivery: 'accepted' });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        kind: 'cancel',
        agent_email: vocab.email,
        thread_kind: 'dm',
        sender_email: rosa.email,
        refs: [{ kind: 'issue', id: 'envisioning/starlings#142' }],
      });
      const busy = await env.USAGE.prepare('SELECT agent_busy_until FROM people WHERE email = ?1')
        .bind(vocab.email).first<{ agent_busy_until: number | null }>();
      expect(busy?.agent_busy_until ?? null).toBeNull();
    } finally {
      (env as Env).AGENT_ROSTER = configured;
    }
  });

  it('says when there is no runtime to tell', async () => {
    const headers = await session(rosa);
    const response = await exports.default.fetch(new Request('http://local/api/agents/cancel', {
      method: 'POST',
      headers,
      body: JSON.stringify({ agent_email: vocab.email, ref: { kind: 'task', id: 'a0000000-0000-4000-8000-000000000001' } }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, told: false, delivery: 'no_runtime' });
  });

  it('says when the runtime did not take the cancel (meet#189)', async () => {
    const configured = (env as Env).AGENT_ROSTER;
    withEndpoint('https://runtime.example/hook');
    vi.stubGlobal('fetch', async () => { throw new Error('connect timeout'); });
    try {
      const headers = await session(rosa);
      const response = await exports.default.fetch(new Request('http://local/api/agents/cancel', {
        method: 'POST',
        headers,
        body: JSON.stringify({ agent_email: vocab.email, ref: { kind: 'issue', id: 'envisioning/starlings#142' } }),
      }));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, told: false, delivery: 'failed' });
    } finally {
      (env as Env).AGENT_ROSTER = configured;
    }
  });

  it('reads as working once the runtime accepts, and stops when it answers', async () => {
    const configured = (env as Env).AGENT_ROSTER;
    withEndpoint('https://runtime.example/hook');
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 202 }));

    try {
      const headers = await session(rosa);
      const thread = await openAgentThread(headers);
      await exports.default.fetch(new Request(`http://local/api/threads/${thread.id}/messages`, {
        method: 'POST', headers, body: JSON.stringify({ text: 'Read this page for me.' }),
      }));

      await vi.waitFor(async () => {
        const row = await env.USAGE.prepare(
          'SELECT agent_busy_until FROM people WHERE email = ?1',
        ).bind(vocab.email).first<{ agent_busy_until: number | null }>();
        expect(row?.agent_busy_until).toBeGreaterThan(Date.now());
      });

      vi.unstubAllGlobals();
      const answered = await post({
        thread_id: thread.id,
        type: 'text',
        sender: vocab.email,
        text: 'Three new terms.',
        idempotency_key: 'k-done-working',
      });
      expect(answered.status).toBe(200);

      const after = await env.USAGE.prepare(
        'SELECT agent_busy_until FROM people WHERE email = ?1',
      ).bind(vocab.email).first<{ agent_busy_until: number | null }>();
      expect(after?.agent_busy_until).toBeNull();
    } finally {
      (env as Env).AGENT_ROSTER = configured;
    }
  });

  it('does not read as working when the runtime refuses the hand-off', async () => {
    const configured = (env as Env).AGENT_ROSTER;
    withEndpoint('https://runtime.example/hook');
    // A runtime that is down must not read as busy: the only honest thing to
    // say about a hand-off nobody took is nothing.
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 503 }));

    try {
      const headers = await session(rosa);
      const thread = await openAgentThread(headers);
      await exports.default.fetch(new Request(`http://local/api/threads/${thread.id}/messages`, {
        method: 'POST', headers, body: JSON.stringify({ text: 'Anyone home?' }),
      }));
      // Give the deferred hand-off room to have written, had it been going to.
      await vi.waitFor(() => expect(true).toBe(true));
      const row = await env.USAGE.prepare(
        'SELECT agent_busy_until FROM people WHERE email = ?1',
      ).bind(vocab.email).first<{ agent_busy_until: number | null }>();
      expect(row?.agent_busy_until ?? null).toBeNull();
    } finally {
      (env as Env).AGENT_ROSTER = configured;
    }
  });

  it('takes an http endpoint in development and refuses one in production', async () => {
    const configured = (env as Env).AGENT_ROSTER;
    const environment = (env as Env).ENVIRONMENT;
    withEndpoint('http://127.0.0.1:3000/hook');
    let called = 0;
    vi.stubGlobal('fetch', async () => { called += 1; return new Response('{}'); });

    try {
      const headers = await session(rosa);
      const thread = await openAgentThread(headers);
      await exports.default.fetch(new Request(`http://local/api/threads/${thread.id}/messages`, {
        method: 'POST', headers, body: JSON.stringify({ text: 'local runtime' }),
      }));
      await vi.waitFor(() => expect(called).toBe(1));

      // The same map in production reads as name-only: addressable, with
      // nothing listening, rather than a hand-off over cleartext.
      (env as Env).ENVIRONMENT = 'production';
      await exports.default.fetch(new Request(`http://local/api/threads/${thread.id}/messages`, {
        method: 'POST', headers, body: JSON.stringify({ text: 'and again' }),
      }));
      await vi.waitFor(() => expect(true).toBe(true));
      expect(called).toBe(1);
    } finally {
      (env as Env).ENVIRONMENT = environment;
      (env as Env).AGENT_ROSTER = configured;
    }
  });

  it('does not fail the send when the runtime is unreachable', async () => {
    const configured = (env as Env).AGENT_ROSTER;
    withEndpoint('https://runtime.example/hook');
    vi.stubGlobal('fetch', async () => { throw new Error('connection refused'); });

    try {
      const headers = await session(rosa);
      const thread = await openAgentThread(headers);
      const sent = await exports.default.fetch(new Request(`http://local/api/threads/${thread.id}/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ text: 'Still delivered.' }),
      }));
      // The message is in the thread either way. An agent that never woke up
      // is a conversation with no answer in it — which is what an unanswered
      // message looks like anyway.
      expect(sent.status).toBe(201);
    } finally {
      (env as Env).AGENT_ROSTER = configured;
    }
  });

  it('wakes nobody from a channel — that is what mentions are for', async () => {
    const configured = (env as Env).AGENT_ROSTER;
    withEndpoint('https://runtime.example/hook');
    let called = 0;
    vi.stubGlobal('fetch', async () => { called += 1; return new Response('{}'); });

    try {
      const headers = await session(rosa);
      await exports.default.fetch(new Request('http://local/api/threads', {
        method: 'POST', headers, body: JSON.stringify({ kind: 'team' }),
      }));
      await exports.default.fetch(new Request('http://local/api/threads/team/messages', {
        method: 'POST', headers, body: JSON.stringify({ text: 'morning all' }),
      }));
      // Nobody is a member of a channel, so nothing in one is addressed at an
      // agent. Waking every agent on every line is the failure this prevents.
      expect(called).toBe(0);
    } finally {
      (env as Env).AGENT_ROSTER = configured;
    }
  });
});

// MARK: - Step 3 of docs/BOARD.md: subject addressing, agent events, moves

describe('an agent narrating', () => {
  const projectId = 'c0ffee00-0000-4000-8000-00000000c0de';
  const CORE_SECRET = 'core-test-secret-with-at-least-32-characters';

  /** The bridge on, and Core answering from a script rather than the network. */
  function withCore(
    answer: (url: string, init?: RequestInit) => Response | Promise<Response>,
  ): () => void {
    const configured = (env as Env).INTERNAL_REQUEST_SECRET;
    (env as Env).INTERNAL_REQUEST_SECRET = CORE_SECRET;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      return answer(url, init);
    });
    return () => { (env as Env).INTERNAL_REQUEST_SECRET = configured ?? ''; };
  }

  const subjectAnswer = () => new Response(JSON.stringify({
    ok: true,
    subject: { id: projectId, kind: 'project', title: 'Acme rollout', subtitle: 'Acme' },
  }), { headers: { 'content-type': 'application/json' } });

  it('may sign an event, which stays quiet and leaves it working', async () => {
    const headers = await session(rosa);
    const thread = await openAgentThread(headers);
    await env.USAGE.prepare("UPDATE people SET agent_busy_until = ?2 WHERE email = ?1 AND kind = 'agent'")
      .bind(vocab.email, Date.now() + 600_000).run();

    const response = await post({
      thread_id: thread.id,
      type: 'event',
      sender: vocab.email,
      text: 'Vocab started reading the page',
      idempotency_key: 'k-agent-event-1',
    });
    expect(response.status).toBe(200);
    const body = await response.json<InternalChannelEventResponse>();

    // The DM's Durable Object outlives the D1 clean-up between tests, so the
    // line is found by id rather than counted.
    const rows = await messages(headers, thread.id);
    expect(rows.find((row) => row.id === body.message_id)).toMatchObject({ type: 'event', sender_email: vocab.email });

    // An event is said mid-run: it neither badges the list nor ends the turn.
    const indexed = await env.USAGE.prepare('SELECT last_message_at FROM threads WHERE id = ?1')
      .bind(thread.id).first<{ last_message_at: number | null }>();
    expect(indexed?.last_message_at).toBeNull();
    const busy = await env.USAGE.prepare('SELECT agent_busy_until FROM people WHERE email = ?1')
      .bind(vocab.email).first<{ agent_busy_until: number | null }>();
    expect(busy?.agent_busy_until).not.toBeNull();
  });

  it('streams an answer as one row rewritten in place, and only the final post ends the turn', async () => {
    const headers = await session(rosa);
    const thread = await openAgentThread(headers);
    await env.USAGE.prepare("UPDATE people SET agent_busy_until = ?2 WHERE email = ?1 AND kind = 'agent'")
      .bind(vocab.email, Date.now() + 600_000).run();
    const key = 'k-agent-stream-1';

    const first = await post({ thread_id: thread.id, type: 'text', sender: vocab.email, text: 'Three', idempotency_key: key, partial: true });
    expect(first.status).toBe(200);
    const firstBody = await first.json<InternalChannelEventResponse>();
    expect(firstBody.duplicate).toBe(false);
    let row = (await messages(headers, thread.id)).find((line) => line.id === firstBody.message_id);
    expect(row).toMatchObject({ text: 'Three', partial: true });

    // The second post is the same row, longer — never a second row, never a duplicate.
    const second = await post({ thread_id: thread.id, type: 'text', sender: vocab.email, text: 'Three terms are', idempotency_key: key, partial: true });
    const secondBody = await second.json<InternalChannelEventResponse>();
    expect(secondBody).toMatchObject({ message_id: firstBody.message_id, duplicate: false });
    row = (await messages(headers, thread.id)).find((line) => line.id === firstBody.message_id);
    expect(row).toMatchObject({ text: 'Three terms are', partial: true });
    // Still working: a partial is not an answer.
    let busy = await env.USAGE.prepare('SELECT agent_busy_until FROM people WHERE email = ?1')
      .bind(vocab.email).first<{ agent_busy_until: number | null }>();
    expect(busy?.agent_busy_until).not.toBeNull();

    const final = await post({ thread_id: thread.id, type: 'text', sender: vocab.email, text: 'Three terms are new.', idempotency_key: key });
    expect((await final.json<InternalChannelEventResponse>()).duplicate).toBe(false);
    row = (await messages(headers, thread.id)).find((line) => line.id === firstBody.message_id);
    expect(row).toMatchObject({ text: 'Three terms are new.' });
    expect(row?.partial).toBeUndefined();
    busy = await env.USAGE.prepare('SELECT agent_busy_until FROM people WHERE email = ?1')
      .bind(vocab.email).first<{ agent_busy_until: number | null }>();
    expect(busy?.agent_busy_until ?? null).toBeNull();

    // A partial that lands after the final — a retry, a slow hop — changes nothing.
    const late = await post({ thread_id: thread.id, type: 'text', sender: vocab.email, text: 'Three terms', idempotency_key: key, partial: true });
    expect((await late.json<InternalChannelEventResponse>()).duplicate).toBe(true);
    row = (await messages(headers, thread.id)).find((line) => line.id === firstBody.message_id);
    expect(row).toMatchObject({ text: 'Three terms are new.' });
  });

  it('lets the final post retype a streamed preamble as a trail line', async () => {
    const headers = await session(rosa);
    const thread = await openAgentThread(headers);
    await env.USAGE.prepare("UPDATE people SET agent_busy_until = ?2 WHERE email = ?1 AND kind = 'agent'")
      .bind(vocab.email, Date.now() + 600_000).run();
    const key = 'k-agent-stream-preamble';

    await post({ thread_id: thread.id, type: 'text', sender: vocab.email, text: 'Let me check the', idempotency_key: key, partial: true });
    const final = await post({ thread_id: thread.id, type: 'event', sender: vocab.email, text: 'Let me check the board.', idempotency_key: key });
    const finalBody = await final.json<InternalChannelEventResponse>();
    expect(finalBody.duplicate).toBe(false);
    const row = (await messages(headers, thread.id)).find((line) => line.id === finalBody.message_id);
    expect(row).toMatchObject({ type: 'event', text: 'Let me check the board.' });
    expect(row?.partial).toBeUndefined();
    // A step is not an answer.
    const busy = await env.USAGE.prepare('SELECT agent_busy_until FROM people WHERE email = ?1')
      .bind(vocab.email).first<{ agent_busy_until: number | null }>();
    expect(busy?.agent_busy_until).not.toBeNull();
  });

  it('refuses a partial that is not an agent’s text', async () => {
    const event = await post({ thread_id: 'team', type: 'event', text: 'x', idempotency_key: 'k-partial-event', partial: true });
    expect(event.status).toBe(400);
  });

  it('refuses a line addressed to both a thread and a subject, and an answer addressed to a subject', async () => {
    const both = await post({
      thread_id: 'team', subject: { kind: 'project', id: projectId }, type: 'event',
      text: 'x', idempotency_key: 'k-both-addresses',
    });
    expect(both.status).toBe(400);
    const answer = await post({
      subject: { kind: 'project', id: projectId }, type: 'text', sender: vocab.email,
      text: 'x', idempotency_key: 'k-answer-to-subject',
    });
    expect(answer.status).toBe(400);
  });

  it('lands an event on a subject Meet resolves, creating the channel on the way', async () => {
    const restore = withCore(subjectAnswer);
    try {
      const response = await post({
        subject: { kind: 'project', id: projectId },
        type: 'event',
        sender: vocab.email,
        text: 'Vocab opened #7 for this',
        refs: [{ kind: 'issue', id: 'acme/site#7' }],
        idempotency_key: 'k-subject-event-1',
      });
      expect(response.status).toBe(200);
      const body = await response.json<InternalChannelEventResponse>();
      expect(body.thread_id.startsWith('prj_')).toBe(true);

      const headers = await session(rosa);
      const rows = await messages(headers, body.thread_id);
      expect(rows.find((row) => row.id === body.message_id)).toMatchObject({ type: 'event', text: 'Vocab opened #7 for this' });

      // The card's face knows what last happened to it.
      const trace = await env.USAGE.prepare('SELECT thread_id, message_id, text FROM card_trace WHERE ref_kind = ?1 AND ref_id = ?2')
        .bind('issue', 'acme/site#7').first<{ thread_id: string; message_id: string; text: string }>();
      expect(trace).toMatchObject({ thread_id: body.thread_id, message_id: body.message_id, text: 'Vocab opened #7 for this' });
    } finally {
      restore();
      await env.USAGE.prepare('DELETE FROM card_trace').run();
    }
  });

  it('lands an event on a partner, the organization of a support case (meet#608)', async () => {
    const partnerId = 'c0ffee00-0000-4000-8000-00000000fa11';
    const restore = withCore(() => new Response(JSON.stringify({
      ok: true,
      subject: { id: partnerId, kind: 'partner', title: 'Acme Partners', subtitle: null },
    }), { headers: { 'content-type': 'application/json' } }));
    try {
      const response = await post({
        subject: { kind: 'partner', id: partnerId },
        type: 'event',
        text: 'New support case SC-1: Pilot access',
        idempotency_key: 'crm:support-case:partner-1:created',
      });
      expect(response.status).toBe(200);
      const body = await response.json<InternalChannelEventResponse>();
      const headers = await session(rosa);
      expect((await messages(headers, body.thread_id)).find((row) => row.id === body.message_id))
        .toMatchObject({ type: 'event', text: 'New support case SC-1: Pilot access' });
      const thread = await env.USAGE.prepare('SELECT kind, parent_id FROM threads WHERE id = ?1')
        .bind(body.thread_id).first<{ kind: string; parent_id: string }>();
      expect(thread).toEqual({ kind: 'organization', parent_id: partnerId });
    } finally {
      restore();
    }
  });

  it('counts a subject-addressed event as new when it is the channel’s first ever message', async () => {
    // No `sender`: this is the shape Core’s own dispatcher uses for a CRM
    // event (envisioning/starlings#43) — the work graph reporting itself, not an
    // agent narrating. A lead born purely from `lead.created` has nobody to
    // reply yet, so this first line has to count as new or nothing ever will.
    const freshProjectId = 'c0ffee00-0000-4000-8000-00000000fee5';
    const restore = withCore(() => new Response(JSON.stringify({
      ok: true,
      subject: { id: freshProjectId, kind: 'project', title: 'Fresh rollout', subtitle: null },
    }), { headers: { 'content-type': 'application/json' } }));
    try {
      const response = await post({
        subject: { kind: 'project', id: freshProjectId },
        type: 'event',
        text: 'New lead: Acme inbound',
        idempotency_key: 'k-subject-first-event',
      });
      expect(response.status).toBe(200);
      const body = await response.json<InternalChannelEventResponse>();

      const indexed = await env.USAGE.prepare(
        'SELECT last_message_at, last_message_preview FROM threads WHERE id = ?1',
      ).bind(body.thread_id).first<{ last_message_at: number | null; last_message_preview: string | null }>();
      expect(indexed?.last_message_at).not.toBeNull();
      expect(indexed?.last_message_preview).toBe('New lead: Acme inbound');

      // A second event on the same, now-existing, channel goes back to the
      // ordinary rule: never unread, never reorders — the moment the channel
      // has any history, the per-member `last_read_at` mechanism is the whole
      // story, exactly as docs/CHANNELS.md pins it.
      const secondResponse = await post({
        subject: { kind: 'project', id: freshProjectId },
        type: 'event',
        text: 'Notes filed: Kickoff',
        idempotency_key: 'k-subject-second-event',
      });
      expect(secondResponse.status).toBe(200);
      const reread = await env.USAGE.prepare(
        'SELECT last_message_preview FROM threads WHERE id = ?1',
      ).bind(body.thread_id).first<{ last_message_preview: string | null }>();
      expect(reread?.last_message_preview).toBe('New lead: Acme inbound');
    } finally {
      restore();
    }
  });

  it('still counts the first event as new for a channel opened but never spoken in', async () => {
    // The common case the old `created`-from-`ensureThread` proxy read
    // backwards: somebody opens the Talk tab on a brand-new project (Mac/iOS/
    // `WorkPage.tsx` all do this just by viewing a subject), which makes the
    // channel row and the Durable Object exist with zero messages — that is
    // not "already has messages", but the old proxy said it was.
    const openedButQuietId = 'c0ffee00-0000-4000-8000-00000000fee6';
    const restore = withCore(() => new Response(JSON.stringify({
      ok: true,
      subject: { id: openedButQuietId, kind: 'project', title: 'Opened rollout', subtitle: null },
    }), { headers: { 'content-type': 'application/json' } }));
    try {
      const headers = await session(rosa);
      const opened = await openSubjectThread(
        await memberOf(new Request('http://local/api/threads', { method: 'POST', headers })),
        env as Env,
        'project',
        openedButQuietId,
      );

      const beforeEvent = await env.USAGE.prepare(
        'SELECT last_message_at FROM threads WHERE id = ?1',
      ).bind(opened.id).first<{ last_message_at: number | null }>();
      expect(beforeEvent?.last_message_at).toBeNull();

      const response = await post({
        subject: { kind: 'project', id: openedButQuietId },
        type: 'event',
        text: 'New lead: Acme inbound',
        idempotency_key: 'k-subject-opened-first-event',
      });
      expect(response.status).toBe(200);
      const body = await response.json<InternalChannelEventResponse>();
      expect(body.thread_id).toBe(opened.id);

      const afterEvent = await env.USAGE.prepare(
        'SELECT last_message_at, last_message_preview FROM threads WHERE id = ?1',
      ).bind(opened.id).first<{ last_message_at: number | null; last_message_preview: string | null }>();
      expect(afterEvent?.last_message_at).not.toBeNull();
      expect(afterEvent?.last_message_preview).toBe('New lead: Acme inbound');
    } finally {
      restore();
    }
  });

  it('marks a retried first event unread exactly once, not zero times', async () => {
    // As if the first attempt's response never reached the caller: the same
    // request, same idempotency key, sent again.
    const retriedId = 'c0ffee00-0000-4000-8000-00000000fee7';
    const restore = withCore(() => new Response(JSON.stringify({
      ok: true,
      subject: { id: retriedId, kind: 'project', title: 'Retried rollout', subtitle: null },
    }), { headers: { 'content-type': 'application/json' } }));
    try {
      const body = {
        subject: { kind: 'project', id: retriedId },
        type: 'event' as const,
        text: 'New lead: Acme inbound',
        idempotency_key: 'k-subject-first-event-retried',
      };

      const first = await post(body);
      expect(first.status).toBe(200);
      const firstBody = await first.json<InternalChannelEventResponse>();
      expect(firstBody.duplicate).toBe(false);

      const second = await post(body);
      expect(second.status).toBe(200);
      const secondBody = await second.json<InternalChannelEventResponse>();
      expect(secondBody.duplicate).toBe(true);
      expect(secondBody.message_id).toBe(firstBody.message_id);
      expect(secondBody.thread_id).toBe(firstBody.thread_id);

      const indexed = await env.USAGE.prepare(
        'SELECT last_message_at, last_message_preview FROM threads WHERE id = ?1',
      ).bind(firstBody.thread_id).first<{ last_message_at: number | null; last_message_preview: string | null }>();
      expect(indexed?.last_message_at).not.toBeNull();
      expect(indexed?.last_message_preview).toBe('New lead: Acme inbound');

      // Retried, not repeated: exactly one line landed in the channel.
      const headers = await session(rosa);
      const rows = await messages(headers, firstBody.thread_id);
      expect(rows.filter((row) => row.text === 'New lead: Acme inbound')).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it('answers 404 for a subject Core does not have', async () => {
    const restore = withCore(() => new Response(JSON.stringify({ ok: true, subjects: [] }), {
      headers: { 'content-type': 'application/json' },
    }));
    try {
      const response = await post({
        subject: { kind: 'project', id: projectId }, type: 'event', text: 'x', idempotency_key: 'k-no-such-subject',
      });
      expect(response.status).toBe(404);
    } finally {
      restore();
    }
  });
});

describe('an agent moving a card', () => {
  const projectId = 'c0ffee00-0000-4000-8000-00000000c0de';
  // A Durable Object's storage survives between tests where D1 does not, so a
  // second channel keeps the two reporting tests from sharing a transcript.
  const secondProjectId = 'c0ffee00-0000-4000-8000-00000000c0df';
  const taskId = 'a0000000-0000-4000-8000-000000000001';
  const CORE_SECRET = 'core-test-secret-with-at-least-32-characters';

  interface CoreCall { method: string; url: string; body: Record<string, unknown> | null }

  /** Core scripted: the subject, one task PATCH, one issue read, one issue PATCH. */
  function withCore(issue: { state: string; state_reason: string | null; labels: string[] } = { state: 'open', state_reason: null, labels: ['bug', 'agent:building'] }) {
    const configured = (env as Env).INTERNAL_REQUEST_SECRET;
    (env as Env).INTERNAL_REQUEST_SECRET = CORE_SECRET;
    const calls: CoreCall[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? 'GET';
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null });
      const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
      if (url.includes('meet-crm-subjects')) {
        // Echo whichever subject was asked for: these cases use more than one,
        // so a fixed id would 404 every project but the first.
        const asked = new URL(url).searchParams.get('id') ?? projectId;
        return json({ ok: true, subject: { id: asked, kind: 'project', title: 'Acme rollout', subtitle: null } });
      }
      if (url.includes('meet-crm-tasks/')) return json({ ok: true, task: coreTask({ id: taskId, status: 'in_progress' }) });
      if (url.includes('meet-project-repos')) {
        return json({ repos: [{ id: 'link-1', owner: 'envisioning', repo: 'starlings', label: null, milestone: null, is_primary: true }] });
      }
      if (url.includes('meet-github-issues') && method === 'GET') return json({ ok: true, issue: coreIssueDetail(issue) });
      if (url.includes('meet-github-issues') && method === 'PATCH') {
        return json({ ok: true, issue: coreIssueDetail({ ...issue, title: 'Fix the thing' }) });
      }
      return new Response('{}', { status: 404 });
    });
    return {
      calls,
      restore: () => { (env as Env).INTERNAL_REQUEST_SECRET = configured ?? ''; },
    };
  }

  /** A person asks the agent, from a card. Returns what the runtime would have been handed. */
  async function ask(headers: Record<string, string>, threadId: string, text: string) {
    const response = await exports.default.fetch(new Request(`http://local/api/threads/${threadId}/messages`, {
      method: 'POST', headers, body: JSON.stringify({ text }),
    }));
    return (await response.json<{ message: { id: string } }>()).message.id;
  }

  afterEach(async () => {
    await env.USAGE.prepare('DELETE FROM card_trace').run();
  });

  it('moves a task as the person who asked, then reports it on the subject with the card attached', async () => {
    const core = withCore();
    try {
      const headers = await session(rosa);
      const dm = await openAgentThread(headers);
      const askedId = await ask(headers, dm.id, 'Start on this.');

      const response = await post({
        subject: { kind: 'project', id: projectId },
        type: 'event',
        sender: vocab.email,
        text: 'Vocab moved the task to Doing',
        move: { ref: { kind: 'task', id: taskId }, stage: 'doing' },
        in_reply_to: { thread_id: dm.id, message_id: askedId },
        idempotency_key: 'k-move-task-1',
      });
      expect(response.status).toBe(200);
      const body = await response.json<InternalChannelEventResponse>();

      const patch = core.calls.find((call) => call.method === 'PATCH' && call.url.includes(`meet-crm-tasks/${taskId}`));
      // The person who asked is the actor Core records (core#196).
      expect(patch?.body).toEqual({ status: 'in_progress', actor_email: rosa.email });

      const rows = await messages(headers, body.thread_id);
      expect(rows.find((row) => row.id === body.message_id)).toMatchObject({
        type: 'event',
        sender_email: vocab.email,
        refs: [{ kind: 'task', id: taskId }],
      });
      const trace = await env.USAGE.prepare('SELECT message_id FROM card_trace WHERE ref_kind = ?1 AND ref_id = ?2')
        .bind('task', taskId).first<{ message_id: string }>();
      expect(trace?.message_id).toBe(body.message_id);
    } finally {
      core.restore();
    }
  });

  it('moves an issue with the whole label set, and Core is told who asked', async () => {
    const core = withCore({ state: 'open', state_reason: null, labels: ['bug', 'agent:building', 'p1'] });
    try {
      const headers = await session(rosa);
      const dm = await openAgentThread(headers);
      const askedId = await ask(headers, dm.id, 'Take #142.');

      const response = await post({
        thread_id: dm.id,
        type: 'event',
        sender: vocab.email,
        text: 'Vocab moved #142 to Review',
        move: { ref: { kind: 'issue', id: 'envisioning/starlings#142' }, stage: 'review' },
        in_reply_to: { thread_id: dm.id, message_id: askedId },
        idempotency_key: 'k-move-issue-1',
      });
      expect(response.status).toBe(200);

      const patch = core.calls.find((call) => call.method === 'PATCH' && call.url.includes('meet-github-issues'));
      expect(patch?.body).toEqual({
        owner: 'envisioning',
        repo: 'starlings',
        number: 142,
        state: 'open',
        labels: ['bug', 'p1', 'agent:review'],
        actor: rosa.email,
      });
    } finally {
      core.restore();
    }
  });

  it('does not move the card twice when the runtime retries', async () => {
    const core = withCore();
    try {
      const headers = await session(rosa);
      const dm = await openAgentThread(headers);
      const askedId = await ask(headers, dm.id, 'Start on this.');
      const line = {
        thread_id: dm.id,
        type: 'event',
        sender: vocab.email,
        text: 'Vocab moved the task to Doing',
        move: { ref: { kind: 'task', id: taskId }, stage: 'doing' },
        in_reply_to: { thread_id: dm.id, message_id: askedId },
        idempotency_key: 'k-move-retry',
      };
      expect((await post(line)).status).toBe(200);
      const again = await post(line);
      expect(again.status).toBe(200);
      expect((await again.json<InternalChannelEventResponse>()).duplicate).toBe(true);

      const patches = core.calls.filter((call) => call.method === 'PATCH');
      expect(patches).toHaveLength(1);
    } finally {
      core.restore();
    }
  });

  it('refuses a move that answers nobody, an agent, or an event', async () => {
    const core = withCore();
    try {
      const headers = await session(rosa);
      const dm = await openAgentThread(headers);

      const unanswered = await post({
        thread_id: dm.id, type: 'event', sender: vocab.email, text: 'x',
        move: { ref: { kind: 'task', id: taskId }, stage: 'doing' },
        idempotency_key: 'k-move-no-reply',
      });
      expect(unanswered.status).toBe(400);

      const missing = await post({
        thread_id: dm.id, type: 'event', sender: vocab.email, text: 'x',
        move: { ref: { kind: 'task', id: taskId }, stage: 'doing' },
        in_reply_to: { thread_id: dm.id, message_id: 'msg_nobody_sent_this' },
        idempotency_key: 'k-move-missing',
      });
      expect(missing.status).toBe(404);

      // The agent's own answer is not a person asking.
      const own = await post({
        thread_id: dm.id, type: 'text', sender: vocab.email, text: 'Done.', idempotency_key: 'k-own-answer',
      });
      const ownId = (await own.json<InternalChannelEventResponse>()).message_id;
      const self = await post({
        thread_id: dm.id, type: 'event', sender: vocab.email, text: 'x',
        move: { ref: { kind: 'task', id: taskId }, stage: 'doing' },
        in_reply_to: { thread_id: dm.id, message_id: ownId },
        idempotency_key: 'k-move-self',
      });
      expect(self.status).toBe(403);

      expect(core.calls.filter((call) => call.method === 'PATCH')).toHaveLength(0);
    } finally {
      core.restore();
    }
  });

  it('refuses an agent’s move to Done or Dropped, and writes nothing', async () => {
    // Delivery is not acceptance (docs/OWNERSHIP.md decision 13): the agent
    // stops at Review, and a person accepts the card.
    const core = withCore();
    try {
      const headers = await session(rosa);
      const dm = await openAgentThread(headers);
      const askedId = await ask(headers, dm.id, 'Fix #142.');
      const before = (await messages(headers, dm.id)).length;

      for (const stage of ['done', 'dropped'] as const) {
        const refused = await post({
          thread_id: dm.id, type: 'event', sender: vocab.email, text: `Vocab moved #142 to ${stage}`,
          move: { ref: { kind: 'issue', id: 'envisioning/starlings#142' }, stage },
          in_reply_to: { thread_id: dm.id, message_id: askedId },
          idempotency_key: `k-move-refused-${stage}`,
        });
        expect(refused.status).toBe(403);
      }
      expect(core.calls.filter((call) => call.method === 'PATCH')).toHaveLength(0);
      expect((await messages(headers, dm.id)).length).toBe(before);

      // Review is where it goes instead.
      const review = await post({
        thread_id: dm.id, type: 'event', sender: vocab.email, text: 'Vocab moved #142 to Review',
        move: { ref: { kind: 'issue', id: 'envisioning/starlings#142' }, stage: 'review' },
        in_reply_to: { thread_id: dm.id, message_id: askedId },
        idempotency_key: 'k-move-refused-then-review',
      });
      expect(review.status).toBe(200);
      // The person who asked holds the card: their INBOX shows it in Review.
      const hold = await env.USAGE.prepare("SELECT holder_email, agent_email FROM card_holds WHERE ref_kind = 'issue' AND ref_id = 'envisioning/starlings#142'")
        .first<{ holder_email: string; agent_email: string }>();
      expect(hold).toEqual({ holder_email: rosa.email.toLowerCase(), agent_email: vocab.email.toLowerCase() });
    } finally {
      core.restore();
    }
  });

  it('tells the project’s channel when it reopens an issue from a DM', async () => {
    // Several serialized Core/DO calls can exceed 30s in a cold background pool.
    // The case this exists for: a runtime answers a hand-off in a DM, so its
    // own line lands there — and without this the project whose issue it just
    // reopened would never hear about it at all.
    const core = withCore({ state: 'closed', state_reason: 'completed', labels: ['bug'] });
    try {
      const headers = await session(rosa);
      const dm = await openAgentThread(headers);
      const askedId = await ask(headers, dm.id, 'Look at #142 again.');

      const response = await post({
        thread_id: dm.id,
        subject: { kind: 'project', id: projectId },
        type: 'event',
        sender: vocab.email,
        text: 'Vocab is back on #142',
        move: { ref: { kind: 'issue', id: 'envisioning/starlings#142' }, stage: 'review' },
        in_reply_to: { thread_id: dm.id, message_id: askedId },
        idempotency_key: 'k-move-issue-dm',
      });
      expect(response.status).toBe(200);
      const body = await response.json<InternalChannelEventResponse>();
      // The agent's own words went to the DM it was asked in.
      expect(body.thread_id).toBe(dm.id);

      const channel = await openSubjectThread(
        await memberOf(new Request('http://local/api/threads', { method: 'POST', headers })),
        env as Env, 'project', projectId,
      );
      // Contains rather than equals: a Durable Object's storage outlives D1's
      // reset, so this channel still carries what earlier cases said in it.
      const rows = await messages(headers, channel.id);
      const reported = rows.find((row) => row.text === 'Vocab reopened #142 · Fix the thing');
      expect(reported).toMatchObject({
        type: 'event',
        sender_email: 'meet@org.example',
        refs: [{ kind: 'issue', id: 'envisioning/starlings#142' }],
      });
    } finally {
      core.restore();
    }
  }, 60_000);

  it('does not say it twice when the agent was already talking in that channel', async () => {
    const core = withCore({ state: 'closed', state_reason: 'completed', labels: ['bug'] });
    try {
      const headers = await session(rosa);
      const dm = await openAgentThread(headers);
      const askedId = await ask(headers, dm.id, 'Look at #9 again.');

      const response = await post({
        subject: { kind: 'project', id: secondProjectId },
        type: 'event',
        sender: vocab.email,
        text: 'Vocab is back on #9',
        move: { ref: { kind: 'issue', id: 'envisioning/starlings#9' }, stage: 'review' },
        in_reply_to: { thread_id: dm.id, message_id: askedId },
        idempotency_key: 'k-move-issue-channel',
      });
      expect(response.status).toBe(200);
      const body = await response.json<InternalChannelEventResponse>();

      // The agent's own line, and no system line beside it: the channel has
      // already been told, in the agent's own words.
      const rows = await messages(headers, body.thread_id);
      expect(rows.map((row) => row.text)).toContain('Vocab is back on #9');
      expect(rows.some((row) => row.text.startsWith('Vocab reopened #9'))).toBe(false);
    } finally {
      core.restore();
    }
  });

  it('moves nothing while the bridge is off', async () => {
    const headers = await session(rosa);
    const dm = await openAgentThread(headers);
    const askedId = await ask(headers, dm.id, 'Start on this.');
    const before = (await messages(headers, dm.id)).length;
    const withoutCore = (env as Env).INTERNAL_REQUEST_SECRET;
    (env as Env).INTERNAL_REQUEST_SECRET = '';
    try {
      const response = await post({
        thread_id: dm.id, type: 'event', sender: vocab.email, text: 'x',
        move: { ref: { kind: 'task', id: taskId }, stage: 'doing' },
        in_reply_to: { thread_id: dm.id, message_id: askedId },
        idempotency_key: 'k-move-bridge-off',
      });
      expect(response.status).toBe(503);
      // The move failed, so the line reporting it was never written.
      expect((await messages(headers, dm.id)).length).toBe(before);
    } finally {
      (env as Env).INTERNAL_REQUEST_SECRET = withoutCore ?? '';
    }
  });
});
