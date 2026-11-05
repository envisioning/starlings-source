import { env, exports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AttentionResolveResponse, InternalChannelEventResponse, ThreadMessage, ThreadMessagesResponse, ThreadSummary } from '@starlings/contracts';
import { agentSub, attentionRequestID } from '@starlings/contracts';
import { pendingAttentionRequests, readAttentionRequest, resolveAttentionRequest } from '../src/attention-requests';
import type { ThreadCoordinator } from '../src/thread-coordinator';
import { recordOwnerSignIn } from '../src/usage';

let serial = 0;
const vocabEmail = 'agent-vocab@example.com';
// Vocab's own inbound key (vitest.config.ts).
const secret = 'vocab-inbound-test-key-with-at-least-32-characters';

async function sign(timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function member() {
  serial += 1;
  const person = { email: `question-${serial}@example.com`, name: 'Ada' };
  const response = await exports.default.fetch(new Request('http://local/api/dev/session', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(person),
  }));
  const body = await response.json<{ access_token: string }>();
  await recordOwnerSignIn(env as Env, { sub: `dev:${person.email}`, ...person }, 'mac');
  return { headers: { authorization: `Bearer ${body.access_token}`, 'content-type': 'application/json' }, person };
}

async function questionThread(headers: Record<string, string>, mode: 'single' | 'multiple' = 'multiple', existingThread?: ThreadSummary, recipient?: string, expectedStatus = 200) {
  const opened = existingThread ? null : await exports.default.fetch(new Request('http://local/api/threads', {
    method: 'POST', headers, body: JSON.stringify({ peer_email: vocabEmail }),
  }));
  const thread = existingThread ?? (await opened!.json<{ thread: ThreadSummary }>()).thread;
  const event = {
    question_recipient_email: recipient, thread_id: thread.id, type: 'text', sender: vocabEmail, text: 'Which direction should I take?',
    idempotency_key: `interactive-question-${serial}-ask`,
    question: { mode, options: [
      { id: 'concise', label: 'Keep it concise' },
      { id: 'detailed', label: 'Add more detail' },
      { id: 'examples', label: 'Include examples' },
    ] },
  };
  const raw = JSON.stringify(event);
  const timestamp = String(Date.now());
  const inbound = await exports.default.fetch(new Request('http://local/api/internal/channel-events', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-key-id': vocabEmail, 'x-internal-timestamp': timestamp, 'x-internal-signature': await sign(timestamp, raw) },
    body: raw,
  }));
  expect(inbound.status).toBe(expectedStatus);
  if (expectedStatus !== 200) {
    expect(await inbound.json()).toMatchObject({ code: 'invalid_question_recipient' });
    return { thread, messageID: '' };
  }
  return { thread, messageID: (await inbound.json<InternalChannelEventResponse>()).message_id };
}

async function answer(headers: Record<string, string>, threadID: string, questionID: string, optionIDs: string[]) {
  const response = await exports.default.fetch(new Request(
    `http://local/api/threads/${threadID}/questions/${questionID}/answer`,
    { method: 'POST', headers, body: JSON.stringify({ option_ids: optionIDs }) },
  ));
  return { status: response.status, body: await response.json<{ accepted?: boolean; message?: ThreadMessage; code?: string }>() };
}

async function messages(headers: Record<string, string>, threadID: string) {
  const response = await exports.default.fetch(new Request(`http://local/api/threads/${threadID}/messages`, { headers }));
  return (await response.json<ThreadMessagesResponse>()).messages;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  (env as Env).AGENT_ROSTER = '{}';
  await env.USAGE.prepare("DELETE FROM attention_requests WHERE recipient_email LIKE 'question-%'").run();
  await env.USAGE.prepare('DELETE FROM thread_members').run();
  await env.USAGE.prepare('DELETE FROM threads').run();
  await env.USAGE.prepare("DELETE FROM people WHERE email LIKE 'question-%' OR email = 'agent-vocab@example.com'").run();
});

