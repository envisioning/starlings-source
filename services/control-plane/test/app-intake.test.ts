import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InboxResponse, ThreadMessagesResponse } from '@starlings/contracts';
import { MESSAGE_TEXT_MAX_CHARS } from '@starlings/contracts/limits';
import worker from '../src/index';
import { appIntakeThreadId } from '../src/app-intake';
import { hmacSHA256Hex } from '../src/crypto';
import { recordOwnerSignIn } from '../src/usage';

/**
 * The app channel door (#1176): a workspace's backend sends an app user's line, signed
 * `intake`; a member's reply goes back, signed `reply`. The wire is fixed
 * with that backend, so these cases pin the headers and the signed string.
 */

const KEY = '0123456789abcdef'.repeat(4);
/** Both sides key the HMAC with the 32 bytes the hex decodes to, not the hex text. */
const KEY_BYTES = Uint8Array.from(KEY.match(/../gu)!, (pair) => parseInt(pair, 16));
const REPLY_URL = 'https://acme-api.test/v1/support/starlings';

const configured = {
  ...env,
  APP_INTAKE_KEY: { get: async () => KEY },
  APP_INTAKE_REPLY_URL: REPLY_URL,
  APP_INTAKE_ALLOWED_ATTACHMENT_HOSTS: 'api.acme.test',
} as unknown as Env;

const refs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const ref of refs.splice(0)) {
    const threadId = await appIntakeThreadId(ref);
    await env.USAGE.prepare('DELETE FROM app_intake_threads WHERE thread_id = ?1').bind(threadId).run();
    await env.USAGE.prepare('DELETE FROM threads WHERE id = ?1').bind(threadId).run();
  }
});

async function dispatch(request: Request, environment: Env = configured): Promise<Response> {
  const context = createExecutionContext();
  const response = await worker.fetch(request, environment, context);
  await waitOnExecutionContext(context);
  return response;
}

async function intake(
  body: unknown,
  options: { key?: string | Uint8Array<ArrayBuffer>; timestamp?: number; direction?: string; environment?: Env } = {},
): Promise<Response> {
  const raw = JSON.stringify(body);
  const timestamp = String(options.timestamp ?? Date.now());
  const signature = await hmacSHA256Hex(options.key ?? KEY_BYTES, `${options.direction ?? 'intake'}.${timestamp}.${raw}`);
  return dispatch(new Request('http://local/api/support/app-intake', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Starlings-Timestamp': timestamp, 'X-Starlings-Signature': signature },
    body: raw,
  }), options.environment);
}

function reporterRef(): string {
  const ref = `@app-intake-${crypto.randomUUID()}:acme.test`;
  refs.push(ref);
  return ref;
}

async function adminHeaders(): Promise<Record<string, string>> {
  const person = { email: 'rosa@example.com', name: 'Rosa' };
  const response = await dispatch(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(person),
  }));
  const { access_token } = await response.json<{ access_token: string }>();
  await recordOwnerSignIn(configured, { sub: `dev:${person.email}`, ...person }, 'mac');
  return { authorization: `Bearer ${access_token}`, 'content-type': 'application/json', origin: configured.WEB_ORIGIN };
}

async function lines(threadId: string, headers: Record<string, string>): Promise<ThreadMessagesResponse['messages']> {
  const response = await dispatch(new Request(`http://local/api/threads/${threadId}/messages`, { headers }));
  expect(response.status).toBe(200);
  return (await response.json<ThreadMessagesResponse>()).messages;
}

