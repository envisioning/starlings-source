import { env, exports } from 'cloudflare:workers';
import { SignJWT } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import type { ThreadMessagesResponse, ThreadSummary } from '@starlings/contracts';
import { signingKey } from '../src/crypto';
import { recordOwnerSignIn } from '../src/usage';

/**
 * A message a member's Claude sends through `send_message` is still the
 * member's, tagged "via <client>" (meet#713). The tag is read from the
 * borrowed session token the MCP layer mints, never from the request body.
 */

const rosa = { email: 'via-rosa@example.com', name: 'Rosa' };
const ada = { email: 'via-ada@example.com', name: 'Ada' };
// The DM's id is derived from the pair, and the thread's Durable Object
// outlives the D1 cleanup, so each case talks to somebody else.
const kim = { email: 'via-kim@example.com', name: 'Kim' };

async function member(person: { email: string; name: string }) {
  const response = await exports.default.fetch(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(person),
  }));
  const body = await response.json<{ access_token: string }>();
  await recordOwnerSignIn(env as Env, { sub: `dev:${person.email}`, ...person }, 'mac');
  return { authorization: `Bearer ${body.access_token}`, 'content-type': 'application/json' };
}

async function mcpBearer(person: { email: string; name: string }, clientName: string): Promise<string> {
  const suffix = crypto.randomUUID();
  const now = Date.now();
  await env.USAGE.prepare(
    `INSERT INTO mcp_clients (client_id, client_name, client_uri, redirect_uris, created_at)
     VALUES (?1, ?2, NULL, '["https://claude.ai/api/mcp/auth_callback"]', ?3)`,
  ).bind(`via-${suffix}`, clientName, now).run();
  await env.USAGE.prepare(
    `INSERT INTO mcp_grants (id, client_id, sub, email, scope, refresh_jti, previous_refresh_jti, renewed_at, created_at, last_call_at, revoked_at)
     VALUES (?1, ?2, ?3, ?4, 'read write', 'jti', NULL, ?5, ?5, NULL, NULL)`,
  ).bind(`via-${suffix}`, `via-${suffix}`, `dev:${person.email}`, person.email, now).run();
  return new SignJWT({ email: person.email, name: person.name, scope: 'read write', grant: `via-${suffix}`, client: `via-${suffix}` })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('starlings.example')
    .setAudience('meet-mcp')
    .setSubject(`dev:${person.email}`)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(signingKey((env as Env).SESSION_SIGNING_SECRET));
}

async function openThread(headers: Record<string, string>, peerEmail: string): Promise<string> {
  const response = await exports.default.fetch(new Request('http://local/api/threads', {
    method: 'POST',
    headers,
    body: JSON.stringify({ peer_email: peerEmail }),
  }));
  return (await response.json<{ thread: ThreadSummary }>()).thread.id;
}

async function read(headers: Record<string, string>, threadId: string) {
  const response = await exports.default.fetch(new Request(`http://local/api/threads/${threadId}/messages`, { headers }));
  return (await response.json<ThreadMessagesResponse>()).messages;
}

afterEach(async () => {
  await env.USAGE.prepare('DELETE FROM thread_members').run();
  await env.USAGE.prepare('DELETE FROM threads').run();
  await env.USAGE.prepare("DELETE FROM people WHERE email LIKE 'via-%'").run();
});

describe('send_message via tag', () => {
  it('tags a message sent through MCP with the client, and keeps the sender', async () => {
    const mine = await member(rosa);
    const theirs = await member(ada);
    const threadId = await openThread(mine, ada.email);
    const token = await mcpBearer(rosa, 'claude.ai');

    const response = await exports.default.fetch(new Request('http://local/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'send_message', arguments: { thread_id: threadId, text: 'drafted by my Claude' } },
      }),
    }));
    const answer = await response.json<{ result?: { isError?: boolean } }>();
    expect(answer.result?.isError).not.toBe(true);

    const [message] = await read(theirs, threadId);
    expect(message).toMatchObject({ text: 'drafted by my Claude', sender_email: rosa.email, is_mine: false, via: 'claude.ai' });

    // The member fixing a word by hand does not make it theirs alone: the tag stays.
    const edited = await exports.default.fetch(new Request(`http://local/api/threads/${threadId}/messages/${message!.id}`, {
      method: 'PATCH',
      headers: mine,
      body: JSON.stringify({ text: 'drafted by my Claude, fixed' }),
    }));
    expect(edited.status).toBe(200);
    const [after] = await read(theirs, threadId);
    expect(after).toMatchObject({ text: 'drafted by my Claude, fixed', via: 'claude.ai' });
    expect(after!.edited_at).toBeTypeOf('number');
  });

  it('leaves a message typed with a normal session untagged, and ignores a via in the body', async () => {
    const mine = await member(rosa);
    const theirs = await member(kim);
    const threadId = await openThread(mine, kim.email);

    const typed = await exports.default.fetch(new Request(`http://local/api/threads/${threadId}/messages`, {
      method: 'POST',
      headers: mine,
      body: JSON.stringify({ text: 'typed by hand' }),
    }));
    expect(typed.status).toBe(201);
    expect((await typed.json<{ message: { via?: string } }>()).message.via).toBeUndefined();

    const forged = await exports.default.fetch(new Request(`http://local/api/threads/${threadId}/messages`, {
      method: 'POST',
      headers: mine,
      body: JSON.stringify({ text: 'pretending', via: 'claude.ai' }),
    }));
    expect(forged.status).toBe(201);

    const messages = await read(theirs, threadId);
    expect(messages.map((message) => message.text)).toEqual(['typed by hand', 'pretending']);
    expect(messages.every((message) => message.via === undefined)).toBe(true);
  });
});
