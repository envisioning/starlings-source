import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ThreadMessagesResponse, ThreadSummary, ThreadsResponse } from '@starlings/contracts';
import { recordOwnerSignIn } from '../src/usage';
import { describeDuration, openSubjectThread, postSubjectEvent, subjectOfCategory } from '../src/threads';
import { encodeMcpChangeCursor } from '@starlings/contracts/mcp';

import { requireCapability } from '../src/capabilities';
// The person a route's gate has already read: what a thread function takes now.
const memberOf = (request: Request) => requireCapability(request, env as Env, 'conversations');

const rosa = { sub: 'dm-rosa', email: 'dm-rosa@example.com', name: 'Rosa' };
const ada = { sub: 'dm-ada', email: 'dm-ada@example.com', name: 'Ada' };
const outsider = { sub: 'dm-out', email: 'dm-kim@acme.example', name: 'Kim' };
const nonMember = { sub: 'dm-nonmember', email: 'dm-nonmember@example.com', name: 'Kim' };

async function session(email: string, name: string) {
  const response = await exports.default.fetch(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, email }),
  }));
  const body = await response.json<{ access_token: string }>();
  return { authorization: `Bearer ${body.access_token}`, 'content-type': 'application/json' };
}

/** Dev sessions mint their own `dev:` subject, so the ledger row must match it. */
async function member(person: { email: string; name: string }) {
  const headers = await session(person.email, person.name);
  await recordOwnerSignIn(env as Env, { sub: `dev:${person.email}`, ...person }, 'mac');
  return headers;
}

async function openThread(headers: Record<string, string>, peerEmail: string) {
  const response = await exports.default.fetch(new Request('http://local/api/threads', {
    method: 'POST',
    headers,
    body: JSON.stringify({ peer_email: peerEmail }),
  }));
  return { status: response.status, body: await response.json<{ thread: ThreadSummary }>() };
}

async function openTeam(headers: Record<string, string>) {
  const response = await exports.default.fetch(new Request('http://local/api/threads', {
    method: 'POST',
    headers,
    body: JSON.stringify({ kind: 'team' }),
  }));
  return { status: response.status, body: await response.json<{ thread: ThreadSummary }>() };
}

async function list(headers: Record<string, string>) {
  const response = await exports.default.fetch(new Request('http://local/api/threads', { headers }));
  return (await response.json<ThreadsResponse>()).threads;
}

