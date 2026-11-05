import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import { attentionFromOpenQuestion, attentionRequestID, type AttentionRequest } from '@starlings/contracts';
import { ensureAttentionRequest, pendingAttentionRequests, readAttentionRequest, resolveAttentionRequest, retractQuestionAnswer } from '../src/attention-requests';

const recipient = 'attention-recipient@example.com';
const asker = 'attention-asker@example.com';
const stranger = 'attention-stranger@example.com';
const now = Date.parse('2026-10-03T12:00:00Z');

function question(): AttentionRequest {
  return attentionFromOpenQuestion({
    id: crypto.randomUUID(), thread_id: 'attention-test-thread', sender_email: asker,
    sender_name: 'Asker', sent_at: now, text: 'Choose a path',
  }, { mode: 'multiple', options: [{ id: 'a', label: 'First' }, { id: 'b', label: 'Second' }] }, recipient);
}
function decision(defaultBy = '2026-10-02'): AttentionRequest {
  const origin = { type: 'decision' as const, decision_id: crypto.randomUUID() };
  return {
    ...question(), id: attentionRequestID(origin), origin, kind: 'decision', selection_mode: 'single',
    recommendation: 'a', default_by: defaultBy, allows_custom_answer: true,
  };
}
const create = (request = question()) => ensureAttentionRequest(env.USAGE, request);
const resolve = (id: string, actor: string, command: Parameters<typeof resolveAttentionRequest>[3]) =>
  resolveAttentionRequest(env.USAGE, id, actor, command, now);

afterEach(async () => {
  await env.USAGE.prepare('DELETE FROM attention_requests WHERE recipient_email IN (?1, ?2)').bind(recipient, stranger).run();
});

