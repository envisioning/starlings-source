import { z } from 'zod';
import type { ThreadMessage, ThreadQuestion } from './index';
import { isDecisionAskPastDefault, decisionAskSubjectSchema, decisionAskLinkSchema, type DecisionAsk } from './decision-asks';

/** #771: these are requests for input, never authorization to perform an action. */
export const attentionKindSchema = z.enum(['question', 'decision']);
export const attentionStateSchema = z.enum(['open', 'answered', 'dismissed', 'withdrawn', 'defaulted']);
export const attentionSelectionModeSchema = z.enum(['single', 'multiple']);
export const attentionOptionSchema = z.object({
  id: z.string().min(1).max(48),
  label: z.string().min(1).max(200),
});
export const attentionThreadOriginSchema = z.object({
  type: z.literal('thread_question'),
  thread_id: z.string().min(1),
  message_id: z.string().min(1),
});
export const attentionDecisionOriginSchema = z.object({
  type: z.literal('decision'),
  decision_id: z.string().min(1),
});
export const attentionOriginSchema = z.discriminatedUnion('type', [attentionThreadOriginSchema, attentionDecisionOriginSchema]);
export type AttentionOrigin = z.infer<typeof attentionOriginSchema>;

export const attentionAnswerSchema = z.object({
  option_ids: z.array(z.string()).max(8),
  option_labels: z.array(z.string()).max(8),
  custom_text: z.string().min(1).max(1_000).nullable(),
  note: z.string().max(2_000).nullable(),
  answered_by_email: z.string().email(),
  answered_at: z.string().datetime({ offset: true }),
}).superRefine((answer, ctx) => {
  if (answer.option_ids.length !== answer.option_labels.length || new Set(answer.option_ids).size !== answer.option_ids.length) {
    ctx.addIssue({ code: 'custom', path: ['option_ids'], message: 'Each unique choice needs one label.' });
  }
  if ((answer.option_ids.length > 0) === (answer.custom_text !== null)) {
    ctx.addIssue({ code: 'custom', path: ['custom_text'], message: 'Choose options or supply custom text.' });
  }
});
export type AttentionAnswer = z.infer<typeof attentionAnswerSchema>;

/** Canonical wire contract; source adapters and the public API persist/read this snapshot. */
export const attentionRequestSchema = z.object({
  id: z.string().min(1),
  kind: attentionKindSchema,
  state: attentionStateSchema,
  revision: z.number().int().nonnegative(),
  origin: attentionOriginSchema,
  recipient_email: z.string().email(),
  asked_by_email: z.string().email(),
  asked_by: z.string().min(1),
  prompt: z.string().min(1),
  context: z.string().nullable(),
  options: z.array(attentionOptionSchema).min(2).max(8),
  selection_mode: attentionSelectionModeSchema,
  allows_custom_answer: z.boolean(),
  recommendation: z.string().nullable(),
  default_by: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).nullable(),
  subject: decisionAskSubjectSchema.nullable(),
  links: z.array(decisionAskLinkSchema).max(10),
  created_at: z.string().datetime({ offset: true }),
  answer: attentionAnswerSchema.nullable(),
}).superRefine((request, ctx) => {
  const ids = request.options.map((option) => option.id);
  const invalid = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
  if (new Set(ids).size !== ids.length) invalid('options', 'Option ids must be unique.');
  if (request.kind === 'question') {
    if (request.origin.type !== 'thread_question') invalid('origin', 'A question has a thread origin.');
    if (request.recommendation !== null || request.default_by !== null || request.allows_custom_answer) {
      invalid('kind', 'Questions do not have decision defaults or custom answers.');
    }
    if (request.state === 'defaulted') invalid('state', 'Only a decision may be defaulted.');
  } else {
    if (request.origin.type !== 'decision') invalid('origin', 'A decision has a decision origin.');
    if (request.selection_mode !== 'single' || request.options.length > 6) invalid('options', 'A decision offers two to six single choices.');
    if (!request.default_by || !request.recommendation || !ids.includes(request.recommendation)) {
      invalid('recommendation', 'A decision needs a valid recommendation and default-by day.');
    }
  }
  const answered = request.state === 'answered' || request.state === 'defaulted';
  if (answered !== (request.answer !== null)) invalid('answer', 'Only answered or defaulted requests have an answer.');
  if (request.answer) {
    if (request.answer.answered_by_email.toLowerCase() !== request.recipient_email.toLowerCase() && request.state === 'answered') {
      invalid('answer', 'Only the recipient answers a request.');
    }
    if (request.answer.custom_text !== null && !request.allows_custom_answer) invalid('answer', 'This request requires a choice.');
    if (request.answer.option_ids.length) {
      const selected = selectAttentionOptions(request.selection_mode, request.options, request.answer.option_ids);
      if (!selected || selected.some((option, index) => option.id !== request.answer!.option_ids[index]
        || option.label !== request.answer!.option_labels[index])) {
        invalid('answer', 'The answer must follow the selection rule and source option order/labels.');
      }
    }
    if (request.state === 'defaulted' && (request.answer.option_ids.length !== 1
      || request.answer.option_ids[0] !== request.recommendation || request.answer.custom_text !== null)) {
      invalid('answer', 'A default selects the decision recommendation.');
    }
  }
});
export type AttentionRequest = z.infer<typeof attentionRequestSchema>;

