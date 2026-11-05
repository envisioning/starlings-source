import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import type { ThreadMessagesResponse, ThreadSummary, ThreadsResponse } from '@starlings/contracts';
import { recordOwnerSignIn } from '../src/usage';

/**
 * A fresh pair of people per test. The Durable Object behind a DM is addressed
 * by a digest of the two subjects and survives the D1 cleanup below, so reusing
 * one pair would let each test read the messages of every test before it.
 */
let counter = 0;
function people() {
  counter += 1;
  return {
    rosa: { email: `mm-rosa-${counter}@example.com`, name: 'Rosa' },
    ada: { email: `mm-ada-${counter}@example.com`, name: 'Ada' },
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

async function send(headers: Record<string, string>, id: string, body: Record<string, unknown>) {
  const response = await exports.default.fetch(new Request(`http://local/api/threads/${id}/messages`, {
    method: 'POST', headers, body: JSON.stringify(body),
  }));
  return { status: response.status, body: await response.json<{ message: { id: string } }>() };
}

async function read(headers: Record<string, string>, id: string) {
  const response = await exports.default.fetch(
    new Request(`http://local/api/threads/${id}/messages`, { headers }),
  );
  return (await response.json<ThreadMessagesResponse>()).messages;
}

async function react(headers: Record<string, string>, id: string, messageId: string, emoji: string) {
  const response = await exports.default.fetch(
    new Request(`http://local/api/threads/${id}/messages/${messageId}/reactions`, {
      method: 'POST', headers, body: JSON.stringify({ emoji }),
    }),
  );
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}

afterEach(async () => {
  await env.USAGE.prepare('DELETE FROM thread_members').run();
  await env.USAGE.prepare('DELETE FROM threads').run();
  await env.USAGE.prepare("DELETE FROM people WHERE email LIKE 'mm-%'").run();
});

describe('reactions', () => {
  it('adds, aggregates across people, and toggles off', async () => {
    const { rosa, ada } = people();
    const mine = await member(rosa);
    const theirs = await member(ada);
    const thread = await openThread(mine, ada.email);
    const sent = await send(mine, thread.id, { text: 'ship it' });
    const messageId = sent.body.message.id;

    const first = await react(theirs, thread.id, messageId, '🎉');
    expect(first.status).toBe(200);
    await react(mine, thread.id, messageId, '🎉');

    const [message] = await read(mine, thread.id);
    expect(message?.reactions).toEqual([
      { emoji: '🎉', count: 2, is_mine: true, reactors: ['Ada', 'Rosa'] },
    ]);

    // The same call again is the un-react: one press, one row, one route.
    await react(mine, thread.id, messageId, '🎉');
    const [after] = await read(mine, thread.id);
    expect(after?.reactions).toEqual([
      { emoji: '🎉', count: 1, is_mine: false, reactors: ['Ada'] },
    ]);
  });

  it('refuses anything that is not an emoji', async () => {
    const { rosa, ada } = people();
    const mine = await member(rosa);
    await member(ada);
    const thread = await openThread(mine, ada.email);
    const sent = await send(mine, thread.id, { text: 'hello' });

    const response = await react(mine, thread.id, sent.body.message.id, 'lgtm');
    expect(response.status).toBe(400);
  });

  it('never reorders the conversation list or badges anybody', async () => {
    const { rosa, ada } = people();
    const mine = await member(rosa);
    const theirs = await member(ada);
    const thread = await openThread(mine, ada.email);
    const sent = await send(mine, thread.id, { text: 'ship it' });
    await react(theirs, thread.id, sent.body.message.id, '👍');

    const rows = await exports.default.fetch(new Request('http://local/api/threads', { headers: mine }));
    const [summary] = (await rows.json<ThreadsResponse>()).threads;
    expect(summary?.last_message_preview).toBe('ship it');
    expect(summary?.unread).toBe(false);
  });
});

describe('editing and withdrawing', () => {
  it('rewrites your own message and marks it edited', async () => {
    const { rosa, ada } = people();
    const mine = await member(rosa);
    await member(ada);
    const thread = await openThread(mine, ada.email);
    const sent = await send(mine, thread.id, { text: 'teh plan' });

    const response = await exports.default.fetch(
      new Request(`http://local/api/threads/${thread.id}/messages/${sent.body.message.id}`, {
        method: 'PATCH', headers: mine, body: JSON.stringify({ text: 'the plan' }),
      }),
    );
    expect(response.status).toBe(200);

    const [message] = await read(mine, thread.id);
    expect(message?.text).toBe('the plan');
    expect(message?.edited_at).toBeGreaterThan(0);
  });

  it('refuses to let somebody edit a message they did not write', async () => {
    const { rosa, ada } = people();
    const mine = await member(rosa);
    const theirs = await member(ada);
    const thread = await openThread(mine, ada.email);
    const sent = await send(mine, thread.id, { text: 'mine' });

    const response = await exports.default.fetch(
      new Request(`http://local/api/threads/${thread.id}/messages/${sent.body.message.id}`, {
        method: 'PATCH', headers: theirs, body: JSON.stringify({ text: 'not yours' }),
      }),
    );
    // The same 404 a missing message gets: which messages exist is not
    // something to learn by probing.
    expect(response.status).toBe(404);
  });

  it('keeps the row and loses the text when a message is withdrawn', async () => {
    const { rosa, ada } = people();
    const mine = await member(rosa);
    await member(ada);
    const thread = await openThread(mine, ada.email);
    const sent = await send(mine, thread.id, { text: 'said too fast' });

    const response = await exports.default.fetch(
      new Request(`http://local/api/threads/${thread.id}/messages/${sent.body.message.id}`, {
        method: 'DELETE', headers: mine,
      }),
    );
    expect(response.status).toBe(200);

    const messages = await read(mine, thread.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toBe('');
    expect(messages[0]?.deleted_at).toBeGreaterThan(0);
  });

  it('will not react to a withdrawn message', async () => {
    const { rosa, ada } = people();
    const mine = await member(rosa);
    const theirs = await member(ada);
    const thread = await openThread(mine, ada.email);
    const sent = await send(mine, thread.id, { text: 'gone' });
    await exports.default.fetch(
      new Request(`http://local/api/threads/${thread.id}/messages/${sent.body.message.id}`, {
        method: 'DELETE', headers: mine,
      }),
    );

    const response = await react(theirs, thread.id, sent.body.message.id, '👍');
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'message_not_editable' });
  });
});

describe('mentions and muting', () => {
  it('makes a conversation loud for the person named and quiet for the sender', async () => {
    const { rosa, ada } = people();
    const mine = await member(rosa);
    const theirs = await member(ada);
    const thread = await openThread(mine, ada.email);
    await send(mine, thread.id, { text: 'can you look at this', mentions: [ada.email] });

    const forThem = await exports.default.fetch(new Request('http://local/api/threads', { headers: theirs }));
    const [theirRow] = (await forThem.json<ThreadsResponse>()).threads;
    expect(theirRow?.has_mention).toBe(true);
    expect(theirRow?.unread).toBe(true);

    const forMe = await exports.default.fetch(new Request('http://local/api/threads', { headers: mine }));
    const [myRow] = (await forMe.json<ThreadsResponse>()).threads;
    expect(myRow?.has_mention).toBe(false);
  });

  it('clears the mention when the conversation is read', async () => {
    const { rosa, ada } = people();
    const mine = await member(rosa);
    const theirs = await member(ada);
    const thread = await openThread(mine, ada.email);
    await send(mine, thread.id, { text: 'ping', mentions: [ada.email] });

    await exports.default.fetch(new Request(`http://local/api/threads/${thread.id}/read`, {
      method: 'POST', headers: theirs, body: JSON.stringify({}),
    }));

    const response = await exports.default.fetch(new Request('http://local/api/threads', { headers: theirs }));
    const [row] = (await response.json<ThreadsResponse>()).threads;
    expect(row?.has_mention).toBe(false);
    expect(row?.unread).toBe(false);
  });

  it('drops a mention of somebody who is not in the conversation', async () => {
    const { rosa, ada } = people();
    const mine = await member(rosa);
    await member(ada);
    const thread = await openThread(mine, ada.email);
    // A stale address is a typo, not a failed send.
    const sent = await send(mine, thread.id, { text: 'hi', mentions: ['nobody@example.com'] });
    expect(sent.status).toBe(201);
  });

  it('mutes per member, and reports the expiry back', async () => {
    const { rosa, ada } = people();
    const mine = await member(rosa);
    const theirs = await member(ada);
    const thread = await openThread(mine, ada.email);
    // An unspoken DM is not in anybody's list, so give it something to be
    // muted about — this is a test about mute, not about listing.
    await send(mine, thread.id, { text: 'hi' });
    const until = Date.now() + 3_600_000;

    await exports.default.fetch(new Request(`http://local/api/threads/${thread.id}/mute`, {
      method: 'POST', headers: theirs, body: JSON.stringify({ until }),
    }));

    const forThem = await exports.default.fetch(new Request('http://local/api/threads', { headers: theirs }));
    expect((await forThem.json<ThreadsResponse>()).threads[0]?.muted_until).toBe(until);
    const forMe = await exports.default.fetch(new Request('http://local/api/threads', { headers: mine }));
    expect((await forMe.json<ThreadsResponse>()).threads[0]?.muted_until).toBeNull();
  });
});

describe('refs on what a person typed', () => {
  it('carries the task a message was composed from', async () => {
    const { rosa, ada } = people();
    const mine = await member(rosa);
    await member(ada);
    const thread = await openThread(mine, ada.email);
    await send(mine, thread.id, {
      text: 'this one is blocked',
      refs: [{ kind: 'task', id: 'task-42' }],
    });

    const [message] = await read(mine, thread.id);
    expect(message?.refs).toEqual([{ kind: 'task', id: 'task-42' }]);
  });

  it('refuses a message with neither text nor a file', async () => {
    const { rosa, ada } = people();
    const mine = await member(rosa);
    await member(ada);
    const thread = await openThread(mine, ada.email);
    const sent = await send(mine, thread.id, { text: '   ' });
    expect(sent.status).toBe(400);
  });
});

describe('read state', () => {
  it('reports where the reader left off, not just that there is something new', async () => {
    const { rosa, ada } = people();
    const mine = await member(rosa);
    const theirs = await member(ada);
    const thread = await openThread(mine, ada.email);
    await send(mine, thread.id, { text: 'first' });

    const before = await exports.default.fetch(new Request('http://local/api/threads', { headers: theirs }));
    const [row] = (await before.json<ThreadsResponse>()).threads;
    // The divider needs the timestamp; a boolean cannot say *where*.
    expect(row?.last_read_at).toBe(0);
    expect(row?.unread).toBe(true);
  });
});

describe('attachments', () => {
  async function stage(headers: Record<string, string>, id: string, file: Record<string, unknown>) {
    const response = await exports.default.fetch(new Request(`http://local/api/threads/${id}/attachments`, {
      method: 'POST', headers, body: JSON.stringify(file),
    }));
    return {
      status: response.status,
      body: await response.json<{ attachment: { id: string; content_type: string }; upload_path: string }>(),
    };
  }

  async function upload(headers: Record<string, string>, path: string, bytes: number[]) {
    return exports.default.fetch(new Request(`http://local${path}`, {
      method: 'PUT',
      headers: { authorization: headers.authorization ?? '', 'content-type': 'application/octet-stream' },
      body: new Uint8Array(bytes).buffer,
    }));
  }

  it('stages, uploads, sends, and serves a file to the other member', async () => {
    const { rosa, ada } = people();
    const mine = await member(rosa);
    const theirs = await member(ada);
    const thread = await openThread(mine, ada.email);

    const staged = await stage(mine, thread.id, {
      name: 'plan.png', content_type: 'image/png', bytes: 4, width: 2, height: 2,
    });
    expect(staged.status).toBe(201);
    const bytes = [1, 2, 3, 4];
    expect((await upload(mine, staged.body.upload_path, bytes)).status).toBe(200);

    const sent = await send(mine, thread.id, { text: 'here', attachments: [staged.body.attachment.id] });
    expect(sent.status).toBe(201);

    const [message] = await read(theirs, thread.id);
    expect(message?.attachments).toEqual([
      { id: staged.body.attachment.id, name: 'plan.png', content_type: 'image/png', bytes: 4, width: 2, height: 2 },
    ]);

    const served = await exports.default.fetch(
      new Request(`http://local/api/threads/${thread.id}/attachments/${staged.body.attachment.id}`, {
        headers: { authorization: theirs.authorization ?? '' },
      }),
    );
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('serves an unlisted type as a download rather than something to render', async () => {
    const { rosa, ada } = people();
    const mine = await member(rosa);
    await member(ada);
    const thread = await openThread(mine, ada.email);

    const staged = await stage(mine, thread.id, {
      name: 'run.html', content_type: 'text/html', bytes: 3,
    });
    // Nothing a colleague uploads may execute on an origin that serves the app.
    expect(staged.body.attachment.content_type).toBe('application/octet-stream');
    await upload(mine, staged.body.upload_path, [1, 2, 3]);
    await send(mine, thread.id, { text: 'file', attachments: [staged.body.attachment.id] });

    const served = await exports.default.fetch(
      new Request(`http://local/api/threads/${thread.id}/attachments/${staged.body.attachment.id}`, {
        headers: { authorization: mine.authorization ?? '' },
      }),
    );
    expect(served.headers.get('content-type')).toBe('application/octet-stream');
    expect(served.headers.get('content-disposition')).toContain('attachment;');
  });

  it('refuses more bytes than were reserved', async () => {
    const { rosa, ada } = people();
    const mine = await member(rosa);
    await member(ada);
    const thread = await openThread(mine, ada.email);
    const staged = await stage(mine, thread.id, { name: 'small.bin', content_type: 'text/plain', bytes: 2 });

    const response = await upload(mine, staged.body.upload_path, [1, 2, 3, 4, 5]);
    expect(response.status).toBe(413);
  });

  it('will not let somebody attach a file they did not stage', async () => {
    const { rosa, ada } = people();
    const mine = await member(rosa);
    const theirs = await member(ada);
    const thread = await openThread(mine, ada.email);
    const staged = await stage(mine, thread.id, { name: 'mine.txt', content_type: 'text/plain', bytes: 2 });
    await upload(mine, staged.body.upload_path, [1, 2]);

    // Silently attaches nothing rather than moving somebody else's file.
    await send(theirs, thread.id, { text: 'not mine', attachments: [staged.body.attachment.id] });
    const messages = await read(theirs, thread.id);
    expect(messages.at(-1)?.attachments).toBeUndefined();
  });

  it('takes the file away with the message that carried it', async () => {
    const { rosa, ada } = people();
    const mine = await member(rosa);
    await member(ada);
    const thread = await openThread(mine, ada.email);
    const staged = await stage(mine, thread.id, { name: 'oops.txt', content_type: 'text/plain', bytes: 2 });
    await upload(mine, staged.body.upload_path, [1, 2]);
    const sent = await send(mine, thread.id, { text: 'oops', attachments: [staged.body.attachment.id] });

    await exports.default.fetch(
      new Request(`http://local/api/threads/${thread.id}/messages/${sent.body.message.id}`, {
        method: 'DELETE', headers: mine,
      }),
    );

    const served = await exports.default.fetch(
      new Request(`http://local/api/threads/${thread.id}/attachments/${staged.body.attachment.id}`, {
        headers: { authorization: mine.authorization ?? '' },
      }),
    );
    expect(served.status).toBe(404);
  });

  it('returns the sender their own message with the file already on it', async () => {
    const { rosa, ada } = people();
    const mine = await member(rosa);
    await member(ada);
    const thread = await openThread(mine, ada.email);
    const staged = await stage(mine, thread.id, { name: 'note.txt', content_type: 'text/plain', bytes: 2 });
    await upload(mine, staged.body.upload_path, [1, 2]);

    const response = await exports.default.fetch(new Request(`http://local/api/threads/${thread.id}/messages`, {
      method: 'POST', headers: mine,
      body: JSON.stringify({ text: 'see this', attachments: [staged.body.attachment.id] }),
    }));
    const body = await response.json<{ message: { attachments?: unknown[] } }>();
    expect(body.message.attachments).toHaveLength(1);
  });
});