describe('the app channel door', () => {
  it('makes one line and one INBOX row from a signed report, and nothing from a repeat', async () => {
    const ref = reporterRef();
    const body = {
      message_id: `report:${crypto.randomUUID()}`,
      kind: 'report',
      reporter: { ref, handle: 'ana', name: 'Ana Souza' },
      text: 'The app closes when I open a chat.',
      report: {
        platform: 'ios', app_version: '26.10.1', build: 123, labels: ['crash'],
        has_logs: true, screenshot_count: 1, attachments_url: 'https://api.acme.test/v1/admin/bug-reports/1',
      },
    };
    const first = await intake(body);
    expect(first.status).toBe(200);
    const answer = await first.json<{ ok: boolean; thread_id: string }>();
    expect(answer).toEqual({ ok: true, thread_id: await appIntakeThreadId(ref) });

    const again = await intake(body);
    expect(await again.json()).toEqual(answer);

    const headers = await adminHeaders();
    const messages = await lines(answer.thread_id, headers);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.origin).toBe('app');
    expect(messages[0]!.sender_name).toBe('Ana Souza');
    expect(messages[0]!.text).toBe('The app closes when I open a chat.\n\niOS · 26.10.1 (123) · crash · logs yes · 1 screenshot · https://api.acme.test/v1/admin/bug-reports/1');

    const inbox = await dispatch(new Request('http://local/api/crm/inbox', { headers }));
    const rows = (await inbox.json<InboxResponse>()).items.filter((item) => item.source === 'guest' && item.thread_id === answer.thread_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ origin: 'app', subject: { kind: 'organization', id: 'intake', title: 'App · Ana Souza' } });
  });

  it('writes nothing for a bad signature, an old timestamp, the reply direction or a foreign attachment host', async () => {
    const ref = reporterRef();
    const message = { message_id: `$event-${crypto.randomUUID()}`, kind: 'message', reporter: { ref }, text: 'Oi' };
    expect((await intake(message, { key: Uint8Array.from(KEY_BYTES, (byte) => byte ^ 1) })).status).toBe(401);
    // The hex text as UTF-8 is the wrong key.
    expect((await intake(message, { key: KEY })).status).toBe(401);
    expect((await intake(message, { timestamp: Date.now() - 6 * 60 * 1000 })).status).toBe(401);
    expect((await intake(message, { direction: 'reply' })).status).toBe(401);
    const foreign = {
      ...message, kind: 'report',
      report: { platform: 'android', has_logs: false, screenshot_count: 0, labels: [], attachments_url: 'https://elsewhere.test/x' },
    };
    expect((await intake(foreign)).status).toBe(400);
    expect((await intake({ ...message, kind: 'report' })).status).toBe(400);
    const row = await env.USAGE.prepare('SELECT 1 FROM app_intake_threads WHERE thread_id = ?1').bind(await appIntakeThreadId(ref)).first();
    expect(row).toBeNull();
  });

  it('takes a message up to 10,000 characters and clips the line to the message limit', async () => {
    const ref = reporterRef();
    const sent = await intake({ message_id: `$event-${crypto.randomUUID()}`, kind: 'message', reporter: { ref }, text: 'x'.repeat(10_000) });
    expect(sent.status).toBe(200);
    const { thread_id: threadId } = await sent.json<{ thread_id: string }>();
    const [line] = await lines(threadId, await adminHeaders());
    expect(line!.text).toHaveLength(MESSAGE_TEXT_MAX_CHARS);
    expect(line!.text.endsWith('…')).toBe(true);
    expect((await intake({ message_id: 'long', kind: 'message', reporter: { ref }, text: 'x'.repeat(10_001) })).status).toBe(400);
  });

  it('answers not_configured without the key', async () => {
    const response = await intake({ message_id: 'm', kind: 'message', reporter: { ref: reporterRef() }, text: 'Oi' }, { environment: env as Env });
    expect(response.status).toBe(503);
    expect((await response.json<{ code: string }>()).code).toBe('not_configured');
  });

  it('sends a member reply back once, signed reply, and retries a 5xx', async () => {
    const ref = reporterRef();
    const sent = await intake({ message_id: `$event-${crypto.randomUUID()}`, kind: 'message', reporter: { ref, name: 'Ana' }, text: 'Oi, preciso de ajuda' });
    const { thread_id: threadId } = await sent.json<{ thread_id: string }>();

    const calls: Array<{ url: string; headers: Headers; body: string }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push({ url, headers: new Headers(init?.headers), body: String(init?.body) });
      return new Response(null, { status: calls.length === 1 ? 502 : 204 });
    });

    const headers = await adminHeaders();
    const reply = await dispatch(new Request(`http://local/api/threads/${threadId}/messages`, {
      method: 'POST', headers, body: JSON.stringify({ text: 'Olá Ana, vamos ver.' }),
    }));
    expect(reply.status).toBe(201);
    const { message } = await reply.json<{ message: { id: string } }>();

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.url).toBe(REPLY_URL);
      const timestamp = call.headers.get('x-starlings-timestamp')!;
      expect(call.headers.get('x-starlings-signature')).toBe(await hmacSHA256Hex(KEY_BYTES, `reply.${timestamp}.${call.body}`));
      expect(JSON.parse(call.body)).toEqual({ message_id: message.id, reporter_ref: ref, text: 'Olá Ana, vamos ver.', author: { name: 'Rosa' } });
    }

    // An edit is not a new line: nothing goes out.
    calls.length = 0;
    await dispatch(new Request(`http://local/api/threads/${threadId}/messages/${message.id}`, {
      method: 'PATCH', headers, body: JSON.stringify({ text: 'Olá Ana, já vamos ver.' }),
    }));
    expect(calls).toHaveLength(0);
  }, 30_000);
});