/** Source ids are namespaced and escaped; identical wording never links records. */
export function attentionRequestID(origin: AttentionOrigin): string {
  return origin.type === 'decision'
    ? `decision:${encodeURIComponent(origin.decision_id)}`
    : `question:${encodeURIComponent(origin.thread_id)}:${encodeURIComponent(origin.message_id)}`;
}

/** Validate once and retain the source option order, including for multi-select. */
export function selectAttentionOptions<T extends { id: string; label: string }>(
  mode: 'single' | 'multiple', options: readonly T[], selectedIDs: readonly string[],
): T[] | null {
  const ids = new Set(selectedIDs);
  if (ids.size !== selectedIDs.length || selectedIDs.length === 0
    || (mode === 'single' && selectedIDs.length !== 1)) return null;
  const selected = options.filter((option) => ids.has(option.id));
  return selected.length === selectedIDs.length ? selected : null;
}

/** Source adapter: the decision routes persist this snapshot in the canonical repository. */
export function attentionFromDecision(ask: DecisionAsk): AttentionRequest {
  const origin: AttentionOrigin = { type: 'decision', decision_id: ask.id };
  const selected = ask.options.find((option) => option.key === ask.answer);
  const resolved = ask.status === 'answered' || ask.status === 'defaulted';
  return attentionRequestSchema.parse({
    id: attentionRequestID(origin), kind: 'decision', state: ask.status, revision: 0, origin,
    recipient_email: ask.waits_on_email, asked_by_email: ask.asked_by_email, asked_by: ask.asked_by,
    prompt: ask.question, context: ask.context, options: ask.options.map(({ key, label }) => ({ id: key, label })),
    selection_mode: 'single', allows_custom_answer: true, recommendation: ask.recommendation, default_by: ask.default_by,
    subject: ask.subject, links: ask.links, created_at: ask.created_at,
    answer: resolved ? {
      option_ids: selected ? [selected.key] : [], option_labels: selected ? [selected.label] : [],
      custom_text: selected ? null : ask.answer, note: ask.answer_note,
      answered_by_email: ask.answered_by_email, answered_at: ask.answered_at,
    } : null,
  });
}

/** No guessed recipient: a shared-chat caller must supply the designated member. */
export function attentionFromOpenQuestion(
  message: Pick<ThreadMessage, 'id' | 'thread_id' | 'sent_at' | 'sender_email' | 'sender_name' | 'text'>,
  question: ThreadQuestion, recipientEmail: string,
): AttentionRequest {
  const origin: AttentionOrigin = { type: 'thread_question', thread_id: message.thread_id, message_id: message.id };
  return attentionRequestSchema.parse({
    id: attentionRequestID(origin), kind: 'question', state: 'open', revision: 0, origin,
    recipient_email: recipientEmail, asked_by_email: message.sender_email,
    asked_by: message.sender_name || message.sender_email,
    prompt: message.text, context: null, options: question.options,
    selection_mode: question.mode, allows_custom_answer: false, recommendation: null, default_by: null,
    subject: null, links: [], created_at: new Date(message.sent_at).toISOString(), answer: null,
  });
}

/** Public projections; source permissions remain server-authoritative. */
export const attentionListQuerySchema = z.object({
  state: z.enum(['open', 'all']).default('open'),
  thread_id: z.string().min(4).max(72).optional(),
  subject_kind: decisionAskSubjectSchema.shape.kind.optional(),
  subject_id: z.string().uuid().optional(),
}).superRefine((value, ctx) => {
  if (Boolean(value.subject_kind) !== Boolean(value.subject_id)) {
    ctx.addIssue({ code: 'custom', message: 'Name both subject_kind and subject_id.' });
  }
});
export type AttentionListQuery = z.infer<typeof attentionListQuerySchema>;
export const attentionListResponseSchema = z.object({ requests: z.array(attentionRequestSchema) });
export type AttentionListResponse = z.infer<typeof attentionListResponseSchema>;
export const attentionResolveInputSchema = z.object({
  action: z.enum(['answer', 'dismiss']),
  option_ids: z.array(z.string()).max(8).default([]),
  custom_text: z.string().trim().min(1).max(1_000).optional(),
  note: z.string().trim().max(2_000).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.action === 'dismiss' && (value.option_ids.length || value.custom_text || value.note)) {
    ctx.addIssue({ code: 'custom', message: 'Dismissal has no answer.' });
  }
});
export type AttentionResolveInput = z.infer<typeof attentionResolveInputSchema>;
export const attentionResolveResponseSchema = z.object({ request: attentionRequestSchema, accepted: z.boolean() });
export type AttentionResolveResponse = z.infer<typeof attentionResolveResponseSchema>;

/** One queue policy: decisions in existing priority, then oldest questions. */
export function sortAttentionRequests(requests: readonly AttentionRequest[], now = Date.now()): AttentionRequest[] {
  const overdue = (request: AttentionRequest) => request.kind === 'decision' && request.default_by !== null
    && isDecisionAskPastDefault(request.default_by, now);
  return [...requests].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'decision' ? -1 : 1;
    if (a.kind === 'decision') {
      const priority = Number(overdue(b)) - Number(overdue(a)) || (a.default_by ?? '').localeCompare(b.default_by ?? '');
      if (priority) return priority;
    }
    return a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
  });
}
