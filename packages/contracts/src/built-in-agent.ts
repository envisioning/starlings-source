import { z } from 'zod';
import { roomSlugSchema } from './room-slug';
import { accessAtLeast, type SubjectAccessLevel } from './subject-access';

/** Stable role; a display name or model upgrade never creates another identity. */
export const BUILT_IN_MEETING_AGENT_ROLE = 'meeting_follow_through';
export const BUILT_IN_MEETING_AGENT_NAME = 'Steward';
export const builtInAgentStateSchema = z.enum(['provisioning', 'ready', 'paused', 'frozen', 'removed']);
export const meetingAgentOperationSchema = z.enum(['read_finalized', 'propose_notes', 'explain_notes', 'revise_notes', 'draft_follow_up']);
export type MeetingAgentOperation = z.infer<typeof meetingAgentOperationSchema>;
export const agentInvocationKindSchema = z.enum(['manual', 'built_in_product', 'subscription']);

const id = z.string().min(1).max(200);
const revision = z.string().min(1).max(128);
// Epoch milliseconds, matching the Worker's persisted event/grant clocks.
const timestamp = z.number().int().nonnegative();

/** Effective roster snapshot, not a second roster or a source of runtime secrets. */
export const builtInAgentInstallationSchema = z.object({
  id,
  workspace_id: id,
  role: z.literal(BUILT_IN_MEETING_AGENT_ROLE),
  kind: z.literal('agent'),
  source: z.literal('starlings_managed'),
  agent_sub: id,
  agent_email: z.string().email().max(320),
  display_name: z.string().trim().min(1).max(60),
  state: builtInAgentStateSchema,
}).strict();
export type BuiltInAgentInstallation = z.infer<typeof builtInAgentInstallationSchema>;

/** One human, installation, meeting and exact transcript revision; never a workspace-wide reader. */
export const meetingAgentGrantSchema = z.object({
  id,
  workspace_id: id,
  installation_id: id,
  agent_sub: id,
  authorized_by_sub: id,
  kind: z.enum(['manual', 'built_in_product']),
  meeting_id: id,
  room_slug: roomSlugSchema,
  source_revision: revision,
  operations: z.array(meetingAgentOperationSchema).min(1).max(5),
  issued_at: timestamp,
  expires_at: timestamp,
  revoked_at: timestamp.nullable(),
}).strict().superRefine((grant, ctx) => {
  if (grant.expires_at <= grant.issued_at) ctx.addIssue({ code: 'custom', path: ['expires_at'], message: 'Expiry follows issuance.' });
  if (new Set(grant.operations).size !== grant.operations.length) ctx.addIssue({ code: 'custom', path: ['operations'], message: 'Operations must be unique.' });
  if (grant.kind === 'built_in_product' && grant.operations.some((operation) => !productOperation(operation))) {
    ctx.addIssue({ code: 'custom', path: ['operations'], message: 'Automatic processing only reads, proposes notes and drafts a follow-up.' });
  }
});
export type MeetingAgentGrant = z.infer<typeof meetingAgentGrantSchema>;

export const meetingAgentInvocationSchema = z.object({
  id,
  kind: agentInvocationKindSchema,
  workspace_id: id,
  installation_id: id,
  agent_sub: id,
  actor_sub: id,
  meeting_id: id,
  room_slug: roomSlugSchema,
  source_revision: revision,
  grant_id: id,
  operation: meetingAgentOperationSchema,
  /** Persisted human request or finalized-meeting event, never invented addressing. */
  causation_id: id,
}).strict();
export type MeetingAgentInvocation = z.infer<typeof meetingAgentInvocationSchema>;

export const meetingAgentDecisionSchema = z.object({
  allowed: z.boolean(),
  reason: z.enum([
    'allowed', 'invalid_contract', 'unsupported_invocation', 'scope_mismatch',
    'actor_mismatch', 'human_unavailable', 'agent_unavailable',
    'automatic_processing_paused', 'grant_inactive', 'meeting_not_finalized',
    'personal_meeting', 'not_meeting_owner', 'unfiled_manual_access_denied',
    'subject_access_denied', 'operation_not_granted', 'manual_request_required', 'finalization_event_required',
  ]),
});
export type MeetingAgentDecision = z.infer<typeof meetingAgentDecisionSchema>;

