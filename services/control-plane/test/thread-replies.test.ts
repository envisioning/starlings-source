import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import type { ThreadMessage, ThreadMessagesResponse, ThreadSummary } from '@starlings/contracts';
import { recordOwnerSignIn } from '../src/usage';
import type { ThreadCoordinator } from '../src/thread-coordinator';

let counter = 0;
function people() {
  counter += 1;
  return {
    rosa: { email: `reply-rosa-${counter}@example.com`, name: 'Rosa' },
    ada: { email: `reply-ada-${counter}@example.com`, name: 'Ada' },
    kim: { email: `reply-kim-${counter}@example.com`, name: 'Kim' },
  };
}

async function session(email: string, name: string) {
  const response = await exports.default.fetch(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, email }),
  }));
  const body = await response.json<{ access_token: string }>();
  return { authorization: `Bearer ${body.access_token}`, 'content-type': 'application/json' };
}

async function member(person: { email: string; name: string }) {
  const headers = await session(person.email, person.name);
  await recordOwnerSignIn(env as Env, { sub: `dev:${person.email}`, ...person }, 'mac');
  return headers;
}

async function openThread(headers: Record<string, string>, peerEmail: string) {
  const response = await exports.default.fetch(new Request('http://local/api/threads', {
    method: 'POST', headers, body: JSON.stringify({ peer_email: peerEmail }),
  }));
  return (await response.json<{ thread: ThreadSummary }>()).thread;
}

async function send(headers: Record<string, string>, threadId: string, body: Record<string, unknown>) {
  const response = await exports.default.fetch(new Request(`http://local/api/threads/${threadId}/messages`, {
    method: 'POST', headers, body: JSON.stringify(body),
  }));
  return {
    status: response.status,
    body: await response.json<{ message?: ThreadMessage; code?: string; error?: string }>(),
  };
}

async function read(headers: Record<string, string>, threadId: string, query = '') {
  const response = await exports.default.fetch(new Request(
    `http://local/api/threads/${threadId}/messages${query}`,
    { headers },
  ));
  return { status: response.status, body: await response.json<ThreadMessagesResponse>() };
}

async function listThread(headers: Record<string, string>, threadId: string) {
  const response = await exports.default.fetch(new Request('http://local/api/threads', { headers }));
  const body = await response.json<{ threads: ThreadSummary[] }>();
  return body.threads.find((thread) => thread.id === threadId);
}

async function waitForDistinctMessageTime() {
  await new Promise((resolve) => setTimeout(resolve, 2));
}

afterEach(async () => {
  await env.USAGE.prepare('DELETE FROM thread_members').run();
  await env.USAGE.prepare('DELETE FROM threads').run();
  await env.USAGE.prepare("DELETE FROM people WHERE email LIKE 'reply-%'").run();
});

