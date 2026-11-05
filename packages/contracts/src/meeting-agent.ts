import { z } from 'zod';
import { meetingAgentInvocationSchema, meetingAgentGrantSchema } from './built-in-agent';
import { roomSlugSchema } from './room-slug';
import { meetingFollowUpDraftSchema } from './meeting-notes';

const id = z.string().min(1).max(200);
const proposalId = z.string().min(1).max(128);
const revision = z.string().min(1).max(128);
const timestamp = z.number().int().nonnegative();
export const MEETING_AGENT_CONTEXT_MAX_CHARACTERS = 400_000;
export const MEETING_AGENT_MAX_SEGMENTS = 12_000;
/** The managed runtime refuses a hand-off whose `deadline_at` is further
 * ahead than this (Steward's `MAX_DURATION_MS`). */
export const MEETING_AGENT_MAX_DURATION_MS = 10 * 60_000;
/** A meeting run's grant, and so its hand-off `deadline_at`. One minute
 * under the runtime's limit, so clock skew between the Worker and the
 * runtime cannot push a fresh hand-off over it. */
export const MEETING_AGENT_GRANT_MS = MEETING_AGENT_MAX_DURATION_MS - 60_000;

/** Explicitly untrusted text. No address, media, token or external document metadata. */
export const meetingAgentSegmentSchema = z.object({
  id, speaker: z.string().min(1).max(80), speaker_name: z.string().max(200),
  starts_at_ms: timestamp, ends_at_ms: timestamp, text: z.string().max(20_000),
}).strict();
export type MeetingAgentSegment = z.infer<typeof meetingAgentSegmentSchema>;

const scope = {
  workspace_id: id, installation_id: id, agent_sub: id, actor_sub: id,
  room_slug: roomSlugSchema, meeting_id: id, source_revision: revision,
  grant_id: id, invocation_id: id, run_id: id, correlation_id: id,
  expected_result_revision: timestamp,
};
export const meetingAgentToolRequestSchema = z.object({
  workspace_id: id, room_slug: roomSlugSchema, meeting_id: id, run_id: id,
}).strict();
export type MeetingAgentToolRequest = z.infer<typeof meetingAgentToolRequestSchema>;

/** Signed managed-runtime handoff. No transcript or callback URL rides with the job. */
export const meetingAgentHandoffSchema = meetingAgentToolRequestSchema.extend({
  kind: z.literal('meeting_follow_through'),
  installation_id: id,
  agent_sub: id,
  source_revision: revision,
  skill_version: z.string().min(1).max(80),
  deadline_at: timestamp,
}).strict();
export type MeetingAgentHandoff = z.infer<typeof meetingAgentHandoffSchema>;

export const meetingAgentAcknowledgementSchema = z.object({
  accepted: z.literal(true), run_id: id, runtime_run_id: z.string().regex(/^wrun_[A-Za-z0-9]{26}$/).optional(),
  session_key: z.string().optional(), outcome: z.literal('committed').optional(),
}).strict();
export const meetingAgentRuntimeProbeRequestSchema = z.object({
  job: meetingAgentHandoffSchema, runtime_run_id: z.string().regex(/^wrun_[A-Za-z0-9]{26}$/),
}).strict();
export const meetingAgentRuntimeProbeResponseSchema = z.object({
  erased: z.literal(true), runtime_run_id: z.string(), expired_at: timestamp,
}).strict();


export const meetingAgentContextSchema = z.object({
  ...scope,
  content_kind: z.literal('untrusted_meeting_source'),
  started_at: timestamp, ended_at: timestamp, title: z.string().nullable(),
  participants: z.array(z.object({ id, display_name: z.string().max(200) }).strict()).max(100),
  segments: z.array(meetingAgentSegmentSchema).max(MEETING_AGENT_MAX_SEGMENTS),
  /** Only the meeting's already-authorized filing, never fetched private documents. */
  subject: z.object({ kind: z.enum(['project', 'lead', 'organization']), id, title: z.string().nullable() }).strict().nullable(),
  /** No agenda is persisted on hosted meetings yet. Null explicitly means unavailable. */
  agenda: z.string().max(20_000).nullable(),
  previous_proposals: z.array(z.object({
    id: proposalId, kind: z.enum(['action', 'decision']), what: z.string(),
    state: z.enum(['proposed', 'filed', 'recorded', 'dismissed']),
    source_segment_ids: z.array(id).max(20), quote: z.string().nullable(),
  }).strict()).max(100),
  skill_version: z.string().min(1).max(80),
}).strict();
export type MeetingAgentContext = z.infer<typeof meetingAgentContextSchema>;