/** Rule inputs loaded by the server. These facts must never come from a runtime request body. */
export interface MeetingAgentPolicyFacts {
  now: number;
  workspace_id: string;
  authenticated_agent_sub: string;
  installation: unknown;
  grant: unknown;
  invocation: unknown;
  meeting: {
    id: string;
    room_slug: string;
    source_revision: string;
    ended_at: number | null;
    owner_sub: string;
    personal: boolean;
    filed: boolean;
  };
  human: { sub: string; kind: string; role: string; revoked: boolean };
  subject_access: { human: SubjectAccessLevel; agent: SubjectAccessLevel } | null;
  finalization_event: { id: string; meeting_id: string; room_slug: string; source_revision: string } | null;
  manual_request: {
    id: string;
    actor_sub: string;
    meeting_id: string;
    room_slug: string;
    source_revision: string;
    operation: string;
  } | null;
}

function productOperation(operation: string): boolean {
  return operation === 'read_finalized' || operation === 'propose_notes' || operation === 'draft_follow_up';
}

/** A product grant is included assistance, never a customer subscription entitlement or an MCP bypass. */
export function meetingAgentDecision(facts: MeetingAgentPolicyFacts): MeetingAgentDecision {
  const deny = (reason: MeetingAgentDecision['reason']): MeetingAgentDecision => ({ allowed: false, reason });
  const installation = builtInAgentInstallationSchema.safeParse(facts.installation);
  const grant = meetingAgentGrantSchema.safeParse(facts.grant);
  const invocation = meetingAgentInvocationSchema.safeParse(facts.invocation);
  if (!installation.success || !grant.success || !invocation.success || !Number.isFinite(facts.now) || facts.now < 0) return deny('invalid_contract');
  const agent = installation.data;
  const authority = grant.data;
  const call = invocation.data;
  const meeting = facts.meeting;
  if (typeof meeting.filed !== 'boolean') return deny('invalid_contract');
  if (call.kind === 'subscription') return deny('unsupported_invocation');
  if (agent.workspace_id !== facts.workspace_id || authority.workspace_id !== facts.workspace_id || call.workspace_id !== facts.workspace_id
    || agent.agent_sub !== facts.authenticated_agent_sub || authority.agent_sub !== agent.agent_sub || call.agent_sub !== agent.agent_sub
    || authority.installation_id !== agent.id || call.installation_id !== agent.id || call.grant_id !== authority.id
    || call.kind !== authority.kind || authority.meeting_id !== meeting.id || call.meeting_id !== meeting.id
    || authority.room_slug !== meeting.room_slug || call.room_slug !== meeting.room_slug
    || authority.source_revision !== meeting.source_revision || call.source_revision !== meeting.source_revision) return deny('scope_mismatch');
  if (call.actor_sub !== authority.authorized_by_sub || facts.human.sub !== authority.authorized_by_sub) return deny('actor_mismatch');
  if (facts.human.kind !== 'human' || facts.human.revoked !== false || !['admin', 'member'].includes(facts.human.role)) return deny('human_unavailable');
  if (agent.state !== 'ready' && agent.state !== 'paused') return deny('agent_unavailable');
  if (agent.state === 'paused' && call.kind === 'built_in_product') return deny('automatic_processing_paused');
  if (authority.revoked_at !== null || authority.issued_at > facts.now || authority.expires_at <= facts.now) return deny('grant_inactive');
  if (meeting.ended_at === null || !Number.isFinite(meeting.ended_at) || meeting.ended_at < 0 || meeting.ended_at > facts.now) return deny('meeting_not_finalized');
  // A personal meeting never becomes shared-agent context, including via the product path.
  if (meeting.personal !== false) return deny('personal_meeting');
  if (call.kind === 'built_in_product' && authority.authorized_by_sub !== meeting.owner_sub) return deny('not_meeting_owner');
  if (meeting.filed !== true) {
    if (call.kind !== 'built_in_product') return deny('unfiled_manual_access_denied');
  } else {
    const needed = call.operation === 'read_finalized' || call.operation === 'explain_notes' ? 'read' : 'write';
    if (!facts.subject_access || !accessAtLeast(facts.subject_access.human, needed) || !accessAtLeast(facts.subject_access.agent, needed)) return deny('subject_access_denied');
  }
  if (!authority.operations.includes(call.operation)) return deny('operation_not_granted');
  if (call.kind === 'built_in_product') {
    const event = facts.finalization_event;
    if (!event || event.id !== call.causation_id || event.meeting_id !== meeting.id
      || event.room_slug !== meeting.room_slug || event.source_revision !== meeting.source_revision) return deny('finalization_event_required');
  }
  if (call.kind === 'manual') {
    const request = facts.manual_request;
    if (!request || request.id !== call.causation_id || request.actor_sub !== call.actor_sub || request.meeting_id !== meeting.id
      || request.room_slug !== meeting.room_slug || request.source_revision !== meeting.source_revision || request.operation !== call.operation) return deny('manual_request_required');
  }
  return { allowed: true, reason: 'allowed' };
}
