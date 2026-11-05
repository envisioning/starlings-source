// The watchdog: agent_handoffs (migration 0029) and resetStuckAgents.
// See docs/AGENTS_SURFACE.md and the doc comments on resetStuckAgents.
import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminAgentActivityResponse, SentMessageResponse, ThreadSummary } from '@starlings/contracts';
import { agentSub } from '@starlings/contracts';
import {
  clearWorking,
  ensureAgentPeople,
  notifyThreadAgents,
  recordAgentActivity,
  resetStuckAgents,
} from '../src/agents';
import { recordOwnerSignIn } from '../src/usage';
import { resetRoleCache } from '../src/capabilities';

const vocabEmail = 'agent-vocab@example.com';
const vocabSub = agentSub(vocabEmail);
const rosa = { sub: 'ag-rosa', email: 'ag-rosa@example.com', name: 'Rosa' };

async function seedThreadMember(threadId: string, memberSub: string, memberEmail: string) {
  const usage = (env as Env).USAGE;
  await usage.prepare(
    "INSERT INTO threads (id, kind, created_at) VALUES (?1, 'dm', ?2) ON CONFLICT(id) DO NOTHING",
  ).bind(threadId, Date.now()).run();
  await usage.prepare(
    'INSERT INTO thread_members (thread_id, member_sub, member_email) VALUES (?1, ?2, ?3) ON CONFLICT(thread_id, member_sub) DO NOTHING',
  ).bind(threadId, memberSub, memberEmail).run();
}

/**
 * A real DM, D1 index and Durable Object membership both — unlike
 * `seedThreadMember`, which only satisfies `notifyThreadAgents`'s D1 join and
 * is not enough for `appendInboundMessage`'s actual write through the DO.
 */
async function openRealDmWithVocab(): Promise<string> {
  return (await openRealDmWithVocabAs()).threadId;
}

async function openRealDmWithVocabAs(): Promise<{ threadId: string; headers: Record<string, string> }> {
  const session = await exports.default.fetch(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: rosa.name, email: rosa.email }),
  }));
  const { access_token } = await session.json<{ access_token: string }>();
  // Dev sessions mint their own `dev:` subject — see test/threads.test.ts's
  // `member()` helper, which does the same thing for the same reason.
  await recordOwnerSignIn(env as Env, { sub: `dev:${rosa.email}`, email: rosa.email, name: rosa.name }, 'mac');
  const headers = { authorization: `Bearer ${access_token}`, 'content-type': 'application/json' };
  const response = await exports.default.fetch(new Request('http://local/api/threads', {
    method: 'POST',
    headers,
    body: JSON.stringify({ peer_email: vocabEmail }),
  }));
  const { thread } = await response.json<{ thread: ThreadSummary }>();
  return { threadId: thread.id, headers };
}

