import { describe, expect, it } from 'vitest';
import {
  attentionFromDecision, attentionFromOpenQuestion, attentionRequestID,
  attentionRequestSchema, attentionListQuerySchema, attentionResolveInputSchema, sortAttentionRequests, selectAttentionOptions, type AttentionRequest,
} from '@starlings/contracts/attention';
import { decisionAskSchema } from '@starlings/contracts/decision-asks';
import selection from '../../../fixtures/attention-selection.json';
import queue from '../../../fixtures/attention-queue.json';
import decisions from '../../../fixtures/responses/decision-asks.json';

const ask = decisionAskSchema.parse(decisions.asks[0]);
const message = {
  id: 'message-1', thread_id: 'dm_1', sent_at: Date.parse('2026-10-03T12:00:00Z'),
  sender_email: 'test-agent@example.com', sender_name: 'Test agent', text: ask.question,
};
const question = () => attentionFromOpenQuestion(message, { mode: 'single', options: selection.options }, ask.waits_on_email);
const answer = () => ({
  option_ids: ['easy'], option_labels: ['Easy to use'], custom_text: null, note: null,
  answered_by_email: ask.waits_on_email, answered_at: '2026-10-03T12:01:00Z',
});

describe('attention selection policy fixture', () => {
  for (const row of selection.cases) {
    it(row.name, () => {
      const selected = selectAttentionOptions(row.mode as 'single' | 'multiple', selection.options, row.selected);
      expect(selected?.map((option) => option.id) ?? null).toEqual(row.expected);
    });
  }
});

describe('attention source compatibility', () => {
  it('keeps identical prompts in different sources distinct, retaining asker, recipient, subject and links', () => {
    const decision = attentionFromDecision(ask);
    const chat = question();
    expect(decision.prompt).toBe(chat.prompt);
    expect(decision.id).not.toBe(chat.id);
    expect(attentionFromDecision(ask)).toEqual(decision);
    expect(decision).toMatchObject({ state: 'open', asked_by: ask.asked_by, recipient_email: ask.waits_on_email,
      subject: ask.subject, links: ask.links, recommendation: ask.recommendation, default_by: ask.default_by });
    expect(chat).toMatchObject({ asked_by: 'Test agent', recipient_email: ask.waits_on_email,
      origin: { type: 'thread_question', thread_id: message.thread_id, message_id: message.id } });
  });

  it('does not conflate source ids containing separators', () => {
    expect(attentionRequestID({ type: 'thread_question', thread_id: 'a:b', message_id: 'c' }))
      .not.toBe(attentionRequestID({ type: 'thread_question', thread_id: 'a', message_id: 'b:c' }));
  });

  it('requires an explicitly designated question recipient', () => {
    expect(() => attentionFromOpenQuestion(message, { mode: 'single', options: selection.options }, '')).toThrow();
  });

  it('preserves an option decision and a custom-text decision answer', () => {
    const resolved = { ...ask, status: 'answered' as const, answer: 'ship', answer_label: 'Ship it',
      answered_by_email: ask.waits_on_email, answered_at: '2026-10-03T12:01:00Z', answer_note: 'Proceed.' };
    expect(attentionFromDecision(resolved).answer).toMatchObject({ option_ids: ['ship'], option_labels: ['Ship it'], custom_text: null, note: 'Proceed.' });
    expect(attentionFromDecision({ ...resolved, answer: 'Ship next week' }).answer)
      .toMatchObject({ option_ids: [], option_labels: [], custom_text: 'Ship next week' });
  });

  it('preserves withdrawn/defaulted decisions without inventing an answer', () => {
    expect(attentionFromDecision({ ...ask, status: 'withdrawn' }).answer).toBeNull();
    expect(attentionFromDecision({ ...ask, status: 'defaulted', answer: 'ship', answer_label: 'Ship it',
      answered_by_email: 'admin@example.com', answered_at: '2026-10-03T12:01:00Z' }).state).toBe('defaulted');
  });
});

describe('attention request semantic boundaries', () => {
  const rejects = (patch: Partial<AttentionRequest>) => expect(attentionRequestSchema.safeParse({ ...question(), ...patch }).success).toBe(false);

  it('accepts a recipient answer and rejects forged labels, actors and multi-choice single answers', () => {
    expect(attentionRequestSchema.safeParse({ ...question(), state: 'answered', answer: answer() }).success).toBe(true);
    rejects({ state: 'answered', answer: { ...answer(), option_labels: ['Approve a purchase'] } });
    rejects({ state: 'answered', answer: { ...answer(), answered_by_email: 'other@example.com' } });
    rejects({ state: 'answered', answer: { ...answer(), option_ids: ['easy', 'polish'], option_labels: ['Easy to use', 'Needs more polish'] } });
  });

  it('rejects answers in open/dismissed state and answered requests without an answer', () => {
    rejects({ answer: answer() });
    rejects({ state: 'dismissed', answer: answer() });
    rejects({ state: 'answered' });
    expect(attentionRequestSchema.safeParse({ ...question(), state: 'dismissed' }).success).toBe(true);
  });

  it('rejects approvals, decision defaults on questions, duplicate ids and bad revisions', () => {
    expect(attentionRequestSchema.safeParse({ ...question(), kind: 'approval' }).success).toBe(false);
    rejects({ state: 'defaulted', answer: answer() });
    rejects({ recommendation: 'easy', default_by: '2026-10-07' });
    rejects({ allows_custom_answer: true });
    rejects({ options: [selection.options[0]!, selection.options[0]!] });
    rejects({ revision: -1 });
  });

  it('rejects decisions missing a recommendation or defaulting to a different option', () => {
    const decision = attentionFromDecision(ask);
    expect(attentionRequestSchema.safeParse({ ...decision, recommendation: 'missing' }).success).toBe(false);
    expect(attentionRequestSchema.safeParse({ ...decision, state: 'defaulted', answer: { ...answer(), option_ids: ['wait'], option_labels: ['Wait for Cleo'] } }).success).toBe(false);
  });
});

describe('public attention commands and queue order', () => {
  it('requires paired subject filters and prevents dismissal carrying an answer', () => {
    expect(attentionListQuerySchema.parse({})).toEqual({ state: 'open' });
    expect(attentionListQuerySchema.safeParse({ subject_kind: 'project' }).success).toBe(false);
    expect(attentionResolveInputSchema.safeParse({ action: 'dismiss', option_ids: ['ship'] }).success).toBe(false);
    expect(attentionResolveInputSchema.safeParse({ action: 'dismiss', note: 'Proceed' }).success).toBe(false);
    expect(attentionResolveInputSchema.parse({ action: 'dismiss' })).toEqual({ action: 'dismiss', option_ids: [] });
  });

  it('puts decisions in their established priority ahead of source-ordered questions without mutating input', () => {
    const input = queue.rows.map((row) => ({
      ...(row.kind === 'question' ? question() : attentionFromDecision(ask)),
      id: row.id, created_at: row.created_at, default_by: row.default_by,
    }));
    expect(sortAttentionRequests(input, Date.parse(queue.now)).map((row) => row.id)).toEqual(queue.expected);
    expect(input.map((row) => row.id)).toEqual(queue.rows.map((row) => row.id));
  });
});
