// Remove a channel whose subject is gone, and put it back (meet#707).
//
// Core is stubbed per subject id: it has the subject, it says "not found"
// (200, ok, empty list: what Core sends for an exact-id lookup that matched
// nothing), or it fails (5xx, a dropped connection, a body that is not a
// lookup answer). Only the second may ever remove anything.
import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChannelRemoveResponse,
  ChannelRestoreResponse,
  OrphanChannelsResponse,
  ThreadMessagesResponse,
  ThreadSummary,
  ThreadsResponse,
} from '@starlings/contracts';
import type { InboxResponse } from '@starlings/contracts/inbox';
import type { SearchResponse } from '@starlings/contracts/search';
import { purgeAllCoreCache } from '../src/core-cache';
import { resetRoleCache } from '../src/capabilities';
import { resetPeerRosterCache } from '../src/peers';
import { appendInboundMessage, postSubjectEvent, subjectOfInboundLocal } from '../src/threads';

const CORE_SECRET = 'core-test-secret-with-at-least-32-characters';
const LEAD = 'c0ffee00-0000-4000-8000-0000000000a1';
const PROJECT = 'c0ffee00-0000-4000-8000-0000000000a2';
const LIVE = 'c0ffee00-0000-4000-8000-0000000000a3';

type CoreAnswer = 'exists' | 'gone' | 'http500' | 'dropped' | 'other-subject' | 'no-list' | 'not-ok';
let core = new Map<string, CoreAnswer>();
let configured: string | undefined;

const titles = new Map([[LEAD, 'ZZ test lead'], [PROJECT, 'ZZ test project'], [LIVE, 'Live project']]);

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function stubCore() {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!url.pathname.endsWith('meet-crm-subjects')) return json({ ok: true, subjects: [], tasks: [], interactions: [], has_more: false });
    const id = url.searchParams.get('id');
    const kind = url.searchParams.get('kind');
    const row = { id, kind, title: titles.get(id ?? '') ?? 'Subject', subtitle: null };
    switch (core.get(id ?? '') ?? 'gone') {
      case 'exists': return json({ ok: true, subject: row, subjects: [row], has_more: false });
      case 'gone': return json({ ok: true, subjects: [], has_more: false });
      case 'http500': return json({ ok: false, error: 'Failed to list' }, 500);
      case 'dropped': throw new TypeError('connection dropped');
      case 'other-subject': return json({ ok: true, subjects: [{ ...row, id: 'someone-else' }], has_more: false });
      case 'no-list': return json({ ok: true });
      case 'not-ok': return json({ ok: false, subjects: [] });
    }
  });
}

async function session(email: string, name: string) {
  const response = await exports.default.fetch(new Request('http://local/api/dev/session', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, email }),
  }));
  const body = await response.json<{ access_token: string }>();
  const headers = { authorization: `Bearer ${body.access_token}`, 'content-type': 'application/json', origin: env.WEB_ORIGIN };
  await exports.default.fetch(new Request('http://local/api/peers', { headers }));
  return headers;
}

const admin = () => session('rosa@example.com', 'Rosa');
const member = () => session('chan-ada@example.com', 'Ada');

async function call(method: string, path: string, headers: Record<string, string>, body?: unknown) {
  return exports.default.fetch(new Request(`http://local${path}`, {
    method, headers, body: body === undefined ? null : JSON.stringify(body),
  }));
}

/** Open the subject's channel while Core has it, the way a person does. */
async function openChannel(headers: Record<string, string>, kind: 'lead' | 'project', id: string): Promise<ThreadSummary> {
  core.set(id, 'exists');
  const response = await call('POST', '/api/threads', headers, { kind, subject_id: id });
  expect(response.status).toBe(200);
  return (await response.json<{ thread: ThreadSummary }>()).thread;
}

const listed = async (headers: Record<string, string>) =>
  (await (await call('GET', '/api/threads', headers)).json<ThreadsResponse>()).threads.map((thread) => thread.id);

// admin_audit is append-only (migration 0079), so a case reads only the rows
// written since it started instead of deleting the last case's.
let caseStarted = 0;

beforeEach(() => {
  caseStarted = Date.now();
  core = new Map();
  configured = (env as Env).INTERNAL_REQUEST_SECRET;
  (env as Env).INTERNAL_REQUEST_SECRET = CORE_SECRET;
  stubCore();
});