async function sendAsMz(headers: Record<string, string>, threadId: string, text: string): Promise<string> {
  const response = await exports.default.fetch(new Request(`http://local/api/threads/${threadId}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ text }),
  }));
  return (await response.json<SentMessageResponse>()).message.id;
}

/** The hand-off row made stale, as if the run had hung for twenty minutes. */
async function makeStale(threadId: string, now: number) {
  await (env as Env).USAGE.prepare('UPDATE agent_handoffs SET accepted_at = ?3 WHERE agent_sub = ?1 AND thread_id = ?2')
    .bind(vocabSub, threadId, now - 20 * 60_000).run();
}

async function pendingRow(threadId: string) {
  return (env as Env).USAGE.prepare(
    'SELECT accepted_at, replied_at, reset_at FROM agent_handoffs WHERE agent_sub = ?1 AND thread_id = ?2',
  ).bind(vocabSub, threadId).first<{ accepted_at: number; replied_at: number | null; reset_at: number | null }>();
}

describe('agent hand-off watchdog', () => {
  const configured = (env as Env).AGENT_ROSTER;

  beforeEach(async () => {
    await recordOwnerSignIn(env as Env, rosa, 'mac');
    await (env as Env).USAGE.prepare('DELETE FROM agent_handoffs').run();
  });

  afterEach(() => {
    (env as Env).AGENT_ROSTER = configured;
    vi.unstubAllGlobals();
  });

  it('records a per-thread pending row when a hand-off is accepted, and clears only that thread on reply', async () => {
    (env as Env).AGENT_ROSTER = JSON.stringify({
      [vocabEmail]: { name: 'Vocab', endpoint: 'https://vocab.example.com/meet/handoff' },
    });
    await ensureAgentPeople(env as Env, Date.now());
    await seedThreadMember('thread-a', vocabSub, vocabEmail);
    await seedThreadMember('thread-b', vocabSub, vocabEmail);

    vi.stubGlobal('fetch', async () => new Response(null, { status: 202 }));

    for (const threadId of ['thread-a', 'thread-b']) {
      await notifyThreadAgents(env as Env, {
        threadId,
        threadKind: 'dm',
        messageId: `m-${threadId}`,
        text: 'hello',
        sentAt: Date.now(),
        sender: { email: rosa.email, name: rosa.name },
      });
    }

    const a = await pendingRow('thread-a');
    const b = await pendingRow('thread-b');
    expect(a?.accepted_at).toBeGreaterThan(0);
    expect(a?.replied_at).toBeNull();
    expect(b?.accepted_at).toBeGreaterThan(0);
    expect(b?.replied_at).toBeNull();

    const events = await (env as Env).USAGE.prepare(
      'SELECT kind, source_message_id FROM agent_activity_events ORDER BY source_message_id, kind',
    ).all<{ kind: string; source_message_id: string }>();
    expect(events.results).toEqual([
      { kind: 'accepted', source_message_id: 'm-thread-a' },
      { kind: 'handoff', source_message_id: 'm-thread-a' },
      { kind: 'accepted', source_message_id: 'm-thread-b' },
      { kind: 'handoff', source_message_id: 'm-thread-b' },
    ]);

    // Retried delivery uses the same event keys, so it cannot inflate the history.
    await notifyThreadAgents(env as Env, {
      threadId: 'thread-a',
      threadKind: 'dm',
      messageId: 'm-thread-a',
      text: 'hello',
      sentAt: Date.now(),
      sender: { email: rosa.email, name: rosa.name },
    });
    const eventCount = await (env as Env).USAGE.prepare(
      'SELECT COUNT(*) AS count FROM agent_activity_events',
    ).first<{ count: number }>();
    expect(eventCount?.count).toBe(4);

    // Answering thread-a must not clear the still-pending thread-b.
    await clearWorking(env as Env, vocabSub, 'thread-a');
    const aAfter = await pendingRow('thread-a');
    const bAfter = await pendingRow('thread-b');
    expect(aAfter?.replied_at).not.toBeNull();
    expect(bAfter?.replied_at).toBeNull();
  });

  it('wakes an agent in a channel only when mentioned, and records who addressed it', async () => {
    (env as Env).AGENT_ROSTER = JSON.stringify({
      [vocabEmail]: { name: 'Vocab', endpoint: 'https://vocab.example.com/meet/handoff' },
    });
    await ensureAgentPeople(env as Env, Date.now());
    await (env as Env).USAGE.prepare('DELETE FROM agent_addressers WHERE agent_sub = ?1').bind(vocabSub).run();
    const delivered: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      delivered.push((JSON.parse(String(init?.body)) as { thread_id: string }).thread_id);
      return new Response(null, { status: 202 });
    });

    // A channel: no members, so a plain line wakes nobody.
    await (env as Env).USAGE.prepare(
      "INSERT INTO threads (id, kind, created_at) VALUES ('everyone-test', 'team', ?1) ON CONFLICT(id) DO NOTHING",
    ).bind(Date.now()).run();
    const line = { threadId: 'everyone-test', threadKind: 'team' as const, messageId: 'm-1', text: 'morning', sentAt: Date.now(), sender: { email: rosa.email, name: rosa.name } };
    await notifyThreadAgents(env as Env, line);
    expect(delivered).toEqual([]);
    const before = await (env as Env).USAGE.prepare('SELECT 1 AS yes FROM agent_addressers WHERE agent_sub = ?1').bind(vocabSub).first();
    expect(before).toBeNull();

    // The same line naming the agent wakes it, and the person is now on record as having addressed it.
    await notifyThreadAgents(env as Env, { ...line, messageId: 'm-2', text: '@vocab morning', mentions: [vocabEmail.toUpperCase()] });
    expect(delivered).toEqual(['everyone-test']);
    const after = await (env as Env).USAGE.prepare(
      'SELECT actor_sub FROM agent_addressers WHERE agent_sub = ?1',
    ).bind(vocabSub).first<{ actor_sub: string }>();
    expect(after?.actor_sub).toBe(rosa.sub);
  });

  it('records runtime refusal separately from a delivery that never gets an HTTP response', async () => {
    (env as Env).AGENT_ROSTER = JSON.stringify({
      [vocabEmail]: { name: 'Vocab', endpoint: 'https://vocab.example.com/meet/handoff' },
    });
    await ensureAgentPeople(env as Env, Date.now());
    await seedThreadMember('rejected-thread', vocabSub, vocabEmail);
    await seedThreadMember('failed-thread', vocabSub, vocabEmail);
    let call = 0;
    vi.stubGlobal('fetch', async () => {
      call += 1;
      if (call === 1) return new Response(null, { status: 503 });
      throw new Error('connection unavailable');
    });

    const deliveries: Array<[string, string]> = [
      ['rejected-thread', 'rejected-message'],
      ['failed-thread', 'failed-message'],
    ];
    for (const [threadId, messageId] of deliveries) {
      await notifyThreadAgents(env as Env, {
        threadId,
        threadKind: 'dm',
        messageId,
        text: 'hello',
        sentAt: Date.now(),
        sender: { email: rosa.email, name: rosa.name },
      });
    }

    const outcomes = await (env as Env).USAGE.prepare(
      "SELECT source_message_id, kind, response_status FROM agent_activity_events WHERE kind IN ('rejected', 'delivery_failed') ORDER BY source_message_id",
    ).all<{ source_message_id: string; kind: string; response_status: number | null }>();
    expect(outcomes.results).toEqual([
      { source_message_id: 'failed-message', kind: 'delivery_failed', response_status: null },
      { source_message_id: 'rejected-message', kind: 'rejected', response_status: 503 },
    ]);
  });

  it('serves a content-free activity summary to admins, refuses members, and exposes no thread or message ids', async () => {
    (env as Env).AGENT_ROSTER = JSON.stringify({
      [vocabEmail]: { name: 'Vocab', endpoint: 'https://vocab.example.com/meet/handoff?token=not-for-admin' },
      'factory-web@example.com': 'Factory: Web',
    });
    await ensureAgentPeople(env as Env, Date.now());
    await recordAgentActivity(env as Env, {
      eventId: 'admin-summary-reply',
      runId: null,
      agentSub: vocabSub,
      threadId: 'private-thread-id',
      sourceMessageId: 'private-message-id',
      kind: 'reply',
      occurredAt: Date.now(),
    });

    const session = await exports.default.fetch(new Request('http://local/api/dev/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: rosa.name, email: rosa.email }),
    }));
    const { access_token } = await session.json<{ access_token: string }>();
    await recordOwnerSignIn(env as Env, { sub: `dev:${rosa.email}`, email: rosa.email, name: rosa.name }, 'mac');

    // Admin is for admins only: a member is refused, an admin reads it.
    const asMember = await exports.default.fetch(new Request('http://local/api/admin/agent-activity', {
      headers: { authorization: `Bearer ${access_token}` },
    }));
    expect(asMember.status).toBe(403);
    // The roster row carries Rosa's seeded sub; the dev session signs in as
    // `dev:<email>`, and the admin check reads the role by the session's sub.
    await env.USAGE.prepare("UPDATE people SET role = 'admin', sub = ?2 WHERE email = ?1").bind(rosa.email, `dev:${rosa.email}`).run();
    resetRoleCache();

    const response = await exports.default.fetch(new Request('http://local/api/admin/agent-activity', {
      headers: { authorization: `Bearer ${access_token}` },
    }));
    expect(response.status).toBe(200);
    const body = await response.json<AdminAgentActivityResponse>();
    expect(body).toMatchObject({ source: 'meet-observed', window_days: 30, totals: { replies: 1 } });
    expect(body.agents).toContainEqual(expect.objectContaining({
      agent_email: vocabEmail,
      endpoint_configured: true,
      endpoint_origin: 'https://vocab.example.com',
      replies: 1,
    }));
    expect(body.agents).toContainEqual(expect.objectContaining({
      agent_email: 'factory-web@example.com',
      endpoint_configured: false,
      endpoint_origin: null,
    }));
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('private-thread-id');
    expect(serialized).not.toContain('private-message-id');
    expect(serialized).not.toContain('/meet/handoff');
    expect(serialized).not.toContain('not-for-admin');
  });

  it('resets a hand-off stuck past the threshold, once, via the agent\'s resetEndpoint', async () => {
    (env as Env).AGENT_ROSTER = JSON.stringify({
      [vocabEmail]: {
        name: 'Vocab',
        endpoint: 'https://vocab.example.com/meet/handoff',
        resetEndpoint: 'https://vocab.example.com/meet/reset',
      },
    });
    await ensureAgentPeople(env as Env, Date.now());
    const threadId = await openRealDmWithVocab();

    const now = Date.now();
    const staleAcceptedAt = now - 20 * 60_000; // 20 minutes ago, well past the threshold
    await (env as Env).USAGE.prepare(
      'INSERT INTO agent_handoffs (agent_sub, thread_id, accepted_at, replied_at, reset_at, request_message_id) VALUES (?1, ?2, ?3, NULL, NULL, ?4)',
    ).bind(vocabSub, threadId, staleAcceptedAt, 'stuck-request-message').run();

    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    await resetStuckAgents(env as Env, now);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://vocab.example.com/meet/reset');
    expect(calls[0]?.body).toEqual({ thread_id: threadId });
    const resetEvent = await (env as Env).USAGE.prepare(
      "SELECT kind FROM agent_activity_events WHERE source_message_id = 'stuck-request-message'",
    ).first<{ kind: string }>();
    expect(resetEvent?.kind).toBe('watchdog_reset');

    const row = await pendingRow(threadId);
    expect(row?.reset_at).not.toBeNull();

    // The person is told, spoken as the agent, not left to notice silence.
    const indexed = await (env as Env).USAGE.prepare(
      'SELECT last_message_preview, last_sender_email FROM threads WHERE id = ?1',
    ).bind(threadId).first<{ last_message_preview: string; last_sender_email: string }>();
    expect(indexed?.last_sender_email).toBe(vocabEmail);
    expect(indexed?.last_message_preview).toContain('lost track of that');

    // A second tick must not fire again for the same still-pending row.
    await resetStuckAgents(env as Env, now + 60_000);
    expect(calls).toHaveLength(1);
  });

  describe('one quiet retry of a stuck run (meet#1062)', () => {
    const roster = () => JSON.stringify({
      [vocabEmail]: {
        name: 'Vocab',
        endpoint: 'https://vocab.example.com/meet/handoff',
        resetEndpoint: 'https://vocab.example.com/meet/reset',
      },
    });
    const lastSender = async (threadId: string) => (await (env as Env).USAGE.prepare(
      'SELECT last_sender_email, last_message_preview FROM threads WHERE id = ?1',
    ).bind(threadId).first<{ last_sender_email: string; last_message_preview: string }>());

    it('redelivers the request once and says nothing; a second hang posts the Retry notice', async () => {
      (env as Env).AGENT_ROSTER = roster();
      await ensureAgentPeople(env as Env, Date.now());
      const calls: Array<{ url: string; body: { kind?: string; message_id?: string } }> = [];
      vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });
      const { threadId, headers } = await openRealDmWithVocabAs();
      const requestId = await sendAsMz(headers, threadId, 'summarise https://x.com/post/1');
      const now = Date.now();
      await makeStale(threadId, now);
      calls.length = 0;

      await resetStuckAgents(env as Env, now);
      expect(calls.map((call) => call.url)).toEqual(['https://vocab.example.com/meet/reset', 'https://vocab.example.com/meet/handoff']);
      expect(calls[1]?.body).toMatchObject({ kind: 'message', message_id: requestId });
      // No chat line: the person's own message is still the thread's last.
      expect((await lastSender(threadId))?.last_sender_email).toBe(rosa.email);
      const retried = await (env as Env).USAGE.prepare(
        'SELECT reset_at, retried_at FROM agent_handoffs WHERE agent_sub = ?1 AND thread_id = ?2',
      ).bind(vocabSub, threadId).first<{ reset_at: number | null; retried_at: number | null }>();
      expect(retried).toMatchObject({ reset_at: null, retried_at: now });

      // The retry hangs too: reset, no second retry, and the notice as Vocab.
      await makeStale(threadId, now + 60_000);
      calls.length = 0;
      await resetStuckAgents(env as Env, now + 60_000);
      expect(calls.map((call) => call.url)).toEqual(['https://vocab.example.com/meet/reset']);
      const after = await lastSender(threadId);
      expect(after?.last_sender_email).toBe(vocabEmail);
      expect(after?.last_message_preview).toContain('lost track of that');
      expect((await pendingRow(threadId))?.reset_at).not.toBeNull();
    });

    it('does not retry a request a newer message from the person replaced', async () => {
      (env as Env).AGENT_ROSTER = roster();
      await ensureAgentPeople(env as Env, Date.now());
      const calls: string[] = [];
      vi.stubGlobal('fetch', async (url: string) => {
        calls.push(url);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });
      const { threadId, headers } = await openRealDmWithVocabAs();
      const first = await sendAsMz(headers, threadId, 'first ask');
      await sendAsMz(headers, threadId, 'never mind, this instead');
      const now = Date.now();
      // The row points at the first request, as if the second was never taken.
      await (env as Env).USAGE.prepare(
        'UPDATE agent_handoffs SET request_message_id = ?3, accepted_at = ?4, retried_at = NULL WHERE agent_sub = ?1 AND thread_id = ?2',
      ).bind(vocabSub, threadId, first, now - 20 * 60_000).run();
      calls.length = 0;

      await resetStuckAgents(env as Env, now);
      expect(calls).toEqual(['https://vocab.example.com/meet/reset']);
      expect((await lastSender(threadId))?.last_sender_email).toBe(vocabEmail);
    });
  });

  it('leaves a hand-off alone before the threshold, and skips agents with no resetEndpoint', async () => {
    (env as Env).AGENT_ROSTER = JSON.stringify({
      [vocabEmail]: { name: 'Vocab', endpoint: 'https://vocab.example.com/meet/handoff' },
    });
    await ensureAgentPeople(env as Env, Date.now());

    const now = Date.now();
    await (env as Env).USAGE.prepare(
      'INSERT INTO agent_handoffs (agent_sub, thread_id, accepted_at, replied_at, reset_at) VALUES (?1, ?2, ?3, NULL, NULL)',
    ).bind(vocabSub, 'thread-fresh', now - 30_000).run();

    let called = false;
    vi.stubGlobal('fetch', async () => {
      called = true;
      return new Response(null, { status: 200 });
    });

    // No resetEndpoint declared — resetStuckAgents must not touch the row at all.
    await resetStuckAgents(env as Env, now);
    expect(called).toBe(false);
    expect((await pendingRow('thread-fresh'))?.reset_at).toBeNull();
  });
});
