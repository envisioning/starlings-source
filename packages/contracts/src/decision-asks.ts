import { z } from 'zod';
import { crmSubjectKindSchema } from './crm';

/**
 * Open decisions — the queue of questions waiting on one member
 * (docs/help/howto/answer-a-decision.md). An agent files a question through
 * MCP `ask_decision`, with options, a recommendation and a default-by day;
 * the member answers it from INBOX on the web, the Mac or the phone; the
 * agent reads the answer back through `now` or `ask_decision` `list`.
 *
 * Stored in Meet's own D1 (`decision_asks`, migration 0063), not in Core:
 * the question is Meet's until it is answered. An answer on a subject is
 * then written once to Core's decisions (`/api/crm/decisions`) as the
 * permanent record, and the Core id is kept on the row.
 *
 * Wire names say `decision_ask`; people read **decision** (docs/SURFACES.md).
 */

export const DECISION_ASK_STATUSES = ['open', 'answered', 'defaulted', 'withdrawn'] as const;
export type DecisionAskStatus = (typeof DECISION_ASK_STATUSES)[number];
export const decisionAskStatusSchema = z.enum(DECISION_ASK_STATUSES);

export const DECISION_ASK_QUESTION_MAX_CHARS = 300;
export const DECISION_ASK_CONTEXT_MAX_CHARS = 20_000;
export const DECISION_ASK_OPTION_MAX_COUNT = 6;
export const DECISION_ASK_ANSWER_MAX_CHARS = 1_000;
export const DECISION_ASK_NOTE_MAX_CHARS = 2_000;
export const DECISION_ASK_LIST_MAX = 100;

/** The subject kinds a Core decision can sit on; spelled here so this file imports nothing but zod. */
const subjectKindSchema = crmSubjectKindSchema;
/** A plain civil day, the shape a goal's target date has. */
const civilDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'YYYY-MM-DD');

export const decisionAskOptionSchema = z.object({
  /** Stable within the ask: what an answer names, and what `recommendation` points at. */
  key: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/u, 'An option key is a short lower-case slug, e.g. `ship`.'),
  label: z.string().trim().min(1).max(200),
});
export type DecisionAskOption = z.infer<typeof decisionAskOptionSchema>;

export const decisionAskLinkSchema = z.object({
  url: z.string().trim().url().max(2_000).refine((value) => value.startsWith('https://'), 'Links are https.'),
  title: z.string().trim().max(200).nullable().optional(),
});
export type DecisionAskLink = z.infer<typeof decisionAskLinkSchema>;

export const decisionAskSubjectSchema = z.object({
  kind: subjectKindSchema,
  id: z.string().uuid(),
  title: z.string().nullable(),
});
export type DecisionAskSubject = z.infer<typeof decisionAskSubjectSchema>;

/** One decision waiting on (or answered by) one member. */
export const decisionAskSchema = z.object({
  id: z.string(),
  status: decisionAskStatusSchema,
  question: z.string(),
  /** Markdown: why this needs deciding, what each option costs. */
  context: z.string().nullable(),
  options: z.array(decisionAskOptionSchema),
  /** An option key. */
  recommendation: z.string(),
  /** The civil day after which the recommendation may be applied. Never applied on its own. */
  default_by: z.string(),
  /** Past `default_by` and still open: drawn as overdue. Computed by the Worker in UTC. */
  overdue: z.boolean(),
  subject: decisionAskSubjectSchema.nullable(),
  links: z.array(z.object({ url: z.string(), title: z.string().nullable() })),
  /** The member who has to decide. */
  waits_on_email: z.string(),
  /** Who asked, as a person reads it: "Rosa via claude.ai". */
  asked_by: z.string(),
  asked_by_email: z.string(),
  created_at: z.string(),
  /** An option key, or the member's own words. Null while open or withdrawn. */
  answer: z.string().nullable(),
  /** The chosen option's label, when the answer is an option. */
  answer_label: z.string().nullable(),
  answer_note: z.string().nullable(),
  answered_at: z.string().nullable(),
  answered_by_email: z.string().nullable(),
  /** The Core decision the answer became, once written. Null with no subject, or while the write is owed. */
  core_decision_id: z.string().nullable(),
});
export type DecisionAsk = z.infer<typeof decisionAskSchema>;

export const decisionAskResponseSchema = z.object({ ask: decisionAskSchema });
export type DecisionAskResponse = z.infer<typeof decisionAskResponseSchema>;
export const decisionAsksResponseSchema = z.object({ asks: z.array(decisionAskSchema) });
export type DecisionAsksResponse = z.infer<typeof decisionAsksResponseSchema>;