describe('canonical attention repository', () => {
  it('normalizes recipient identity, isolates pending reads and never resolves on read', async () => {
    const request = await create({ ...question(), recipient_email: recipient.toUpperCase() });
    await create({ ...question(), recipient_email: stranger });
    expect(await pendingAttentionRequests(env.USAGE, recipient.toUpperCase())).toEqual([request]);
    expect(await readAttentionRequest(env.USAGE, request.id)).toEqual(request);
    expect(await pendingAttentionRequests(env.USAGE, asker)).toEqual([]);
  });

  it('creates once under concurrent retries, never merges identical wording, and rejects changed source content', async () => {
    const input = question();
    const records = await Promise.all([create(input), create(input)]);
    expect(records[0]).toEqual(records[1]);
    const other = await create();
    expect(other.id).not.toBe(input.id);
    expect(await pendingAttentionRequests(env.USAGE, recipient)).toHaveLength(2);
    await expect(create({ ...input, prompt: 'Changed question' })).rejects.toMatchObject({ status: 409 });
    await expect(create({ ...input, id: 'guessed-link' })).rejects.toMatchObject({ status: 400 });
    await expect(create({ ...input, revision: 7 })).rejects.toMatchObject({ status: 400 });
  });

  it('stores source-ordered labels once and returns the winner on retry or a different later answer', async () => {
    const input = question();
    const request = await create(input);
    const answer = await resolve(request.id, recipient, { action: 'answer', option_ids: ['b', 'a'], note: 'Done' });
    expect(answer).toMatchObject({ accepted: true, request: {
      state: 'answered', revision: 1, answer: { option_ids: ['a', 'b'], option_labels: ['First', 'Second'], note: 'Done' },
    } });
    const retry = await resolve(request.id, recipient, { action: 'answer', option_ids: ['a', 'b'], note: 'Changed note' });
    const competing = await resolve(request.id, recipient, { action: 'answer', option_ids: ['b'] });
    expect(retry).toEqual({ accepted: false, request: answer.request });
    expect(competing).toEqual(retry);
    expect(await create(input)).toEqual(answer.request);
    expect(await pendingAttentionRequests(env.USAGE, recipient)).toEqual([]);
  });

  it('lets only the recipient erase a question answer, idempotently and without reopening', async () => {
    const request = await create();
    await resolve(request.id, recipient, { action: 'answer', option_ids: ['a'] });
    await expect(retractQuestionAnswer(env.USAGE, request.id, asker)).rejects.toMatchObject({ status: 403 });
    await retractQuestionAnswer(env.USAGE, request.id, recipient);
    await retractQuestionAnswer(env.USAGE, request.id, recipient);
    expect(await readAttentionRequest(env.USAGE, request.id)).toMatchObject({ state: 'withdrawn', answer: null, revision: 2 });
    expect((await resolve(request.id, recipient, { action: 'answer', option_ids: ['b'] })).accepted).toBe(false);
    expect(await pendingAttentionRequests(env.USAGE, recipient)).toEqual([]);
    const ask = await create(decision());
    await resolve(ask.id, recipient, { action: 'answer', option_ids: ['a'] });
    await expect(retractQuestionAnswer(env.USAGE, ask.id, recipient)).rejects.toMatchObject({ status: 403 });
  });

  it('allows only one terminal winner when answer and dismissal race', async () => {
    const request = await create();
    const results = await Promise.all([
      resolve(request.id, recipient, { action: 'answer', option_ids: ['a'] }),
      resolve(request.id, recipient, { action: 'dismiss' }),
    ]);
    expect(results.filter((result) => result.accepted)).toHaveLength(1);
    expect(results[0]!.request).toEqual(results[1]!.request);
    expect(results[0]!.request.revision).toBe(1);
    expect(await pendingAttentionRequests(env.USAGE, recipient)).toEqual([]);
  });

  it('refuses unauthorized transitions both before and after resolution', async () => {
    const request = await create();
    for (const actor of [asker, stranger]) {
      for (const action of ['answer', 'dismiss'] as const) {
        await expect(resolve(request.id, actor, { action, option_ids: ['a'] })).rejects.toMatchObject({ status: 403 });
      }
    }
    await expect(resolve(request.id, recipient, { action: 'withdraw' })).rejects.toMatchObject({ status: 403 });
    await expect(resolve(request.id, stranger, { action: 'withdraw' })).rejects.toMatchObject({ status: 403 });
    await resolve(request.id, recipient, { action: 'dismiss' });
    await expect(resolve(request.id, stranger, { action: 'answer', option_ids: ['a'] })).rejects.toMatchObject({ status: 403 });
  });

  it('rejects invalid choices and custom question answers without consuming the request', async () => {
    const request = await create();
    for (const ids of [[], ['unknown'], ['a', 'a']]) {
      await expect(resolve(request.id, recipient, { action: 'answer', option_ids: ids })).rejects.toMatchObject({ status: 400 });
    }
    await expect(resolve(request.id, recipient, { action: 'answer', option_ids: [], custom_text: 'Other' }))
      .rejects.toMatchObject({ status: 400 });
    expect(await readAttentionRequest(env.USAGE, request.id)).toEqual(request);
    const single = await create(decision());
    await expect(resolve(single.id, recipient, { action: 'answer', option_ids: ['a', 'b'] })).rejects.toMatchObject({ status: 400 });
    await expect(resolve(single.id, recipient, { action: 'answer', option_ids: ['a'], custom_text: 'Other' })).rejects.toMatchObject({ status: 400 });
    await expect(resolve(single.id, recipient, { action: 'answer', option_ids: [], custom_text: 'x'.repeat(1001) })).rejects.toMatchObject({ status: 400 });
    expect((await resolve(single.id, recipient, { action: 'answer', option_ids: [], custom_text: ' Another path ' })).request.answer)
      .toMatchObject({ option_ids: [], option_labels: [], custom_text: 'Another path' });
  });

  it('dismisses and withdraws without fabricating an answer, and never reopens', async () => {
    const dismissed = await create();
    const withdrawn = await create();
    const dismiss = await resolve(dismissed.id, recipient, { action: 'dismiss' });
    const withdraw = await resolve(withdrawn.id, asker, { action: 'withdraw' });
    expect(dismiss.request).toMatchObject({ state: 'dismissed', answer: null, revision: 1 });
    expect(withdraw.request).toMatchObject({ state: 'withdrawn', answer: null, revision: 1 });
    expect(await resolve(dismissed.id, asker, { action: 'withdraw' })).toEqual({ request: dismiss.request, accepted: false });
    const oldDecision = await create(decision());
    expect((await resolve(oldDecision.id, recipient, { action: 'withdraw' })).request.state).toBe('withdrawn');
  });

  it('requires an explicit default after the UTC day and preserves decision party permissions', async () => {
    const due = await create(decision('2026-10-03'));
    await expect(resolve(due.id, asker, { action: 'apply_default' })).rejects.toMatchObject({ status: 400 });
    const overdue = await create(decision());
    expect((await readAttentionRequest(env.USAGE, overdue.id)).state).toBe('open');
    await expect(resolve(overdue.id, stranger, { action: 'apply_default' })).rejects.toMatchObject({ status: 403 });
    const applied = await resolve(overdue.id, asker, { action: 'apply_default' });
    expect(applied.request).toMatchObject({ state: 'defaulted', answer: { option_ids: ['a'], answered_by_email: asker } });
    expect(await resolve(overdue.id, recipient, { action: 'apply_default' })).toEqual({ accepted: false, request: applied.request });
    const q = await create();
    await expect(resolve(q.id, recipient, { action: 'apply_default' })).rejects.toMatchObject({ status: 403 });
  });

  it('rolls back the canonical answer if its atomic source projection fails', async () => {
    const request = await create();
    await expect(resolveAttentionRequest(env.USAGE, request.id, recipient, { action: 'answer', option_ids: ['a'] }, now, {
      guard: { sql: '1 = 1', values: [] },
      projection: () => env.USAGE.prepare('UPDATE missing_attention_projection_table SET value = 1'),
    })).rejects.toThrow();
    expect(await readAttentionRequest(env.USAGE, request.id)).toEqual(request);
    expect(await pendingAttentionRequests(env.USAGE, recipient)).toEqual([request]);
  });

  it('does not claim an answer after the source transition guard has closed', async () => {
    const request = await create();
    const result = await resolveAttentionRequest(env.USAGE, request.id, recipient, { action: 'answer', option_ids: ['a'] }, now, {
      guard: { sql: '0 = 1', values: [] }, projection: () => env.USAGE.prepare('SELECT 1'),
    });
    expect(result).toEqual({ accepted: false, request });
  });

  it('imports terminal legacy snapshots and protects them from an open-source replay', async () => {
    const input = question();
    const terminal: AttentionRequest = { ...input, state: 'answered', answer: {
      option_ids: ['a'], option_labels: ['First'], custom_text: null, note: null,
      answered_by_email: recipient, answered_at: new Date(now).toISOString(),
    } };
    expect(await create(terminal)).toEqual(terminal);
    expect(await create(input)).toEqual(terminal);
    expect(await pendingAttentionRequests(env.USAGE, recipient)).toEqual([]);
  });
});