async function send(headers: Record<string, string>, id: string, text: string) {
  return exports.default.fetch(new Request(`http://local/api/threads/${id}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ text }),
  }));
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await env.USAGE.prepare('DELETE FROM thread_members').run();
  await env.USAGE.prepare('DELETE FROM threads').run();
  await env.USAGE.prepare("DELETE FROM people WHERE email LIKE 'dm-%'").run();
});

describe('direct messages', () => {
  it('refuses an unauthenticated caller', async () => {
    const response = await exports.default.fetch(new Request('http://local/api/threads'));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: 'owner_auth_required' });
  });

  it('opens the same thread from either side, however many times', async () => {
    const mine = await member(rosa);
    const theirs = await member(ada);

    const first = await openThread(mine, ada.email);
    expect(first.status).toBe(200);
    const again = await openThread(mine, ada.email);
    const reverse = await openThread(theirs, rosa.email);

    expect(again.body.thread.id).toBe(first.body.thread.id);
    expect(reverse.body.thread.id).toBe(first.body.thread.id);
    const rows = await env.USAGE.prepare('SELECT COUNT(*) AS n FROM threads').first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it('names the other person from each side', async () => {
    const mine = await member(rosa);
    await member(ada);
    const opened = await openThread(mine, ada.email);
    expect(opened.body.thread.peer_email).toBe(ada.email);
    expect(opened.body.thread.kind).toBe('dm');
    expect(opened.body.thread.parent_id).toBeNull();
  });

  it('delivers a message to the other member and marks it theirs, not mine', async () => {
    const mine = await member(rosa);
    const theirs = await member(ada);
    const { body } = await openThread(mine, ada.email);
    const id = body.thread.id;

    expect((await send(mine, id, 'standup in 5?')).status).toBe(201);

    const response = await exports.default.fetch(new Request(
      `http://local/api/threads/${id}/messages`, { headers: theirs },
    ));
    expect(response.status).toBe(200);
    const read = await response.json<ThreadMessagesResponse>();
    expect(read.messages).toHaveLength(1);
    expect(read.messages[0]!.text).toBe('standup in 5?');
    expect(read.messages[0]!.is_mine).toBe(false);
    expect(read.messages[0]!.sender_email).toBe(rosa.email);
  });

  it('pages changes after an exclusive cursor without losing equal-time messages', async () => {
    const mine = await member(rosa);
    const changePeer = {
      sub: `dm-change-${crypto.randomUUID()}`,
      email: `dm-change-${crypto.randomUUID()}@example.com`,
      name: 'Changes peer',
    };
    await member(changePeer);
    const outsiderHeaders = await member(nonMember);
    const { body } = await openThread(mine, changePeer.email);
    const id = body.thread.id;
    const since = new Date(Date.now() - 10_000).toISOString();
    const sentAt = Date.now();
    const thread = env.THREADS.getByName(id) as DurableObjectStub<import('../src/thread-coordinator').ThreadCoordinator>;
    const sender = { sub: `dev:${rosa.email}`, email: rosa.email, name: rosa.name };
    await thread.append(sender, 'first at this time', 'equal-time-a', sentAt);
    await thread.append(sender, 'second at this time', 'equal-time-b', sentAt);

    const readChanges = async (cursor: string) => {
      const response = await exports.default.fetch(new Request(
        `http://local/api/threads/${id}/messages?since=${encodeURIComponent(cursor)}&limit=1`,
        { headers: mine },
      ));
      return { response, body: await response.json<{
        thread_id: string;
        changes: Array<{ id: string; changed_at: number; change: string; summary: string }>;
        has_more: boolean;
      }>() };
    };

    const first = await readChanges(since);
    expect(first.response.status).toBe(200);
    expect(first.body.changes).toHaveLength(1);
    expect(first.body.changes[0]?.change).toBe('created');
    expect(first.body.has_more).toBe(true);

    const afterFirst = encodeMcpChangeCursor(first.body.changes[0]!.changed_at, first.body.changes[0]!.id);
    const second = await readChanges(afterFirst);
    expect(second.body.changes).toHaveLength(1);
    expect(second.body.changes[0]?.changed_at).toBe(first.body.changes[0]?.changed_at);
    expect(second.body.changes[0]?.id).not.toBe(first.body.changes[0]?.id);
    expect(second.body.has_more).toBe(false);

    const bulk = await exports.default.fetch(new Request(
      `http://local/api/threads/messages?since=${encodeURIComponent(since)}`,
      { headers: mine },
    ));
    expect((await bulk.json<{ changes: Array<{ id: string; thread_id: string }> }>()).changes).toEqual([
      expect.objectContaining({ id: 'equal-time-a', thread_id: id }),
      expect.objectContaining({ id: 'equal-time-b', thread_id: id }),
    ]);

    const afterSecond = encodeMcpChangeCursor(second.body.changes[0]!.changed_at, second.body.changes[0]!.id);
    const empty = await readChanges(afterSecond);
    expect(empty.body.changes).toEqual([]);

    await thread.edit(sender.sub, 'equal-time-a', 'edited at the same stable row', sentAt + 1_000);
    await thread.withdraw(sender.sub, 'equal-time-b', sentAt + 2_000);
    const laterChanges = await readChanges(afterSecond);
    expect(laterChanges.body.changes.map((change) => change.change)).toEqual(['updated']);
    expect(laterChanges.body.has_more).toBe(true);
    const afterEdit = encodeMcpChangeCursor(laterChanges.body.changes[0]!.changed_at, laterChanges.body.changes[0]!.id);
    const withdrawal = await readChanges(afterEdit);
    expect(withdrawal.body.changes.map((change) => change.change)).toEqual(['deleted']);
    expect(withdrawal.body.changes[0]?.summary).toBe('Message withdrawn');

    const refused = await exports.default.fetch(new Request(
      `http://local/api/threads/${id}/messages?since=${encodeURIComponent(since)}`,
      { headers: outsiderHeaders },
    ));
    expect(refused.status).toBe(404);
    const hidden = await exports.default.fetch(new Request(
      `http://local/api/threads/messages?since=${encodeURIComponent(since)}`,
      { headers: outsiderHeaders },
    ));
    expect((await hidden.json<{ changes: unknown[] }>()).changes).toEqual([]);
  });

  it('shows unread to the recipient and never to the sender', async () => {
    const mine = await member(rosa);
    const theirs = await member(ada);
    const { body } = await openThread(mine, ada.email);
    await send(mine, body.thread.id, 'ping');

    const listFor = async (headers: Record<string, string>) => {
      const response = await exports.default.fetch(new Request('http://local/api/threads', { headers }));
      return (await response.json<ThreadsResponse>()).threads[0]!;
    };

    expect((await listFor(theirs)).unread).toBe(true);
    expect((await listFor(mine)).unread).toBe(false);

    await exports.default.fetch(new Request(`http://local/api/threads/${body.thread.id}/read`, {
      method: 'POST', headers: theirs, body: JSON.stringify({}),
    }));
    expect((await listFor(theirs)).unread).toBe(false);
    expect((await listFor(theirs)).last_message_preview).toBe('ping');
  });

  it('hides a conversation from everyone who is not in it', async () => {
    const mine = await member(rosa);
    await member(ada);
    const third = await member({ email: 'dm-sam@example.com', name: 'Sam' });
    const { body } = await openThread(mine, ada.email);

    for (const [label, request] of [
      ['read', new Request(`http://local/api/threads/${body.thread.id}/messages`, { headers: third })],
      ['write', new Request(`http://local/api/threads/${body.thread.id}/messages`, {
        method: 'POST', headers: third, body: JSON.stringify({ text: 'hello' }),
      })],
    ] as const) {
      const response = await exports.default.fetch(request);
      // 404, not 403: whether a conversation exists is itself private.
      expect(response.status, label).toBe(404);
    }

    const list = await exports.default.fetch(new Request('http://local/api/threads', { headers: third }));
    expect((await list.json<ThreadsResponse>()).threads).toHaveLength(0);
  });

  it('lets one person keep a note to self, and shows it to nobody else', async () => {
    const mine = await member(rosa);
    const theirs = await member(ada);

    const own = await openThread(mine, rosa.email);
    expect(own.status).toBe(200);
    expect(own.body.thread.peer_email).toBe(rosa.email);
    expect((await send(mine, own.body.thread.id, 'remember the migration')).status).toBe(201);

    // Same thread from a second device — this is what makes single-account
    // two-surface testing possible at all.
    const again = await openThread(mine, rosa.email);
    expect(again.body.thread.id).toBe(own.body.thread.id);
    const read = await (await exports.default.fetch(new Request(
      `http://local/api/threads/${own.body.thread.id}/messages`, { headers: mine },
    ))).json<ThreadMessagesResponse>();
    expect(read.messages.map((m) => m.text)).toEqual(['remember the migration']);
    expect(read.messages[0]!.is_mine).toBe(true);

    const intruder = await exports.default.fetch(new Request(
      `http://local/api/threads/${own.body.thread.id}/messages`, { headers: theirs },
    ));
    expect(intruder.status).toBe(404);
  });

  it('treats org.example and org-alt.example as one team', async () => {
    const mine = await member(rosa);
    const io = { email: 'dm-accounts@example.org', name: 'Accounts' };
    await member(io);
    const opened = await openThread(mine, io.email);
    expect(opened.status).toBe(200);
    expect(opened.body.thread.peer_email).toBe(io.email);
  });

  it('keeps messages inside Envisioning', async () => {
    const mine = await member(rosa);
    await recordOwnerSignIn(env as Env, outsider, 'web');
    const attempt = await openThread(mine, outsider.email);
    expect(attempt.status).toBe(403);
  });

  it('refuses an empty message and one past the cap', async () => {
    const mine = await member(rosa);
    await member(ada);
    const { body } = await openThread(mine, ada.email);
    expect((await send(mine, body.thread.id, '   ')).status).toBe(400);
    expect((await send(mine, body.thread.id, 'x'.repeat(4_001))).status).toBe(400);
  });

  it('pages oldest-first with a cursor back through history', async () => {
    const mine = await member(rosa);
    await member(ada);
    const { body } = await openThread(mine, ada.email);
    for (let index = 0; index < 5; index += 1) {
      await send(mine, body.thread.id, `message ${index}`);
    }

    const page = await (await exports.default.fetch(new Request(
      `http://local/api/threads/${body.thread.id}/messages?limit=2`, { headers: mine },
    ))).json<ThreadMessagesResponse>();
    expect(page.messages.map((m) => m.text)).toEqual(['message 3', 'message 4']);
    expect(page.older_cursor).not.toBeNull();

    const older = await (await exports.default.fetch(new Request(
      `http://local/api/threads/${body.thread.id}/messages?limit=2&before=${page.older_cursor}`,
      { headers: mine },
    ))).json<ThreadMessagesResponse>();
    expect(older.messages.map((m) => m.text)).toEqual(['message 1', 'message 2']);
  });
});