describe('message replies', () => {
  it('keeps reply unread state on the conversation', async () => {
    const { rosa, ada } = people();
    const mine = await member(rosa);
    const theirs = await member(ada);
    const thread = await openThread(mine, ada.email);
    const parent = await send(mine, thread.id, { text: 'Context for the reply' });
    const initialRead = await exports.default.fetch(new Request(`http://local/api/threads/${thread.id}/read`, {
      method: 'POST', headers: theirs, body: JSON.stringify({}),
    }));
    expect(initialRead.status).toBe(200);
    expect(await listThread(theirs, thread.id)).toMatchObject({ unread: false });

    const reply = await send(mine, thread.id, {
      text: 'Following up in the same conversation',
      reply_to_message_id: parent.body.message!.id,
    });

    expect(reply.status).toBe(201);
    expect(reply.body.message?.reply_to_message_id).toBe(parent.body.message?.id);
    expect(await listThread(theirs, thread.id)).toMatchObject({ unread: true });
    expect(await listThread(mine, thread.id)).toMatchObject({ unread: false });

    const markedRead = await exports.default.fetch(new Request(`http://local/api/threads/${thread.id}/read`, {
      method: 'POST', headers: theirs, body: JSON.stringify({}),
    }));
    expect(markedRead.status).toBe(200);
    expect(await listThread(theirs, thread.id)).toMatchObject({ unread: false });
  });

  it('stores replies to roots and replies, and keeps the parent on paginated reads', async () => {
    const { rosa, ada } = people();
    const mine = await member(rosa);
    await member(ada);
    const thread = await openThread(mine, ada.email);

    const root = await send(mine, thread.id, { text: 'Root message' });
    expect(root.status).toBe(201);
    const rootId = root.body.message!.id;
    await waitForDistinctMessageTime();

    const reply = await send(mine, thread.id, { text: 'First reply', reply_to_message_id: rootId });
    expect(reply.status).toBe(201);
    expect(reply.body.message?.reply_to_message_id).toBe(rootId);
    const replyId = reply.body.message!.id;
    await waitForDistinctMessageTime();

    const nested = await send(mine, thread.id, { text: 'Reply to the reply', reply_to_message_id: replyId });
    expect(nested.status).toBe(201);
    expect(nested.body.message?.reply_to_message_id).toBe(replyId);

    const all = await read(mine, thread.id);
    expect(all.body.messages.map((message) => [message.text, message.reply_to_message_id])).toEqual([
      ['Root message', null],
      ['First reply', rootId],
      ['Reply to the reply', replyId],
    ]);

    const newest = await read(mine, thread.id, '?limit=1');
    expect(newest.body.messages[0]?.id).toBe(nested.body.message?.id);
    expect(newest.body.messages[0]?.reply_to_message_id).toBe(replyId);
    const previous = await read(mine, thread.id, `?before=${encodeURIComponent(newest.body.older_cursor!)}&limit=1`);
    expect(previous.body.messages[0]?.id).toBe(replyId);
    expect(previous.body.messages[0]?.reply_to_message_id).toBe(rootId);
  });

  it('rejects malformed, missing, cross-thread, event, withdrawn, and unfinished parents consistently', async () => {
    const { rosa, ada, kim } = people();
    const mine = await member(rosa);
    await member(ada);
    await member(kim);
    const first = await openThread(mine, ada.email);
    const second = await openThread(mine, kim.email);
    const root = await send(mine, first.id, { text: 'Parent in the first conversation' });
    const rootId = root.body.message!.id;

    const malformed = await send(mine, first.id, { text: 'bad value', reply_to_message_id: 42 });
    expect(malformed.status).toBe(400);
    expect(malformed.body.code).toBe('invalid_request');

    const missing = await send(mine, first.id, { text: 'missing', reply_to_message_id: 'msg_missing_parent' });
    expect(missing.status).toBe(409);
    expect(missing.body.code).toBe('message_not_replyable');

    const crossThread = await send(mine, second.id, { text: 'wrong conversation', reply_to_message_id: rootId });
    expect(crossThread.status).toBe(409);
    expect(crossThread.body.code).toBe(missing.body.code);

    const stub = env.THREADS.getByName(first.id) as DurableObjectStub<ThreadCoordinator>;
    const sender = { sub: `dev:${rosa.email}`, ...rosa };
    const event = await stub.append(sender, 'System event', 'event_reply_parent_1', Date.now(), 'event');
    expect(event.inserted).toBe(true);
    const systemParent = await send(mine, first.id, { text: 'not a reply target', reply_to_message_id: event.id });
    expect(systemParent.status).toBe(409);
    expect(systemParent.body.code).toBe(missing.body.code);

    const unfinished = await stub.append(
      sender, 'Still streaming', 'msg_partial_parent_1', Date.now(), 'text', [], { partial: true },
    );
    expect(unfinished.inserted).toBe(true);
    const partialParent = await send(mine, first.id, { text: 'not stable yet', reply_to_message_id: unfinished.id });
    expect(partialParent.status).toBe(409);
    expect(partialParent.body.code).toBe(missing.body.code);

    await exports.default.fetch(new Request(`http://local/api/threads/${first.id}/messages/${rootId}`, {
      method: 'DELETE', headers: mine,
    }));
    const withdrawn = await send(mine, first.id, { text: 'parent was withdrawn', reply_to_message_id: rootId });
    expect(withdrawn.status).toBe(409);
    expect(withdrawn.body.code).toBe(missing.body.code);
  });

  it('preserves parent links through edits and withdrawals while redacting withdrawn content and files', async () => {
    const { rosa, ada } = people();
    const mine = await member(rosa);
    await member(ada);
    const thread = await openThread(mine, ada.email);
    const stub = env.THREADS.getByName(thread.id) as DurableObjectStub<ThreadCoordinator>;
    const ownerSub = `dev:${rosa.email}`;
    const attachmentId = `attachment_reply_${counter}`;
    await stub.stageAttachment(ownerSub, {
      id: attachmentId,
      name: 'private.txt',
      contentType: 'text/plain',
      bytes: 12,
    }, Date.now());

    const parent = await send(mine, thread.id, { text: 'Private parent text', attachments: [attachmentId] });
    const parentId = parent.body.message!.id;
    const child = await send(mine, thread.id, { text: 'Child reply', reply_to_message_id: parentId });
    const childId = child.body.message!.id;

    const initial = await read(mine, thread.id);
    expect(initial.body.messages.find((message) => message.id === parentId)?.attachments).toHaveLength(1);

    for (const [messageId, text] of [[parentId, 'Edited parent'], [childId, 'Edited child']] as const) {
      const edited = await exports.default.fetch(new Request(
        `http://local/api/threads/${thread.id}/messages/${messageId}`,
        { method: 'PATCH', headers: mine, body: JSON.stringify({ text }) },
      ));
      expect(edited.status).toBe(200);
    }

    const parentWithdrawal = await exports.default.fetch(new Request(
      `http://local/api/threads/${thread.id}/messages/${parentId}`,
      { method: 'DELETE', headers: mine },
    ));
    expect(parentWithdrawal.status).toBe(200);

    const afterParentWithdrawal = await read(mine, thread.id);
    const withdrawnParent = afterParentWithdrawal.body.messages.find((message) => message.id === parentId);
    const stillLiveChild = afterParentWithdrawal.body.messages.find((message) => message.id === childId);
    expect(withdrawnParent).toMatchObject({ text: '', reply_to_message_id: null });
    expect(withdrawnParent?.attachments).toBeUndefined();
    expect(stillLiveChild).toMatchObject({ text: 'Edited child', reply_to_message_id: parentId });

    const childWithdrawal = await exports.default.fetch(new Request(
      `http://local/api/threads/${thread.id}/messages/${childId}`,
      { method: 'DELETE', headers: mine },
    ));
    expect(childWithdrawal.status).toBe(200);

    const after = await read(mine, thread.id);
    const storedParent = after.body.messages.find((message) => message.id === parentId);
    const storedChild = after.body.messages.find((message) => message.id === childId);
    expect(storedParent).toMatchObject({ text: '', reply_to_message_id: null });
    expect(storedParent?.deleted_at).toBeGreaterThan(0);
    expect(storedParent?.attachments).toBeUndefined();
    expect(storedChild).toMatchObject({ text: '', reply_to_message_id: parentId });
    expect(storedChild?.deleted_at).toBeGreaterThan(0);
  });
});