afterEach(async () => {
  (env as Env).INTERNAL_REQUEST_SECRET = configured as string;
  vi.unstubAllGlobals();
  await env.USAGE.prepare('DELETE FROM thread_members').run();
  await env.USAGE.prepare('DELETE FROM threads').run();
  await env.USAGE.prepare("DELETE FROM people WHERE email LIKE 'chan-%'").run();
  await purgeAllCoreCache();
  resetRoleCache();
  resetPeerRosterCache();
});

describe('GET /api/admin/channels/orphans', () => {
  it('lists the channels whose subject Core says is not found, and nothing else', async () => {
    const headers = await admin();
    const lead = await openChannel(headers, 'lead', LEAD);
    await openChannel(headers, 'project', LIVE);
    await postSubjectEvent(env as Env, { kind: 'lead', id: LEAD }, 'Lead created');
    core.set(LEAD, 'gone');

    const response = await call('GET', '/api/admin/channels/orphans', headers);
    expect(response.status).toBe(200);
    const body = await response.json<OrphanChannelsResponse>();
    expect(body.orphans).toEqual([{
      thread_id: lead.id,
      kind: 'lead',
      title: 'ZZ test lead',
      created_at: expect.any(Number),
      last_message_at: expect.any(Number),
      // Durable Object storage outlives a test; what matters is that it counts the line.
      message_count: expect.any(Number),
    }]);
    expect(body.orphans[0]?.message_count).toBeGreaterThanOrEqual(1);
    expect(body).toMatchObject({ checked: 2, not_checked: 0, check_failed: 0, removed: [] });
  });

  it('does not call a channel an orphan when Core could not answer, and counts it', async () => {
    const headers = await admin();
    await openChannel(headers, 'lead', LEAD);
    await openChannel(headers, 'project', PROJECT);
    await openChannel(headers, 'project', LIVE);
    core.set(LEAD, 'http500');
    core.set(PROJECT, 'dropped');
    // Core is up and the answer is not "nothing with that id": Core ignored the id.
    core.set(LIVE, 'other-subject');

    const body = await (await call('GET', '/api/admin/channels/orphans', headers)).json<OrphanChannelsResponse>();
    expect(body.orphans).toEqual([]);
    expect(body).toMatchObject({ checked: 0, check_failed: 3, not_checked: 0 });
  });

  it('checks a bounded number per call and says how many it left', async () => {
    const headers = await admin();
    const now = Date.now();
    for (let n = 0; n < 65; n += 1) {
      await env.USAGE.prepare(
        `INSERT INTO threads (id, kind, parent_id, created_at, title, audience)
         VALUES (?1, 'lead', ?2, ?3, ?4, 'everyone')`,
      ).bind(`led_bulk${String(n).padStart(3, '0')}`, `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, now - n, `Bulk ${n}`).run();
    }
    const first = await (await call('GET', '/api/admin/channels/orphans', headers)).json<OrphanChannelsResponse>();
    expect(first.checked).toBe(60);
    expect(first.not_checked).toBe(5);
    expect(first.orphans).toHaveLength(60);
    const rest = await (await call('GET', '/api/admin/channels/orphans?offset=60', headers)).json<OrphanChannelsResponse>();
    expect(rest).toMatchObject({ checked: 5, not_checked: 0 });
    expect(rest.orphans).toHaveLength(5);
  });

  it('refuses a member, and a caller with no session', async () => {
    expect((await call('GET', '/api/admin/channels/orphans', await member())).status).toBe(403);
    expect((await exports.default.fetch(new Request('http://local/api/admin/channels/orphans'))).status).toBe(401);
  });

  it('says Core is not connected rather than answering with an empty list', async () => {
    const headers = await admin();
    (env as Env).INTERNAL_REQUEST_SECRET = '';
    const response = await call('GET', '/api/admin/channels/orphans', headers);
    expect(response.status).toBe(503);
  });
});

describe('removing a channel', () => {
  it('hides it from the list, search, INBOX and every direct door, and keeps the messages', async () => {
    const headers = await admin();
    const lead = await openChannel(headers, 'lead', LEAD);
    const keep = await openChannel(headers, 'project', LIVE);
    await postSubjectEvent(env as Env, { kind: 'lead', id: LEAD }, 'Lead created');
    const reader = await member();

    // Before: visible to everyone, unread in INBOX, found by name, mail finds it.
    expect(await listed(reader)).toContain(lead.id);
    const before = await (await call('GET', '/api/crm/inbox', reader)).json<InboxResponse>();
    expect(before.items.some((item) => item.key.endsWith(`:${lead.id}`))).toBe(true);
    const found = await (await call('GET', '/api/search?q=ZZ%20test%20lead', reader)).json<SearchResponse>();
    expect(found.rows.some((row) => row.kind === 'thread' && row.id === lead.id)).toBe(true);
    const local = (await env.USAGE.prepare('SELECT inbound_local FROM threads WHERE id = ?1').bind(lead.id).first<{ inbound_local: string | null }>())?.inbound_local;
    if (local) expect(await subjectOfInboundLocal(env as Env, local)).toEqual({ kind: 'lead', id: LEAD });

    core.set(LEAD, 'gone');
    const removed = await call('POST', '/api/admin/channels/remove', headers, { thread_id: lead.id });
    expect(removed.status).toBe(200);
    expect((await removed.json<ChannelRemoveResponse>()).thread_id).toBe(lead.id);

    // After: gone for everyone, including the admin who removed it.
    for (const who of [reader, headers]) {
      const ids = await listed(who);
      expect(ids).not.toContain(lead.id);
      expect(ids).toContain(keep.id);
    }
    const inbox = await (await call('GET', '/api/crm/inbox', reader)).json<InboxResponse>();
    expect(inbox.items.some((item) => item.key.endsWith(`:${lead.id}`))).toBe(false);
    const search = await (await call('GET', '/api/search?q=ZZ%20test%20lead', reader)).json<SearchResponse>();
    expect(search.rows.some((row) => row.id === lead.id)).toBe(false);
    expect((await call('GET', `/api/threads/${lead.id}/messages`, reader)).status).toBe(404);
    if (local) expect(await subjectOfInboundLocal(env as Env, local)).toBeNull();

    // It is off the orphan list and on the removed list; the transcript is untouched.
    const orphans = await (await call('GET', '/api/admin/channels/orphans', headers)).json<OrphanChannelsResponse>();
    expect(orphans.orphans).toEqual([]);
    expect(orphans.removed).toEqual([{
      thread_id: lead.id, kind: 'lead', title: 'ZZ test lead', removed_at: expect.any(Number), removed_by: 'rosa@example.com',
    }]);
    const row = await env.USAGE.prepare('SELECT removed_at, removed_by FROM threads WHERE id = ?1').bind(lead.id).first<{ removed_at: number; removed_by: string }>();
    expect(row?.removed_by).toBe('rosa@example.com');
    const audit = await env.USAGE.prepare("SELECT actor_email, subject FROM admin_audit WHERE action = 'job.remove-channel' AND ts >= ?1").bind(caseStarted).all<{ actor_email: string; subject: string }>();
    expect(audit.results).toEqual([{ actor_email: 'rosa@example.com', subject: lead.id }]);
  });

  it('is refused for a direct conversation and for Team', async () => {
    const headers = await admin();
    await member();
    const dm = await call('POST', '/api/threads', headers, { peer_email: 'chan-ada@example.com' });
    const dmId = (await dm.json<{ thread: ThreadSummary }>()).thread.id;
    const team = await call('POST', '/api/threads', headers, { kind: 'team' });
    const teamId = (await team.json<{ thread: ThreadSummary }>()).thread.id;
    for (const id of [dmId, teamId]) {
      const response = await call('POST', '/api/admin/channels/remove', headers, { thread_id: id });
      expect(response.status).toBe(400);
    }
    const row = await env.USAGE.prepare('SELECT COUNT(*) AS n FROM threads WHERE removed_at IS NOT NULL').first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it('is refused while the subject exists in Core', async () => {
    const headers = await admin();
    const live = await openChannel(headers, 'project', LIVE);
    const response = await call('POST', '/api/admin/channels/remove', headers, { thread_id: live.id });
    expect(response.status).toBe(409);
    expect(await listed(headers)).toContain(live.id);
  });

  it('is refused, with nothing written, whenever Core cannot give a clean "not found"', async () => {
    const headers = await admin();
    const lead = await openChannel(headers, 'lead', LEAD);
    for (const answer of ['http500', 'dropped', 'other-subject', 'no-list', 'not-ok'] as const) {
      core.set(LEAD, answer);
      const response = await call('POST', '/api/admin/channels/remove', headers, { thread_id: lead.id });
      expect(response.status, answer).toBe(502);
      expect(await listed(headers), answer).toContain(lead.id);
    }
    // And with Core off altogether.
    (env as Env).INTERNAL_REQUEST_SECRET = '';
    expect((await call('POST', '/api/admin/channels/remove', headers, { thread_id: lead.id })).status).toBe(503);
    expect(await listed(headers)).toContain(lead.id);
  });

  it('404s on an id that is not a thread, and is refused for a member and with no session', async () => {
    const headers = await admin();
    const lead = await openChannel(headers, 'lead', LEAD);
    core.set(LEAD, 'gone');
    expect((await call('POST', '/api/admin/channels/remove', headers, { thread_id: 'led_nothing' })).status).toBe(404);
    expect((await call('POST', '/api/admin/channels/remove', await member(), { thread_id: lead.id })).status).toBe(403);
    expect((await exports.default.fetch(new Request('http://local/api/admin/channels/remove', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: env.WEB_ORIGIN }, body: JSON.stringify({ thread_id: lead.id }),
    }))).status).toBe(401);
    expect(await listed(headers)).toContain(lead.id);
  });
});

describe('restoring a channel', () => {
  it('brings it back with its history, and is refused for a member', async () => {
    const headers = await admin();
    const lead = await openChannel(headers, 'lead', LEAD);
    const line = `Lead created ${crypto.randomUUID()}`;
    await postSubjectEvent(env as Env, { kind: 'lead', id: LEAD }, line);
    core.set(LEAD, 'gone');
    await call('POST', '/api/admin/channels/remove', headers, { thread_id: lead.id });
    expect(await listed(headers)).not.toContain(lead.id);

    expect((await call('POST', '/api/admin/channels/restore', await member(), { thread_id: lead.id })).status).toBe(403);
    const restored = await call('POST', '/api/admin/channels/restore', headers, { thread_id: lead.id });
    expect(restored.status).toBe(200);
    expect(await restored.json<ChannelRestoreResponse>()).toEqual({ thread_id: lead.id, restored: true });

    expect(await listed(headers)).toContain(lead.id);
    const messages = await (await call('GET', `/api/threads/${lead.id}/messages`, headers)).json<ThreadMessagesResponse>();
    expect(messages.messages.map((message) => message.text)).toContain(line);
    const orphans = await (await call('GET', '/api/admin/channels/orphans', headers)).json<OrphanChannelsResponse>();
    expect(orphans.removed).toEqual([]);
    expect(orphans.orphans.map((row) => row.thread_id)).toEqual([lead.id]);

    // A channel that is not removed has nothing to restore.
    const again = await call('POST', '/api/admin/channels/restore', headers, { thread_id: lead.id });
    expect(await again.json<ChannelRestoreResponse>()).toEqual({ thread_id: lead.id, restored: false });
    const audit = await env.USAGE.prepare("SELECT action FROM admin_audit WHERE action LIKE 'job.%-channel' AND ts >= ?1 ORDER BY ts").bind(caseStarted).all<{ action: string }>();
    expect(audit.results.map((row) => row.action)).toEqual(['job.remove-channel', 'job.restore-channel']);
  });
});

describe('a subject that comes back', () => {
  async function removedLead() {
    const headers = await admin();
    const lead = await openChannel(headers, 'lead', LEAD);
    core.set(LEAD, 'gone');
    expect((await call('POST', '/api/admin/channels/remove', headers, { thread_id: lead.id })).status).toBe(200);
    return { headers, lead };
  }

  it('clears the removal when an event is filed on the subject', async () => {
    const { headers, lead } = await removedLead();
    core.set(LEAD, 'exists');
    await postSubjectEvent(env as Env, { kind: 'lead', id: LEAD }, 'Lead reopened');
    expect(await listed(headers)).toContain(lead.id);
    const row = await env.USAGE.prepare('SELECT removed_at, removed_by FROM threads WHERE id = ?1').bind(lead.id).first();
    expect(row).toEqual({ removed_at: null, removed_by: null });
  });

  it('clears the removal when a message arrives for the thread', async () => {
    const { headers, lead } = await removedLead();
    await appendInboundMessage(env as Env, {
      threadId: lead.id,
      messageId: 'evt_back',
      sender: { sub: 'meet', email: 'meet@org.example', name: 'Meet' },
      text: 'Back again',
      type: 'event',
      refs: [],
    });
    expect(await listed(headers)).toContain(lead.id);
  });

  it('clears the removal when a person opens the subject again', async () => {
    const { headers, lead } = await removedLead();
    core.set(LEAD, 'exists');
    const reopened = await openChannel(headers, 'lead', LEAD);
    expect(reopened.id).toBe(lead.id);
    expect(await listed(headers)).toContain(lead.id);
  });

  it('does not clear it for a message nobody can send to a hidden channel', async () => {
    const { headers, lead } = await removedLead();
    const sent = await call('POST', `/api/threads/${lead.id}/messages`, headers, { text: 'still there?' });
    expect(sent.status).toBe(404);
    expect(await listed(headers)).not.toContain(lead.id);
  });
});