describe('the team channel', () => {
  it('is one conversation, whoever opens it', async () => {
    const mine = await member(rosa);
    const theirs = await member(ada);

    const first = await openTeam(mine);
    const second = await openTeam(theirs);

    expect(first.status).toBe(200);
    expect(second.body.thread.id).toBe(first.body.thread.id);
    expect(first.body.thread.kind).toBe('team');
    expect(first.body.thread.audience).toBe('everyone');
    expect(first.body.thread.title).toBe('Everyone');
    expect(first.body.thread.peer_email).toBeNull();
    const rows = await env.USAGE.prepare(
      "SELECT COUNT(*) AS n FROM threads WHERE kind = 'team'",
    ).first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it('lets a member read and write without ever being added to it', async () => {
    const mine = await member(rosa);
    const theirs = await member(ada);
    const { body } = await openTeam(mine);
    const id = body.thread.id;

    expect((await send(mine, id, 'coffee machine is fixed')).status).toBe(201);

    // Ada is not a member row anywhere, and still reads it.
    const read = await (await exports.default.fetch(new Request(
      `http://local/api/threads/${id}/messages`, { headers: theirs },
    ))).json<ThreadMessagesResponse>();
    expect(read.messages.map((m) => m.text)).toEqual(['coffee machine is fixed']);
    expect(read.messages[0]!.is_mine).toBe(false);
    expect(read.messages[0]!.type).toBe('text');
    expect((await send(theirs, id, 'about time')).status).toBe(201);
  });

  it('appears in the list of somebody who has never opened it', async () => {
    const mine = await member(rosa);
    const theirs = await member(ada);
    await openTeam(mine);

    const seen = await list(theirs);
    expect(seen.map((thread) => thread.kind)).toEqual(['team']);
    // Never read, so nothing to be unread about until somebody writes.
    expect(seen[0]!.unread).toBe(false);
  });

  it('goes unread for everybody else, and clears on the reader alone', async () => {
    const mine = await member(rosa);
    const theirs = await member(ada);
    const { body } = await openTeam(mine);
    await send(mine, body.thread.id, 'standup moved');

    expect((await list(theirs))[0]!.unread).toBe(true);
    // Sending is reading: the sender's own message is never unread.
    expect((await list(mine))[0]!.unread).toBe(false);

    await exports.default.fetch(new Request(`http://local/api/threads/${body.thread.id}/read`, {
      method: 'POST', headers: theirs, body: JSON.stringify({}),
    }));
    expect((await list(theirs))[0]!.unread).toBe(false);

    // The read wrote the row that did not exist before it.
    const rows = await env.USAGE.prepare(
      'SELECT COUNT(*) AS n FROM thread_members WHERE thread_id = ?1',
    ).bind(body.thread.id).first<{ n: number }>();
    expect(rows?.n).toBe(2);
  });

  it('is still Envisioning-only', async () => {
    await recordOwnerSignIn(env as Env, outsider, 'web');
    const headers = await session(outsider.email, outsider.name);
    const response = await exports.default.fetch(new Request('http://local/api/threads', {
      method: 'POST', headers, body: JSON.stringify({ kind: 'team' }),
    }));
    expect(response.status).toBe(401);
  });

  it('does not open a private conversation to the company', async () => {
    const mine = await member(rosa);
    await member(ada);
    const third = await member({ email: 'dm-sam@example.com', name: 'Sam' });
    await openTeam(mine);
    const dm = await openThread(mine, ada.email);

    const response = await exports.default.fetch(new Request(
      `http://local/api/threads/${dm.body.thread.id}/messages`, { headers: third },
    ));
    expect(response.status).toBe(404);
    expect((await list(third)).map((thread) => thread.kind)).toEqual(['team']);
  });
});

describe('a channel on a CRM subject', () => {
  const projectId = '3f6c1f52-0a1b-4c2d-8e3f-0a1b2c3d4e5f';
  /** Core's shared secret is absent in tests, which is what turns CRM off. */
  const withCore = { ...env, INTERNAL_REQUEST_SECRET: 'meet-core-shared-secret-at-least-32-chars' } as Env;

  function coreReturns(subjects: Array<{ id: string; kind: string; title: string; subtitle: string | null }>) {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ ok: true, subjects }), {
      headers: { 'content-type': 'application/json' },
    }));
  }

  async function request(headers: Record<string, string>) {
    return new Request('http://local/api/threads', { method: 'POST', headers });
  }

  it('is refused while the CRM bridge is off', async () => {
    const mine = await member(rosa);
    // Strip the secret here rather than trusting the environment: a checkout
    // with a local `.dev.vars` has the bridge on, and this is about off.
    const withoutCore = { ...env, INTERNAL_REQUEST_SECRET: undefined } as unknown as Env;
    await expect(openSubjectThread(await memberOf(await request(mine)), withoutCore, 'project', projectId))
      .rejects.toThrow('CRM channels are not configured.');
  });

  it('refuses a subject id that is not a subject id', async () => {
    const mine = await member(rosa);
    const response = await exports.default.fetch(new Request('http://local/api/threads', {
      method: 'POST',
      headers: mine,
      body: JSON.stringify({ kind: 'project', subject_id: 'not-a-uuid' }),
    }));
    expect(response.status).toBe(400);
  });

  it('takes its title from Core, never from the caller', async () => {
    const mine = await member(rosa);
    coreReturns([{ id: projectId, kind: 'project', title: 'Acme rollout', subtitle: 'Acme' }]);

    const thread = await openSubjectThread(await memberOf(await request(mine)), withCore, 'project', projectId);
    expect(thread.kind).toBe('project');
    expect(thread.title).toBe('Acme rollout');
    expect(thread.parent_id).toBe(projectId);
    expect(thread.audience).toBe('everyone');
    expect(thread.peer_email).toBeNull();
  });

  it('is the same conversation however many times it is opened, and follows a rename', async () => {
    const mine = await member(rosa);
    coreReturns([{ id: projectId, kind: 'project', title: 'Acme rollout', subtitle: null }]);
    const first = await openSubjectThread(await memberOf(await request(mine)), withCore, 'project', projectId);

    coreReturns([{ id: projectId, kind: 'project', title: 'Acme rollout, phase 2', subtitle: null }]);
    const again = await openSubjectThread(await memberOf(await request(mine)), withCore, 'project', projectId);

    expect(again.id).toBe(first.id);
    // A renamed project must not read under its old name forever.
    expect(again.title).toBe('Acme rollout, phase 2');
    const rows = await env.USAGE.prepare('SELECT COUNT(*) AS n FROM threads').first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it('will not open a channel on a subject Core does not have', async () => {
    const mine = await member(rosa);
    coreReturns([]);
    await expect(openSubjectThread(await memberOf(await request(mine)), withCore, 'project', projectId))
      .rejects.toMatchObject({ status: 404 });
    const rows = await env.USAGE.prepare('SELECT COUNT(*) AS n FROM threads').first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it('separates a lead from a project carrying the same id', async () => {
    const mine = await member(rosa);
    coreReturns([{ id: projectId, kind: 'project', title: 'Acme rollout', subtitle: null }]);
    const project = await openSubjectThread(await memberOf(await request(mine)), withCore, 'project', projectId);
    coreReturns([{ id: projectId, kind: 'lead', title: 'Acme', subtitle: null }]);
    const lead = await openSubjectThread(await memberOf(await request(mine)), withCore, 'lead', projectId);
    expect(lead.id).not.toBe(project.id);
  });

  it('is readable by any member, like every other channel', async () => {
    const mine = await member(rosa);
    const theirs = await member(ada);
    coreReturns([{ id: projectId, kind: 'project', title: 'Acme rollout', subtitle: null }]);
    const channel = await openSubjectThread(await memberOf(await request(mine)), withCore, 'project', projectId);
    vi.unstubAllGlobals();

    expect((await send(mine, channel.id, 'kickoff moved to Thursday')).status).toBe(201);
    const read = await (await exports.default.fetch(new Request(
      `http://local/api/threads/${channel.id}/messages`, { headers: theirs },
    ))).json<ThreadMessagesResponse>();
    expect(read.messages.map((m) => m.text)).toEqual(['kickoff moved to Thursday']);
    expect((await list(theirs)).map((t) => t.title)).toEqual(['Acme rollout']);
  });
});

describe('a private conversation with several people', () => {
  const kim = { sub: 'dm-kim', email: 'dm-kim@example.com', name: 'Kim' };

  async function open(headers: Record<string, string>, body: object) {
    const response = await exports.default.fetch(new Request('http://local/api/threads', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }));
    return { status: response.status, body: await response.json<{ thread: ThreadSummary }>() };
  }

  it('is the same conversation for everyone who names the same people', async () => {
    const mine = await member(rosa);
    const theirs = await member(ada);
    await member(kim);

    const opened = await open(mine, { peer_emails: [ada.email, kim.email] });
    expect(opened.status).toBe(200);
    // Named in another order, by another member: still one conversation. The
    // id is derived from the members, so there is no second one to end up in.
    const again = await open(theirs, { peer_emails: [kim.email, rosa.email] });
    expect(again.body.thread.id).toBe(opened.body.thread.id);
  });

  it('is the conversation a two-person DM already was', async () => {
    // The whole reason groups needed no migration: naming one person through
    // the group door has to land in the DM that already exists, not beside it.
    const mine = await member(rosa);
    await member(ada);
    const asDM = await open(mine, { peer_email: ada.email });
    const asGroup = await open(mine, { peer_emails: [ada.email] });
    expect(asGroup.body.thread.id).toBe(asDM.body.thread.id);
  });

  it('names itself after the people in it, in one order for all of them', async () => {
    // A private conversation has no title, so the roster is the title — and a
    // roster that depended on who created it would read differently to each.
    const mine = await member(rosa);
    const theirs = await member(ada);
    await member(kim);

    const opened = await open(mine, { peer_emails: [kim.email, ada.email] });
    expect(opened.body.thread.title).toBeNull();
    expect(opened.body.thread.peers?.map((peer) => peer.email)).toEqual([ada.email, kim.email]);

    const listedForThem = (await list(theirs)).find((one) => one.id === opened.body.thread.id);
    expect(listedForThem?.peers?.map((peer) => peer.email)).toEqual([kim.email, rosa.email]);
  });

  it('reaches everybody in it, and nobody else', async () => {
    const mine = await member(rosa);
    const theirs = await member(ada);
    const outsiders = await member(outsider);

    const opened = await open(mine, { peer_emails: [ada.email] });
    expect((await send(mine, opened.body.thread.id, 'just us')).status).toBe(201);
    expect((await list(theirs)).some((one) => one.id === opened.body.thread.id)).toBe(true);
    // The membership row is the authorization, exactly as it is for a DM.
    const read = await exports.default.fetch(new Request(
      `http://local/api/threads/${opened.body.thread.id}/messages`, { headers: outsiders },
    ));
    expect(read.status).toBe(401);
  });

  it('refuses somebody who is not on the team', async () => {
    const mine = await member(rosa);
    await member(ada);
    const refused = await open(mine, { peer_emails: [ada.email, 'kim@acme.example'] });
    expect(refused.status).toBe(404);
  });
});

describe('events in a subject channel', () => {
  // One subject per test. D1 is wiped between tests but a Durable Object's
  // storage is not, so two tests on the same project would share a channel.
  const projectId = '7a9d2c41-5b3e-4f60-9c1d-2e3f4a5b6c7d';
  const unopenedId = '8b0e3d52-6c4f-4a71-8d2e-3f4a5b6c7d8e';
  const quietId = '9c1f4e63-7d50-4b82-9e3f-4a5b6c7d8e9f';
  const withCore = { ...env, INTERNAL_REQUEST_SECRET: 'meet-core-shared-secret-at-least-32-chars' } as Env;

  function coreReturns(subjects: Array<{ id: string; kind: string; title: string; subtitle: string | null }>) {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ ok: true, subjects }), {
      headers: { 'content-type': 'application/json' },
    }));
  }

  async function messagesOf(headers: Record<string, string>, id: string) {
    const response = await exports.default.fetch(new Request(`http://local/api/threads/${id}/messages`, { headers }));
    return (await response.json<ThreadMessagesResponse>()).messages;
  }

  it('lands as a quiet line, from Meet, pointing at what it is about', async () => {
    const mine = await member(rosa);
    coreReturns([{ id: projectId, kind: 'project', title: 'Acme rollout', subtitle: 'Acme' }]);

    await postSubjectEvent(withCore, { kind: 'project', id: projectId }, 'Rosa filed a meeting here', [
      { kind: 'meeting', id: 'c0ffee00-0000-4000-8000-000000000001' },
    ]);
    const thread = await openSubjectThread(
      await memberOf(new Request('http://local/api/threads', { method: 'POST', headers: mine })), withCore, 'project', projectId,
    );

    const messages = await messagesOf(mine, thread.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: 'event',
      text: 'Rosa filed a meeting here',
      sender_email: 'meet@org.example',
      is_mine: false,
      refs: [{ kind: 'meeting', id: 'c0ffee00-0000-4000-8000-000000000001' }],
    });
  });

  it('creates the channel on a project nobody has opened yet', async () => {
    const mine = await member(rosa);
    coreReturns([{ id: unopenedId, kind: 'project', title: 'Acme rollout', subtitle: null }]);

    await postSubjectEvent(withCore, { kind: 'project', id: unopenedId }, 'Notes filed: Kickoff');
    const listed = (await list(mine)).find((thread) => thread.parent_id === unopenedId);
    expect(listed?.kind).toBe('project');
    expect(listed?.title).toBe('Acme rollout');
  });

  it('counts the very first event as new, since nothing else will tell anybody to look', async () => {
    const mine = await member(rosa);
    const firstEventId = 'a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
    coreReturns([{ id: firstEventId, kind: 'lead', title: 'Acme inbound', subtitle: null }]);

    await postSubjectEvent(withCore, { kind: 'lead', id: firstEventId }, 'New lead: Acme inbound');
    const listed = (await list(mine)).find((thread) => thread.parent_id === firstEventId);
    expect(listed?.unread).toBe(true);
    expect(listed?.last_message_preview).toBe('New lead: Acme inbound');

    // A second event on the same, now-existing, subject does not repeat the
    // exception: from here on the ordinary rule (never unread, never
    // reorders) applies, exactly as it does for an event on a channel that
    // already has history.
    await exports.default.fetch(new Request(`http://local/api/threads/${listed!.id}/read`, {
      method: 'POST', headers: mine, body: JSON.stringify({}),
    }));
    await postSubjectEvent(withCore, { kind: 'lead', id: firstEventId }, 'Notes filed: Kickoff');
    const afterSecond = (await list(mine)).find((thread) => thread.parent_id === firstEventId);
    expect(afterSecond?.unread).toBe(false);
  });

  it('still counts the first event as new for a channel opened but never spoken in', async () => {
    const mine = await member(rosa);
    const openedButQuietId = 'd3e4f5a6-7081-4c92-9d3e-2f3a4b5c6d7e';
    coreReturns([{ id: openedButQuietId, kind: 'project', title: 'Acme rollout', subtitle: null }]);

    // Somebody opens the Talk tab on a brand-new project — the shape
    // `WorkPage.tsx`/Mac/iOS all reach for by just viewing a subject. The
    // channel row and the Durable Object both come to exist, with zero
    // messages: not "already has messages", which is exactly what the old
    // `created`-from-`ensureThread` proxy misread it as (envisioning/starlings#43).
    const opened = await openSubjectThread(
      await memberOf(new Request('http://local/api/threads', { method: 'POST', headers: mine })),
      withCore, 'project', openedButQuietId,
    );
    const beforeEvent = (await list(mine)).find((thread) => thread.id === opened.id);
    expect(beforeEvent?.unread).toBe(false);
    expect(beforeEvent?.last_message_at).toBeNull();

    await postSubjectEvent(withCore, { kind: 'project', id: openedButQuietId }, 'New lead: Acme inbound');

    const afterEvent = (await list(mine)).find((thread) => thread.id === opened.id);
    expect(afterEvent?.unread).toBe(true);
    expect(afterEvent?.last_message_preview).toBe('New lead: Acme inbound');
  });

  it('marks a retried first event unread exactly once, not zero times', async () => {
    const mine = await member(rosa);
    const retriedId = 'e4f5a6b7-8192-4da3-8e4f-3a4b5c6d7e8f';
    coreReturns([{ id: retriedId, kind: 'lead', title: 'Acme inbound', subtitle: null }]);

    // As if the first attempt's response never reached the caller: the same
    // idempotency key, sent again.
    await postSubjectEvent(
      withCore, { kind: 'lead', id: retriedId }, 'New lead: Acme inbound', [], { dedupeKey: 'k-threads-retry-1' },
    );
    await postSubjectEvent(
      withCore, { kind: 'lead', id: retriedId }, 'New lead: Acme inbound', [], { dedupeKey: 'k-threads-retry-1' },
    );

    const listed = (await list(mine)).find((thread) => thread.parent_id === retriedId);
    expect(listed?.unread).toBe(true);
    expect(listed?.last_message_preview).toBe('New lead: Acme inbound');

    // Retried, not repeated: exactly one line landed.
    const texts = (await messagesOf(mine, listed!.id)).map((row) => row.text);
    expect(texts).toEqual(['New lead: Acme inbound']);
  });

  it('does not badge the acting user for their own first event, but still badges everyone else', async () => {
    const mine = await member(rosa);
    const theirs = await member(ada);
    const actedId = 'b2c3d4e5-6f70-4b81-9c2d-1e2f3a4b5c6d';
    coreReturns([{ id: actedId, kind: 'project', title: 'Acme rollout', subtitle: null }]);

    // A real human actor did this — the moral equivalent of `sendMessage`'s
    // own `recordRead` call, on the one write where the event's first-ever
    // status would otherwise badge them for their own action.
    await postSubjectEvent(
      withCore,
      { kind: 'project', id: actedId },
      'Rosa filed a meeting here',
      [],
      { actor: { sub: `dev:${rosa.email}`, email: rosa.email } },
    );

    const forActor = (await list(mine)).find((thread) => thread.parent_id === actedId);
    expect(forActor?.unread).toBe(false);

    // Nobody else did anything: the exception still has to reach them.
    const forEveryoneElse = (await list(theirs)).find((thread) => thread.parent_id === actedId);
    expect(forEveryoneElse?.unread).toBe(true);
  });

  it('never counts as unread and never becomes the preview', async () => {
    const mine = await member(rosa);
    const theirs = await member(ada);
    coreReturns([{ id: quietId, kind: 'project', title: 'Acme rollout', subtitle: null }]);
    const thread = await openSubjectThread(
      await memberOf(new Request('http://local/api/threads', { method: 'POST', headers: mine })), withCore, 'project', quietId,
    );
    await send(mine, thread.id, 'Deck is out');

    await postSubjectEvent(withCore, { kind: 'project', id: quietId }, 'Meeting ended after 12 min · notes on their way');

    const forThem = (await list(theirs)).find((row) => row.id === thread.id);
    // Unread because of the text Rosa sent, not because of the event —
    // and the preview is still what a person said.
    expect(forThem?.unread).toBe(true);
    expect(forThem?.last_message_preview).toBe('Deck is out');

    await exports.default.fetch(new Request(`http://local/api/threads/${thread.id}/read`, {
      method: 'POST', headers: theirs, body: JSON.stringify({}),
    }));
    await postSubjectEvent(withCore, { kind: 'project', id: quietId }, 'Notes filed: Kickoff');
    const afterRead = (await list(theirs)).find((row) => row.id === thread.id);
    expect(afterRead?.unread).toBe(false);
    // But the line is there when the channel is opened.
    const texts = (await messagesOf(theirs, thread.id)).map((row) => row.text);
    expect(texts).toEqual(['Deck is out', 'Meeting ended after 12 min · notes on their way', 'Notes filed: Kickoff']);
  });

  it('does nothing while the CRM bridge is off, and nothing for a subject Core does not have', async () => {
    const mine = await member(rosa);
    await postSubjectEvent(env as Env, { kind: 'lead', id: projectId }, 'ghost');
    coreReturns([]);
    await postSubjectEvent(withCore, { kind: 'lead', id: projectId }, 'ghost');
    expect((await list(mine)).some((thread) => thread.parent_id === projectId)).toBe(false);
  });

  it('knows which meetings are filed under a subject', () => {
    expect(subjectOfCategory({ meetingKind: 'project', projectId: 'p', leadId: null })).toEqual({ kind: 'project', id: 'p' });
    expect(subjectOfCategory({ meetingKind: 'lead', projectId: null, leadId: 'l' })).toEqual({ kind: 'lead', id: 'l' });
    expect(subjectOfCategory({ meetingKind: 'partner', projectId: null, leadId: null, partnerOrganizationId: 'o' })).toEqual({ kind: 'organization', id: 'o' });
    expect(subjectOfCategory({ meetingKind: 'partner', projectId: null, leadId: null, partnerOrganizationId: null })).toBeNull();
    expect(subjectOfCategory({ meetingKind: 'status', projectId: 'p', leadId: null })).toBeNull();
    expect(subjectOfCategory({ meetingKind: 'project', projectId: null, leadId: null })).toBeNull();
  });

  it('says how long a meeting ran the way a person would', () => {
    expect(describeDuration(0, 30_000)).toBe('1 min');
    expect(describeDuration(0, 42 * 60_000)).toBe('42 min');
    expect(describeDuration(0, 60 * 60_000)).toBe('1 h');
    expect(describeDuration(0, 65 * 60_000)).toBe('1 h 05 min');
  });
});