const evidence = {
  proposal_id: proposalId,
  what: z.string().trim().min(1).max(2_000),
  source_segment_ids: z.array(id).min(1).max(20),
  quote: z.string().min(1).max(4_000),
  at_ms: timestamp,
};
/** Models propose facts. They cannot carry task ids, recorded ids or dismissal state. */
export const meetingAgentActionSchema = z.object({
  ...evidence, who: z.string().max(200).nullable(), by_when: z.string().max(120).nullable(),
}).strict();
export const meetingAgentDecisionCandidateSchema = z.object(evidence).strict();
export const meetingAgentResultSchema = z.object({
  ...scope,
  title: z.string().trim().max(160), summary: z.string().max(30_000),
  action_items: z.array(meetingAgentActionSchema).max(60),
  decision_candidates: z.array(meetingAgentDecisionCandidateSchema).max(40),
  open_questions: z.array(z.string().trim().min(1).max(2_000)).max(40),
  follow_up: meetingFollowUpDraftSchema.strict().nullable(),
  model: z.string().min(1).max(80), skill_version: z.string().min(1).max(80),
}).strict();
export type MeetingAgentResult = z.infer<typeof meetingAgentResultSchema>;
export const meetingAgentCommitRequestSchema = z.object({
  ...meetingAgentToolRequestSchema.shape, result: meetingAgentResultSchema,
}).strict();
export type MeetingAgentCommitRequest = z.infer<typeof meetingAgentCommitRequestSchema>;

export const meetingAgentReceiptSchema = z.object({
  workspace_id: id, room_slug: roomSlugSchema, meeting_id: id, run_id: id,
  source_revision: revision, result_revision: timestamp, committed_at: timestamp,
  outcome: z.literal('committed'),
}).strict();
export type MeetingAgentReceipt = z.infer<typeof meetingAgentReceiptSchema>;
export const meetingAgentStatusSchema = z.object({
  run_id: id, state: z.enum(['prepared', 'committed']), receipt: meetingAgentReceiptSchema.nullable(),
}).strict();
export type MeetingAgentStatus = z.infer<typeof meetingAgentStatusSchema>;

/** Trusted Worker RPC only. The runtime has no prepare or grant-minting route. */
export const meetingAgentPrepareSchema = z.object({
  meeting_id: id, installation_id: id, actor_sub: id,
  kind: z.enum(['built_in_product', 'manual']),
  operation: z.enum(['propose_notes', 'revise_notes']),
  skill_version: z.string().min(1).max(80),
  correlation_id: id,
}).strict();
export type MeetingAgentPrepare = z.infer<typeof meetingAgentPrepareSchema>;
export const meetingAgentRunSchema = z.object({
  id, invocation: meetingAgentInvocationSchema,
  grant: meetingAgentGrantSchema, expected_result_revision: timestamp,
  correlation_id: id, skill_version: z.string().min(1).max(80),
}).strict();
export type MeetingAgentRun = z.infer<typeof meetingAgentRunSchema>;

/** Server validation; transcript text cannot manufacture bindings or accepted work. */
export function validateMeetingAgentResult(context: MeetingAgentContext, input: unknown): MeetingAgentResult {
  const result = meetingAgentResultSchema.parse(input);
  for (const key of Object.keys(scope) as Array<keyof typeof scope>) {
    if (result[key] !== context[key]) throw new Error('Meeting result scope does not match its context.');
  }
  if (result.skill_version !== context.skill_version) throw new Error('Meeting skill version changed.');
  const segments = new Map(context.segments.map((segment) => [segment.id, segment]));
  const seen = new Set<string>();
  for (const [kind, proposals] of [['action', result.action_items], ['decision', result.decision_candidates]] as const) {
    for (const proposal of proposals) {
      if (seen.has(proposal.proposal_id)) throw new Error('Proposal identities must be unique.');
      seen.add(proposal.proposal_id);
      if (new Set(proposal.source_segment_ids).size !== proposal.source_segment_ids.length) throw new Error('Evidence segments must be unique.');
      const evidence = proposal.source_segment_ids.map((segmentId) => segments.get(segmentId));
      if (evidence.some((segment) => !segment)) throw new Error('Evidence names an unauthorized segment.');
      // A quote is verbatim within one cited segment; a stitched or fabricated quote is refused.
      if (!evidence.some((segment) => segment?.text.includes(proposal.quote) && proposal.at_ms === segment.starts_at_ms)) {
        throw new Error('Evidence quote or offset does not match the transcript.');
      }
      const previous = context.previous_proposals.find((item) => item.id === proposal.proposal_id);
      if (previous && previous.kind !== kind) throw new Error('A proposal cannot change kind.');
      // Stable ids are the only match. Similar titles without one require human review.
      if (!previous && context.previous_proposals.some((item) => item.kind === kind
        && (normalized(item.what) === normalized(proposal.what) || item.quote === proposal.quote))) {
        throw new Error('An ambiguous proposal match needs review.');
      }
    }
  }
  return result;
}

function normalized(text: string): string {
  return text.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ');
}