/** `POST /api/decision-asks`: an agent (or a member) files a question. */
export const decisionAskCreateSchema = z.object({
  question: z.string().trim().min(1).max(DECISION_ASK_QUESTION_MAX_CHARS),
  context: z.string().trim().max(DECISION_ASK_CONTEXT_MAX_CHARS).nullable().optional(),
  options: z.array(decisionAskOptionSchema).min(2).max(DECISION_ASK_OPTION_MAX_COUNT),
  recommendation: z.string().trim().min(1).max(40),
  default_by: civilDateSchema,
  subject: z.object({
    kind: subjectKindSchema,
    id: z.string().uuid(),
    title: z.string().trim().max(300).nullable().optional(),
  }).strict().nullable().optional(),
  links: z.array(decisionAskLinkSchema).max(10).optional(),
  /** The member who decides. The caller when omitted. */
  waits_on: z.string().trim().toLowerCase().email().optional(),
  /** How the asker reads in the row. The caller's name when omitted. */
  asked_by: z.string().trim().min(1).max(120).optional(),
}).strict().superRefine((value, context) => {
  const keys = value.options.map((option) => option.key);
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: 'custom', path: ['options'], message: 'Option keys must be different.' });
  }
  if (!keys.includes(value.recommendation)) {
    context.addIssue({ code: 'custom', path: ['recommendation'], message: 'The recommendation must be one of the option keys.' });
  }
});
export type DecisionAskCreateInput = z.infer<typeof decisionAskCreateSchema>;

/** `POST /api/decision-asks/{id}/answer`: the member decides. */
export const decisionAskAnswerSchema = z.object({
  /** An option key, or the member's own words. */
  answer: z.string().trim().min(1).max(DECISION_ASK_ANSWER_MAX_CHARS),
  note: z.string().trim().max(DECISION_ASK_NOTE_MAX_CHARS).nullable().optional(),
}).strict();
export type DecisionAskAnswerInput = z.infer<typeof decisionAskAnswerSchema>;

/** `POST /api/decision-asks/{id}/withdraw`. */
export const decisionAskWithdrawSchema = z.object({
  reason: z.string().trim().max(DECISION_ASK_NOTE_MAX_CHARS).nullable().optional(),
}).strict();
export type DecisionAskWithdrawInput = z.infer<typeof decisionAskWithdrawSchema>;

/** `GET /api/decision-asks`: yours (asked by you or waiting on you), or every one on a subject. */
export const decisionAsksQuerySchema = z.object({
  /** `resolved` is answered or defaulted. */
  status: z.enum(['open', 'answered', 'defaulted', 'withdrawn', 'resolved', 'all']).default('open'),
  /** ISO time: only asks answered, defaulted or withdrawn at or after it. */
  since: z.string().datetime({ offset: true }).optional(),
  subject_kind: subjectKindSchema.optional(),
  subject_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(DECISION_ASK_LIST_MAX).default(50),
});
export type DecisionAsksQuery = z.infer<typeof decisionAsksQuerySchema>;

const DAY_MS = 86_400_000;

/**
 * Past its default-by day: the civil day after `default_by` has begun, in
 * UTC. The same instant `apply_default` becomes allowed. Never auto-applied.
 */
export function isDecisionAskPastDefault(defaultBy: string, nowMs: number): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(defaultBy);
  if (!match) return false;
  const day = Math.floor(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / DAY_MS);
  return day < Math.floor(nowMs / DAY_MS);
}

/**
 * Queue order: overdue first, then the soonest default-by, then oldest
 * asked. The Worker hands INBOX its decisions in this order, before every
 * other source.
 */
export function sortDecisionAsks<T extends Pick<DecisionAsk, 'overdue' | 'default_by' | 'created_at' | 'id'>>(asks: readonly T[]): T[] {
  return [...asks].sort((a, b) =>
    Number(b.overdue) - Number(a.overdue)
    || a.default_by.localeCompare(b.default_by)
    || a.created_at.localeCompare(b.created_at)
    || a.id.localeCompare(b.id));
}

/** The label of the option an answer names, or null for the member's own words. */
export function decisionAskOptionLabel(ask: Pick<DecisionAsk, 'options'>, key: string | null): string | null {
  if (!key) return null;
  return ask.options.find((option) => option.key === key)?.label ?? null;
}