describe('archiving a conversation', () => {
  async function archive(headers: Record<string, string>, id: string, archived: boolean) {
    return exports.default.fetch(new Request(`http://local/api/threads/${id}/archive`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ archived }),
    }));
  }

  it('keeps a DM in the list once something is said in it', async () => {
    const mine = await member(rosa);
    await member(ada);
    const opened = await openThread(mine, ada.email);
    // Opening is not having a conversation: an empty DM is somebody you
    // clicked, and it must not earn a permanent row.
    expect(await list(mine)).toHaveLength(0);

    await send(mine, opened.body.thread.id, 'Hey hey');
    const threads = await list(mine);
    expect(threads.map((thread) => thread.id)).toEqual([opened.body.thread.id]);
    expect(threads[0]!.archived_at).toBeNull();
  });

  it('takes it out of the list, and back', async () => {
    const mine = await member(rosa);
    await member(ada);
    const opened = await openThread(mine, ada.email);
    await send(mine, opened.body.thread.id, 'Hey hey');

    expect((await archive(mine, opened.body.thread.id, true)).status).toBe(200);
    expect(await list(mine)).toHaveLength(0);

    expect((await archive(mine, opened.body.thread.id, false)).status).toBe(200);
    expect(await list(mine)).toHaveLength(1);
  });

  it('brings it back when somebody says something new', async () => {
    const mine = await member(rosa);
    const theirs = await member(ada);
    const opened = await openThread(mine, ada.email);
    await send(mine, opened.body.thread.id, 'Hey hey');
    await archive(mine, opened.body.thread.id, true);
    expect(await list(mine)).toHaveLength(0);

    // Nothing unarchives: the new message simply outranks the timestamp, which
    // is what stops an archive from swallowing a live conversation.
    await send(theirs, opened.body.thread.id, 'Still here?');
    const threads = await list(mine);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.archived_at).not.toBeNull();
    expect(threads[0]!.unread).toBe(true);
  });

  it('archives for one member only', async () => {
    const mine = await member(rosa);
    const theirs = await member(ada);
    const opened = await openThread(mine, ada.email);
    await send(mine, opened.body.thread.id, 'Hey hey');

    await archive(mine, opened.body.thread.id, true);
    expect(await list(mine)).toHaveLength(0);
    expect(await list(theirs)).toHaveLength(1);
  });

  it('refuses to archive a channel — every client only offers the control on a DM, and a hidden channel has no way back', async () => {
    const mine = await member(rosa);
    const team = await openTeam(mine);

    const response = await archive(mine, team.body.thread.id, true);
    expect(response.status).toBe(400);
    expect(await list(mine)).toHaveLength(1);
  });
});