describe('agent interactive questions', () => {
  it('stores a multiple selection as one human reply and resumes the same agent thread once', async () => {
    (env as Env).AGENT_ROSTER = JSON.stringify({
      [vocabEmail]: { name: 'Vocab', endpoint: 'https://vocab.example.com/meet/handoff' },
    });
    const delivered: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      delivered.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(null, { status: 202 });
    });

    const { headers, person } = await member();
    const { thread, messageID } = await questionThread(headers);
    const question = (await messages(headers, thread.id)).find((row) => row.id === messageID)!;
    expect(question.question).toEqual({ mode: 'multiple', options: [
      { id: 'concise', label: 'Keep it concise' },
      { id: 'detailed', label: 'Add more detail' },
      { id: 'examples', label: 'Include examples' },
    ] });

    const requestId = attentionRequestID({ type: 'thread_question', thread_id: thread.id, message_id: messageID });
    expect(await pendingAttentionRequests(env.USAGE, person.email)).toMatchObject([{ id: requestId, asked_by: 'Vocab' }]);

    const [left, right] = await Promise.all([
      answer(headers, thread.id, messageID, ['examples', 'concise']),
      answer(headers, thread.id, messageID, ['detailed']),
    ]);
    expect(left.status).toBe(200);
    expect(right.status).toBe(200);
    expect([left.body.accepted, right.body.accepted].filter(Boolean)).toHaveLength(1);
    expect(left.body.message?.id).toBe(right.body.message?.id);

    const transcript = await messages(headers, thread.id);
    const answers = transcript.filter((row) => row.question_answer?.question_message_id === messageID);
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({
      sender_email: person.email,
      is_mine: true,
      type: 'text',
      reply_to_message_id: messageID,
    });
    expect(answers[0]?.question_answer?.question_message_id).toBe(messageID);
    expect([
      ['concise', 'examples'],
      ['detailed'],
    ]).toContainEqual(answers[0]?.question_answer?.option_ids);

    expect(await pendingAttentionRequests(env.USAGE, person.email)).toEqual([]);
    expect(await readAttentionRequest(env.USAGE, requestId)).toMatchObject({ state: 'answered', revision: 1,
      answer: { option_ids: answers[0]?.question_answer?.option_ids } });

    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.url).toBe('https://vocab.example.com/meet/handoff');
    expect(delivered[0]?.body).toMatchObject({
      kind: 'question_answer', thread_id: thread.id, question_message_id: messageID,
      question_text: 'Which direction should I take?',
      option_ids: answers[0]?.question_answer?.option_ids,
      option_labels: answers[0]?.question_answer?.option_labels,
      sender_email: person.email,
      sender_name: 'Ada',
    });

    const withdrawn = await exports.default.fetch(new Request(
      `http://local/api/threads/${thread.id}/messages/${answers[0]!.id}`,
      { method: 'DELETE', headers },
    ));
    expect(withdrawn.status).toBe(200);
    const tombstone = (await messages(headers, thread.id)).find((row) => row.id === answers[0]!.id);
    expect(await readAttentionRequest(env.USAGE, requestId)).toMatchObject({ state: 'withdrawn', answer: null, revision: 2 });
    expect((await answer(headers, thread.id, messageID, ['detailed'])).body.message?.deleted_at).toBeTypeOf('number');
    expect(tombstone).toMatchObject({ deleted_at: expect.any(Number), question_answer: {
      question_message_id: messageID, option_ids: [], option_labels: [],
    } });
  });

  it('repairs missing registration on inbound replay using the stored timestamp and prompt', async () => {
    (env as Env).AGENT_ROSTER = JSON.stringify({ [vocabEmail]: { name: 'Vocab', endpoint: 'https://vocab.example.com/meet/handoff' } });
    const { headers, person } = await member();
    const { thread, messageID } = await questionThread(headers);
    const id = attentionRequestID({ type: 'thread_question', thread_id: thread.id, message_id: messageID });
    const initial = await readAttentionRequest(env.USAGE, id);
    await env.USAGE.prepare('DELETE FROM attention_requests WHERE id = ?1').bind(id).run();
    await questionThread(headers);
    expect(await readAttentionRequest(env.USAGE, id)).toEqual(initial);
    expect(await pendingAttentionRequests(env.USAGE, person.email)).toHaveLength(1);
  });

  it('imports a legacy answer on replay without reopening it', async () => {
    (env as Env).AGENT_ROSTER = JSON.stringify({ [vocabEmail]: { name: 'Vocab', endpoint: 'https://vocab.example.com/meet/handoff' } });
    vi.stubGlobal('fetch', async () => new Response(null, { status: 202 }));
    const { headers, person } = await member();
    const { thread, messageID } = await questionThread(headers);
    const id = attentionRequestID({ type: 'thread_question', thread_id: thread.id, message_id: messageID });
    await env.USAGE.prepare('DELETE FROM attention_requests WHERE id = ?1').bind(id).run();
    const stub = env.THREADS.getByName(thread.id) as DurableObjectStub<ThreadCoordinator>;
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec('DELETE FROM question_assignments WHERE message_id = ?', messageID);
    });
    await stub.answerQuestion({ sub: `dev:${person.email}`, email: person.email, name: person.name },
      messageID, `legacy_answer_${serial}`, Date.now(), ['concise']);
    await questionThread(headers);
    expect(await readAttentionRequest(env.USAGE, id)).toMatchObject({ state: 'answered', revision: 0,
      answer: { option_ids: ['concise'], answered_by_email: person.email } });
    expect(await pendingAttentionRequests(env.USAGE, person.email)).toEqual([]);
  });

  it('projects a canonical answer and returns it to a competing chat submission', async () => {
    (env as Env).AGENT_ROSTER = JSON.stringify({ [vocabEmail]: { name: 'Vocab', endpoint: 'https://vocab.example.com/meet/handoff' } });
    const delivered = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', delivered);
    const { headers, person } = await member();
    const { thread, messageID } = await questionThread(headers);
    const id = attentionRequestID({ type: 'thread_question', thread_id: thread.id, message_id: messageID });
    await resolveAttentionRequest(env.USAGE, id, person.email, { action: 'answer', option_ids: ['detailed'] }, 1_700_000_000_000);
    const losing = await answer(headers, thread.id, messageID, ['concise']);
    expect(losing.body).toMatchObject({ accepted: false, message: { sent_at: 1_700_000_000_000,
      question_answer: { option_ids: ['detailed'] } } });
    expect((await answer(headers, thread.id, messageID, ['examples'])).body.message?.id).toBe(losing.body.message?.id);
    expect((await messages(headers, thread.id)).filter((row) => row.question_answer)).toHaveLength(1);
    expect((await readAttentionRequest(env.USAGE, id)).revision).toBe(1);
    await vi.waitFor(() => expect(delivered).toHaveBeenCalledTimes(1));
  });

  it('keeps a canonical dismissal closed and refuses the author answering for the recipient', async () => {
    (env as Env).AGENT_ROSTER = JSON.stringify({ [vocabEmail]: { name: 'Vocab', endpoint: 'https://vocab.example.com/meet/handoff' } });
    const { headers, person } = await member();
    const { thread, messageID } = await questionThread(headers);
    const stub = env.THREADS.getByName(thread.id) as DurableObjectStub<ThreadCoordinator>;
    const refused = await stub.answerQuestion({ sub: agentSub(vocabEmail), email: vocabEmail, name: 'Vocab' },
      messageID, 'invalid_author_answer', Date.now(), ['concise']).catch((error: Error) => error.message);
    expect(refused).toContain('Only the recipient');
    const id = attentionRequestID({ type: 'thread_question', thread_id: thread.id, message_id: messageID });
    await resolveAttentionRequest(env.USAGE, id, person.email, { action: 'dismiss' });
    expect((await answer(headers, thread.id, messageID, ['concise'])).status).toBe(409);
    await questionThread(headers);
    expect(await pendingAttentionRequests(env.USAGE, person.email)).toEqual([]);
    expect((await readAttentionRequest(env.USAGE, id)).state).toBe('dismissed');
  });

  it('keeps an unassigned group question in chat without choosing one of its humans', async () => {
    (env as Env).AGENT_ROSTER = JSON.stringify({ [vocabEmail]: { name: 'Vocab', endpoint: 'https://vocab.example.com/meet/handoff' } });
    const delivered = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', delivered);
    const first = await member();
    const second = await member();
    const opened = await exports.default.fetch(new Request('http://local/api/threads', {
      method: 'POST', headers: first.headers, body: JSON.stringify({ peer_emails: [vocabEmail, second.person.email] }),
    }));
    expect(opened.status).toBe(200);
    const { thread } = await opened.json<{ thread: ThreadSummary }>();
    // Seed an old, unassigned source directly: new inbound shared questions
    // must name their recipient, while existing messages remain answerable.
    const legacy = await (env.THREADS.getByName(thread.id) as DurableObjectStub<ThreadCoordinator>).append(
      { sub: agentSub(vocabEmail), email: vocabEmail, name: 'Vocab' }, 'Legacy shared question',
      `legacy_shared_${serial}`, Date.now(), 'text', [],
      { question: { mode: 'single', options: [{ id: 'concise', label: 'Concise' }, { id: 'detailed', label: 'Detailed' }] } },
    );
    const messageID = legacy.id;
    expect(await pendingAttentionRequests(env.USAGE, first.person.email)).toEqual([]);
    expect(await pendingAttentionRequests(env.USAGE, second.person.email)).toEqual([]);
    expect((await answer(second.headers, thread.id, messageID, ['concise'])).body.accepted).toBe(true);
    await vi.waitFor(() => expect(delivered).toHaveBeenCalled());
  });

  it('uses the same request through the public API and chat, with source permissions and one winning answer', async () => {
    (env as Env).AGENT_ROSTER = JSON.stringify({ [vocabEmail]: { name: 'Vocab', endpoint: 'https://vocab.example.com/meet/handoff' } });
    const delivered = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', delivered);
    const recipient = await member();
    const outsider = await member();
    const { thread, messageID } = await questionThread(recipient.headers);
    const inbox = async (query = '', headers = recipient.headers) => {
      const response = await exports.default.fetch(new Request(`http://local/api/crm/inbox${query}`, { headers }));
      expect(response.status).toBe(200);
      return response.json<import('@starlings/contracts').InboxResponse>();
    };
    expect((await inbox()).items.some((item) => item.source === 'question')).toBe(false);
    expect((await inbox('?questions=false')).items.some((item) => item.source === 'question')).toBe(false);
    const queued = (await inbox('?questions=true')).items.filter((item) => item.source === 'question');
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ request: { asked_by: 'Vocab', recipient_email: recipient.person.email } });
    expect((await inbox('?questions=true', outsider.headers)).items.some((item) => item.source === 'question')).toBe(false);

    const id = attentionRequestID({ type: 'thread_question', thread_id: thread.id, message_id: messageID });
    const url = `http://local/api/attention/${encodeURIComponent(id)}`;
    const list = await exports.default.fetch(new Request('http://local/api/attention', { headers: recipient.headers }));
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ requests: [{ id, asked_by: 'Vocab', state: 'open' }] });
    expect((await exports.default.fetch(new Request(url, { headers: outsider.headers }))).status).toBe(404);
    const resolved = await exports.default.fetch(new Request(`${url}/resolve`, {
      method: 'POST', headers: recipient.headers, body: JSON.stringify({ action: 'answer', option_ids: ['examples', 'concise'] }),
    }));
    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toMatchObject({ accepted: true, request: { id, state: 'answered', answer: { option_ids: ['concise', 'examples'] } } });
    expect((await answer(recipient.headers, thread.id, messageID, ['detailed'])).body.accepted).toBe(false);
    expect((await messages(recipient.headers, thread.id)).filter((message) => message.question_answer?.question_message_id === messageID)).toHaveLength(1);
    const pending = await exports.default.fetch(new Request('http://local/api/attention', { headers: recipient.headers }));
    expect(await pending.json()).toEqual({ requests: [] });
    expect((await inbox('?questions=true')).items.some((item) => item.source === 'question')).toBe(false);
    await vi.waitFor(() => expect(delivered).toHaveBeenCalledTimes(1));
  });

  it('returns one winner when the public API races the chat route with different answers', async () => {
    (env as Env).AGENT_ROSTER = JSON.stringify({ [vocabEmail]: { name: 'Vocab', endpoint: 'https://vocab.example.com/meet/handoff' } });
    const delivered = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', delivered);
    const recipient = await member();
    const { thread, messageID } = await questionThread(recipient.headers, 'single');
    const id = attentionRequestID({ type: 'thread_question', thread_id: thread.id, message_id: messageID });
    const [apiResponse, chatResponse] = await Promise.all([
      exports.default.fetch(new Request(`http://local/api/attention/${encodeURIComponent(id)}/resolve`, {
        method: 'POST', headers: recipient.headers, body: JSON.stringify({ action: 'answer', option_ids: ['concise'] }),
      })),
      answer(recipient.headers, thread.id, messageID, ['detailed']),
    ]);
    expect(apiResponse.status).toBe(200);
    expect(chatResponse.status).toBe(200);
    const api = await apiResponse.json<AttentionResolveResponse>();
    expect(Number(api.accepted) + Number(chatResponse.body.accepted)).toBe(1);
    expect(api.request.answer?.option_ids).toEqual(chatResponse.body.message?.question_answer?.option_ids);
    expect((await readAttentionRequest(env.USAGE, id)).answer?.option_ids).toEqual(api.request.answer?.option_ids);
    expect(await pendingAttentionRequests(env.USAGE, recipient.person.email)).toEqual([]);
    await vi.waitFor(() => expect(delivered).toHaveBeenCalledTimes(1));
  });

  it('assigns a new shared question to its named human and closes it on dismissal from another surface', async () => {
    (env as Env).AGENT_ROSTER = JSON.stringify({ [vocabEmail]: { name: 'Vocab', endpoint: 'https://vocab.example.com/meet/handoff' } });
    const first = await member();
    const second = await member();
    const opened = await exports.default.fetch(new Request('http://local/api/threads', {
      method: 'POST', headers: first.headers, body: JSON.stringify({ peer_emails: [vocabEmail, second.person.email] }),
    }));
    const { thread } = await opened.json<{ thread: ThreadSummary }>();
const outsider = await member();
    await questionThread(first.headers, 'single', thread, undefined, 400);
    await questionThread(first.headers, 'single', thread, vocabEmail, 400);
    await questionThread(first.headers, 'single', thread, outsider.person.email, 400);
    const { messageID } = await questionThread(first.headers, 'single', thread, second.person.email);
    const id = attentionRequestID({ type: 'thread_question', thread_id: thread.id, message_id: messageID });
    expect(await pendingAttentionRequests(env.USAGE, first.person.email)).toEqual([]);
    expect(await pendingAttentionRequests(env.USAGE, second.person.email)).toHaveLength(1);
    // Simulate a missed cross-store registration: the source assignment must
    // survive and be repaired before an undesignated person can claim it.
    await env.USAGE.prepare('DELETE FROM attention_requests WHERE id = ?1').bind(id).run();
    expect((await answer(first.headers, thread.id, messageID, ['concise'])).status).toBe(403);
    expect((await readAttentionRequest(env.USAGE, id)).recipient_email).toBe(second.person.email);
    const url = `http://local/api/attention/${encodeURIComponent(id)}/resolve`;
    const command = (headers: Record<string, string>) => exports.default.fetch(new Request(url, {
      method: 'POST', headers, body: JSON.stringify({ action: 'dismiss' }),
    }));
    expect((await command(first.headers)).status).toBe(403);
    const dismissed = await command(second.headers);
    expect(dismissed.status).toBe(200);
    expect(await dismissed.json()).toMatchObject({ accepted: true, request: { state: 'dismissed', revision: 1 } });
    expect((await answer(second.headers, thread.id, messageID, ['concise'])).status).toBe(409);
    const visible = await exports.default.fetch(new Request(`http://local/api/attention?thread_id=${thread.id}&state=all`, { headers: first.headers }));
    expect(await visible.json()).toMatchObject({ requests: [{ id, state: 'dismissed' }] });
  });

  it('enforces single selection, option membership, and finalized question messages', async () => {
    (env as Env).AGENT_ROSTER = JSON.stringify({ [vocabEmail]: { name: 'Vocab', endpoint: 'https://vocab.example.com/meet/handoff' } });
    const { headers } = await member();
    const { thread, messageID } = await questionThread(headers, 'single');

    const invalid = await answer(headers, thread.id, messageID, ['concise', 'examples']);
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('invalid_question_answer');
    const unknown = await answer(headers, thread.id, messageID, ['missing']);
    expect(unknown.status).toBe(400);
    expect(unknown.body.code).toBe('invalid_question_answer');

    const partial = await (env.THREADS.getByName(thread.id) as DurableObjectStub<ThreadCoordinator>).append(
      { sub: agentSub(vocabEmail), email: vocabEmail, name: 'Vocab' },
      'Still drafting this question',
      `partial_question_${serial}`,
      Date.now(),
      'text',
      [],
      { partial: true, question: { mode: 'single', options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] } },
    );
    const unfinished = await answer(headers, thread.id, partial.id, ['yes']);
    expect(unfinished.status).toBe(409);
    expect(unfinished.body.code).toBe('question_not_open');
  });
});
