// The canonical meeting and its callback receipt share one synchronous SQL transaction.
// No transcript or second result copy is kept in the run ledger.
import { z } from 'zod';
import { meetingAgentContextSchema, meetingAgentPrepareSchema, meetingAgentRunSchema, meetingAgentReceiptSchema, meetingAgentResultSchema, MEETING_AGENT_GRANT_MS,
  MEETING_AGENT_CONTEXT_MAX_CHARACTERS, MEETING_AGENT_MAX_SEGMENTS, validateMeetingAgentResult,
  type MeetingAgentContext, type MeetingAgentPrepare, type MeetingAgentRun, type MeetingAgentResult,
  type MeetingAgentToolRequest, type MeetingAgentReceipt, type MeetingAgentStatus,
} from '@starlings/contracts/meeting-agent';
import { meetingActionItemSchema, meetingDecisionCandidateSchema, type MeetingActionItem, type MeetingDecisionCandidate } from '@starlings/contracts';
import type { MeetingAgentOperation, MeetingAgentPolicyFacts } from '@starlings/contracts/built-in-agent';
import { requireBuiltInMeetingAgentOperation } from './built-in-agent-policy';
import { meetingAgentHumanFacts, meetingAgentInstallation, meetingAgentWorkspaceId } from './meeting-agent-auth';
import { subjectOfCategory } from './meeting-category';
import { ControlError } from './errors';
import { sha256Hex } from './crypto';
import type { MeetingAgentHandoff } from '@starlings/contracts/meeting-agent';

export function migrateMeetingAgentStore(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS meeting_agent_runs (
    id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE,
    run_json TEXT NOT NULL, causes_json TEXT NOT NULL,
    receipt_json TEXT, result_digest TEXT, delivery_pending INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS meeting_agent_pending ON meeting_agent_runs(delivery_pending, meeting_id);`);
  const runColumns = sql.exec<{ name: string }>('PRAGMA table_info(meeting_agent_runs)').toArray();
  for (const [name, definition] of Object.entries({ dispatch_attempts: 'INTEGER NOT NULL DEFAULT 0', dispatch_lease_id: 'TEXT',
    dispatch_leased_until: 'INTEGER', dispatch_accepted_at: 'INTEGER', dispatch_runtime_id: 'TEXT' })) {
    if (!runColumns.some((column) => column.name === name)) sql.exec(`ALTER TABLE meeting_agent_runs ADD COLUMN ${name} ${definition}`);
  }
  const columns = sql.exec<{ name: string }>('PRAGMA table_info(meetings)').toArray();
  if (!columns.some((column) => column.name === 'agent_notes_metadata')) sql.exec('ALTER TABLE meetings ADD COLUMN agent_notes_metadata TEXT');
  if (!columns.some((column) => column.name === 'agent_personal')) sql.exec('ALTER TABLE meetings ADD COLUMN agent_personal INTEGER NOT NULL DEFAULT 0');
}

/** Historical notes have no structured questions; their existing Markdown projection still applies. */
export function meetingAgentOpenQuestions(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed = z.object({ open_questions: z.array(z.string()) }).safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.open_questions : null;
  } catch { return null; }
}

interface MeetingRow extends Record<string, SqlStorageValue> {
  id: string; started_at: number; ended_at: number | null; title: string | null;
  status: string; revision: number; transcript_revision: number; agent_personal: number;
  meeting_kind: string | null; lead_id: string | null; project_id: string | null;
  partner_organization_id: string | null; subject_title: string | null;
  summary: string | null; action_items: string | null; decision_candidates: string | null; follow_up: string | null;
}
interface RunRow extends Record<string, SqlStorageValue> {
  id: string; run_json: string; causes_json: string; receipt_json: string | null;
  result_digest: string | null; dispatch_attempts: number; dispatch_lease_id: string | null;
  dispatch_leased_until: number | null; dispatch_accepted_at: number | null; dispatch_runtime_id: string | null;
}
const causeSchema = z.object({
  finalization_event: z.object({ id: z.string(), meeting_id: z.string(), room_slug: z.string(), source_revision: z.string() }).nullable(),
  manual_requests: z.array(z.object({
    id: z.string(), actor_sub: z.string(), meeting_id: z.string(), room_slug: z.string(), source_revision: z.string(), operation: z.string(),
  })),
}).strict();

const conflict = () => new ControlError('The meeting changed. Prepare a new run.', 409, 'invalid_request');
const sourceRevision = (meeting: MeetingRow) => `transcript:${meeting.transcript_revision ?? 0}`;
const actionIdentity = (item: MeetingActionItem, index: number) => item.proposal_id ?? `legacy:action:${index}`;
const decisionIdentity = (item: MeetingDecisionCandidate, index: number) => item.proposal_id ?? `legacy:decision:${index}`;
function readActions(raw: string | null): MeetingActionItem[] {
  return raw ? z.array(meetingActionItemSchema).parse(JSON.parse(raw)) : [];
}
function readDecisions(raw: string | null): MeetingDecisionCandidate[] {
  return raw ? z.array(meetingDecisionCandidateSchema).parse(JSON.parse(raw)) : [];
}

export class MeetingAgentStore {
  constructor(private readonly storage: DurableObjectStorage, private readonly env: Env) {}
  private get sql(): SqlStorage { return this.storage.sql; }
  private room() {
    return this.sql.exec<{ slug: string; owner_sub: string }>('SELECT slug, owner_sub FROM room').one();
  }
  private meeting(id: string): MeetingRow {
    const row = this.sql.exec<MeetingRow>('SELECT * FROM meetings WHERE id = ?', id).toArray()[0];
    if (!row || row.status !== 'ended') throw new ControlError('No finalized meeting.', 403, 'capability_denied');
    return row;
  }
  private row(id: string): RunRow {
    const row = this.sql.exec<RunRow>('SELECT * FROM meeting_agent_runs WHERE id = ?', id).toArray()[0];
    if (!row) throw new ControlError('No such meeting run.', 404, 'meeting_not_found');
    return row;
  }

  /** Internal Worker RPC only. Later human/dispatch routes must prove their trigger before calling. */
  async prepare(input: MeetingAgentPrepare): Promise<MeetingAgentRun> {
    const request = meetingAgentPrepareSchema.parse(input);
    if (request.kind === 'built_in_product' && request.operation !== 'propose_notes') throw new ControlError('Invalid automatic operation.', 400, 'invalid_request');
    const workspaceId = await meetingAgentWorkspaceId(this.env);
    const installation = await meetingAgentInstallation(this.env, request.installation_id);
    const room = this.room();
    const meeting = this.meeting(request.meeting_id);
    const revision = sourceRevision(meeting);
    const dedupeKey = JSON.stringify([workspaceId, installation.id, meeting.id, revision, request.kind,
      request.kind === 'built_in_product' ? 'finalized' : request.correlation_id]);
    const duplicate = this.sql.exec<RunRow>('SELECT * FROM meeting_agent_runs WHERE dedupe_key = ?', dedupeKey).toArray()[0];
    if (duplicate) {
      const run = meetingAgentRunSchema.parse(JSON.parse(duplicate.run_json));
      if (run.invocation.actor_sub !== request.actor_sub || run.invocation.operation !== request.operation || run.skill_version !== request.skill_version) throw conflict();
      await this.authorize(run.id, installation.agent_sub, run.invocation.operation);
      return run;
    }
    const now = Date.now();
    const runId = crypto.randomUUID();
    const grantId = crypto.randomUUID();
    const causeId = crypto.randomUUID();
    const run = meetingAgentRunSchema.parse({
      id: runId, expected_result_revision: meeting.revision ?? 0,
      correlation_id: request.correlation_id, skill_version: request.skill_version,
      invocation: {
        id: crypto.randomUUID(), kind: request.kind, workspace_id: workspaceId, installation_id: installation.id,
        agent_sub: installation.agent_sub, actor_sub: request.actor_sub, meeting_id: meeting.id, room_slug: room.slug,
        source_revision: revision, grant_id: grantId, operation: request.operation, causation_id: causeId,
      },
      grant: {
        id: grantId, workspace_id: workspaceId, installation_id: installation.id, agent_sub: installation.agent_sub,
        authorized_by_sub: request.actor_sub, kind: request.kind, meeting_id: meeting.id, room_slug: room.slug,
        source_revision: revision, operations: ['read_finalized', request.operation, 'draft_follow_up'],
        issued_at: now, expires_at: now + MEETING_AGENT_GRANT_MS, revoked_at: null,
      },
    });
    // The persisted ended row is the product trigger. Manual causes are persisted
    // individually, so reading is not invented addressing for a different operation.
    const causes = causeSchema.parse({
      finalization_event: request.kind === 'built_in_product'
        ? { id: causeId, meeting_id: meeting.id, room_slug: room.slug, source_revision: revision } : null,
      manual_requests: request.kind === 'manual' ? run.grant.operations.map((operation) => ({
        id: causeId, actor_sub: request.actor_sub, meeting_id: meeting.id, room_slug: room.slug, source_revision: revision, operation,
      })) : [],
    });
    const subject = categorySubject(meeting);
    const humanFacts = await meetingAgentHumanFacts(this.env, request.actor_sub, installation.agent_sub, subject);
    // Re-read after I/O: changes during permission loading cannot enter the grant.
    const current = this.meeting(meeting.id);
    if (current.revision !== meeting.revision || sourceRevision(current) !== revision) throw conflict();
    requireBuiltInMeetingAgentOperation(this.facts(run, installation.agent_sub, workspaceId, installation, humanFacts, current, causes, request.operation));
    // Two concurrent preparations can meet here; reuse the durable unique trigger.
    this.sql.exec(`INSERT INTO meeting_agent_runs (id, meeting_id, dedupe_key, run_json, causes_json)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(dedupe_key) DO NOTHING`, run.id, meeting.id, dedupeKey, JSON.stringify(run), JSON.stringify(causes));
    const saved = this.sql.exec<RunRow>('SELECT * FROM meeting_agent_runs WHERE dedupe_key = ?', dedupeKey).one();
    const savedRun = meetingAgentRunSchema.parse(JSON.parse(saved.run_json));
    if (savedRun.invocation.actor_sub !== request.actor_sub || savedRun.invocation.operation !== request.operation || savedRun.skill_version !== request.skill_version) throw conflict();
    return savedRun;
  }

  /** Trusted Worker lookup: receipts remain recoverable after expiry/freeze, without exposing source. */
  automatic(meetingId: string): MeetingAgentRun | null {
    const row = this.sql.exec<RunRow>(`SELECT * FROM meeting_agent_runs WHERE meeting_id = ?
      AND json_extract(run_json, '$.invocation.kind') = 'built_in_product' ORDER BY rowid DESC LIMIT 1`, meetingId).toArray()[0];
    return row ? meetingAgentRunSchema.parse(JSON.parse(row.run_json)) : null;
  }

  /** Persist a finite lease and attempt before HTTP. Two queues cannot dispatch together. */
  async claimDispatch(runId: string): Promise<{ job: MeetingAgentHandoff; lease_id: string } | null> {
    const original = meetingAgentRunSchema.parse(JSON.parse(this.row(runId).run_json));
    const { run, row, current } = await this.authorize(runId, original.invocation.agent_sub, 'propose_notes');
    if (row.receipt_json || current.summary !== null) return null;
    this.context(run, current); // Refuse changed or oversized source before sending a handoff.
    const now = Date.now();
    if ((row.dispatch_leased_until ?? 0) > now || (row.dispatch_accepted_at ?? 0) > now - 120_000) return null;
    if (row.dispatch_attempts >= 6) return null; // Owed-notes sweep reconciles at grant expiry.
    const leaseId = crypto.randomUUID();
    this.sql.exec(`UPDATE meeting_agent_runs SET dispatch_lease_id = ?, dispatch_leased_until = ?, dispatch_attempts = dispatch_attempts + 1 WHERE id = ?`,
      leaseId, now + 60_000, run.id);
    return { lease_id: leaseId, job: {
      kind: 'meeting_follow_through', workspace_id: run.invocation.workspace_id,
      installation_id: run.invocation.installation_id, agent_sub: run.invocation.agent_sub,
      room_slug: this.room().slug, meeting_id: run.invocation.meeting_id, source_revision: run.invocation.source_revision,
      run_id: run.id, skill_version: run.skill_version, deadline_at: run.grant.expires_at,
    } };
  }

  accepted(runId: string, leaseId: string, runtimeId: string | null): void {
    this.sql.exec(`UPDATE meeting_agent_runs SET dispatch_accepted_at = ?, dispatch_runtime_id = COALESCE(?, dispatch_runtime_id),
      dispatch_lease_id = NULL, dispatch_leased_until = NULL WHERE id = ? AND dispatch_lease_id = ?`, Date.now(), runtimeId, runId, leaseId);
  }
  releaseDispatch(runId: string, leaseId: string): void {
    this.sql.exec('UPDATE meeting_agent_runs SET dispatch_lease_id = NULL, dispatch_leased_until = NULL WHERE id = ? AND dispatch_lease_id = ?', runId, leaseId);
  }

  /** One synchronous turn with the Room's freshly built deterministic notes. Never overwrite a human or agent result. */
  fallback(meetingId: string, notes: { title: string; summary: string }, reason: string): boolean {
    const meeting = this.meeting(meetingId);
    if (meeting.summary !== null) return false;
    this.storage.transactionSync(() => {
      this.sql.exec(`UPDATE meetings SET title = ?, summary = ?, summary_model = NULL, summary_revision = transcript_revision,
        agent_notes_metadata = ?, revision = revision + 1 WHERE id = ?`, meeting.title ?? notes.title, notes.summary,
        JSON.stringify({ actor_kind: 'system', outcome: 'fallback', reason }), meetingId);
      // Fallback ends this assignment. Old callbacks cannot replace it or accepted work.
      for (const row of this.sql.exec<RunRow>('SELECT * FROM meeting_agent_runs WHERE meeting_id = ? AND receipt_json IS NULL', meetingId).toArray()) {
        this.revoke(row.id);
      }
    });
    return true;
  }

  private facts(run: MeetingAgentRun, agentSub: string, workspaceId: string, installation: unknown,
    humanFacts: Awaited<ReturnType<typeof meetingAgentHumanFacts>>, meeting: MeetingRow,
    causes: z.infer<typeof causeSchema>, operation: MeetingAgentOperation): MeetingAgentPolicyFacts {
    const invocation = { ...run.invocation, operation };
    return {
      now: Date.now(), workspace_id: workspaceId, authenticated_agent_sub: agentSub, installation,
      grant: run.grant, invocation,
      meeting: {
        id: meeting.id, room_slug: this.room().slug, source_revision: sourceRevision(meeting),
        ended_at: meeting.ended_at, owner_sub: this.room().owner_sub,
        personal: meeting.agent_personal !== 0 || meeting.meeting_kind === 'personal', filed: categorySubject(meeting) !== null,
      },
      ...humanFacts, finalization_event: causes.finalization_event,
      manual_request: causes.manual_requests.find((cause) => cause.operation === operation) ?? null,
    };
  }

  private async authorize(runId: string, agentSub: string, operation: MeetingAgentOperation) {
    const run = meetingAgentRunSchema.parse(JSON.parse(this.row(runId).run_json));
    const workspaceId = await meetingAgentWorkspaceId(this.env);
    const installation = await meetingAgentInstallation(this.env, run.invocation.installation_id);
    const before = this.meeting(run.invocation.meeting_id);
    const humanFacts = await meetingAgentHumanFacts(this.env, run.invocation.actor_sub, run.invocation.agent_sub, categorySubject(before));
    const current = this.meeting(before.id);
    if (JSON.stringify(categorySubject(current)) !== JSON.stringify(categorySubject(before))) throw conflict();
    const row = this.row(runId);
    // Revocations can arrive while D1 is being read; use the current persisted grant.
    const freshRun = meetingAgentRunSchema.parse(JSON.parse(row.run_json));
    const causes = causeSchema.parse(JSON.parse(row.causes_json));
    requireBuiltInMeetingAgentOperation(this.facts(freshRun, agentSub, workspaceId, installation, humanFacts, current, causes, operation));
    return { run: freshRun, row, current };
  }

  private checkRequest(request: MeetingAgentToolRequest, run: MeetingAgentRun): void {
    if (request.workspace_id !== run.invocation.workspace_id || request.room_slug !== this.room().slug
      || request.meeting_id !== run.invocation.meeting_id || request.run_id !== run.id) throw new ControlError('Meeting scope mismatch.', 403, 'capability_denied');
  }

  private context(run: MeetingAgentRun, meeting: MeetingRow): MeetingAgentContext {
    if (meeting.revision !== run.expected_result_revision) throw conflict();
    const size = this.sql.exec<{ count: number; characters: number }>(`SELECT COUNT(*) AS count, COALESCE(SUM(length(text)), 0) AS characters
      FROM transcript_segments WHERE meeting_id = ? AND is_final = 1`, meeting.id).one();
    if (size.count > MEETING_AGENT_MAX_SEGMENTS || size.characters > MEETING_AGENT_CONTEXT_MAX_CHARACTERS) {
      throw new ControlError('This meeting needs a longer-input coverage strategy.', 413, 'invalid_request');
    }
    const source = this.sql.exec<{
      id: string; speaker_id: string; speaker_name: string; starts_at_ms: number; ends_at_ms: number; text: string;
    }>(`SELECT id, speaker_id, speaker_name, starts_at_ms, ends_at_ms, text
      FROM transcript_segments WHERE meeting_id = ? AND is_final = 1 ORDER BY starts_at_ms, id`, meeting.id).toArray();
    // Fail explicitly for long inputs. The runtime owes evaluated coverage; never slice a tail away.
    if (source.length > MEETING_AGENT_MAX_SEGMENTS || source.reduce((total, segment) => total + segment.text.length, 0) > MEETING_AGENT_CONTEXT_MAX_CHARACTERS) {
      throw new ControlError('This meeting needs a longer-input coverage strategy.', 413, 'invalid_request');
    }
    const speakers = new Map<string, string>();
    const segments = source.map(({ speaker_id, ...segment }) => {
      if (!speakers.has(speaker_id)) speakers.set(speaker_id, `speaker:${speakers.size + 1}`);
      return { ...segment, speaker: speakers.get(speaker_id)! };
    });
    const participants = this.sql.exec<{ name: string }>('SELECT DISTINCT name FROM participants WHERE meeting_id = ? ORDER BY name', meeting.id)
      .toArray().map((person, index) => ({ id: `participant:${index + 1}`, display_name: person.name }));
    const previous_proposals: MeetingAgentContext['previous_proposals'] = [
      ...readActions(meeting.action_items).map((item, index) => ({
        id: actionIdentity(item, index), kind: 'action' as const, what: item.what,
        state: item.task_id ? 'filed' as const : 'proposed' as const, source_segment_ids: item.source_segment_ids ?? [], quote: item.quote,
      })),
      ...readDecisions(meeting.decision_candidates).map((item, index) => ({
        id: decisionIdentity(item, index), kind: 'decision' as const, what: item.what,
        state: item.decision_id ? 'recorded' as const : item.dismissed ? 'dismissed' as const : 'proposed' as const,
        source_segment_ids: item.source_segment_ids ?? [], quote: item.quote,
      })),
    ];
    const subject = categorySubject(meeting);
    return meetingAgentContextSchema.parse({
      workspace_id: run.invocation.workspace_id, installation_id: run.invocation.installation_id,
      agent_sub: run.invocation.agent_sub, actor_sub: run.invocation.actor_sub, room_slug: this.room().slug,
      meeting_id: meeting.id, source_revision: sourceRevision(meeting), grant_id: run.grant.id,
      invocation_id: run.invocation.id, run_id: run.id, correlation_id: run.correlation_id,
      expected_result_revision: run.expected_result_revision, content_kind: 'untrusted_meeting_source',
      started_at: meeting.started_at, ended_at: meeting.ended_at, title: meeting.title,
      participants, segments, subject: subject ? { ...subject, title: meeting.subject_title } : null, agenda: null,
      previous_proposals, skill_version: run.skill_version,
    });
  }

  async read(request: MeetingAgentToolRequest, agentSub: string): Promise<MeetingAgentContext> {
    const { run, current } = await this.authorize(request.run_id, agentSub, 'read_finalized');
    this.checkRequest(request, run);
    return this.context(run, current);
  }

  async status(request: MeetingAgentToolRequest, agentSub: string): Promise<MeetingAgentStatus> {
    const { run, row } = await this.authorize(request.run_id, agentSub, 'read_finalized');
    this.checkRequest(request, run);
    const receipt = row.receipt_json ? meetingAgentReceiptSchema.parse(JSON.parse(row.receipt_json)) : null;
    return { run_id: run.id, state: receipt ? 'committed' : 'prepared', receipt };
  }

  async commit(request: MeetingAgentToolRequest, agentSub: string, input: MeetingAgentResult): Promise<MeetingAgentReceipt> {
    // Schema order makes the receipt independent of JSON key order and entry point.
    const parsed = meetingAgentResultSchema.safeParse(input);
    if (!parsed.success) throw new ControlError('Meeting result is invalid.', 400, 'invalid_request');
    input = parsed.data;
    const digest = await sha256Hex(JSON.stringify(input));
    const original = meetingAgentRunSchema.parse(JSON.parse(this.row(request.run_id).run_json));
    if (original.invocation.operation !== 'propose_notes' && original.invocation.operation !== 'revise_notes') {
      throw new ControlError('This run cannot write notes.', 403, 'capability_denied');
    }
    const { run, row, current } = await this.authorize(request.run_id, agentSub, original.invocation.operation);
    this.checkRequest(request, run);
    if (row.receipt_json) {
      if (row.result_digest !== digest) throw new ControlError('This run already committed a different result.', 409, 'invalid_request');
      return meetingAgentReceiptSchema.parse(JSON.parse(row.receipt_json));
    }
    const context = this.context(run, current);
    let result: MeetingAgentResult;
    try { result = validateMeetingAgentResult(context, input); }
    catch { throw new ControlError('Meeting result or transcript evidence is invalid.', 400, 'invalid_request'); }
    // A follow-up is part of the grant's explicit operations, never implied by notes.
    if (result.follow_up && !run.grant.operations.includes('draft_follow_up')) throw new ControlError('Follow-up drafting was not granted.', 403, 'capability_denied');
    const previousActions = readActions(current.action_items);
    const previousDecisions = readDecisions(current.decision_candidates);
    const retainedActions = previousActions.flatMap((item, index) => item.task_id ? [{ ...item, proposal_id: actionIdentity(item, index) }] : []);
    const retainedDecisions = previousDecisions.flatMap((item, index) => item.decision_id || item.dismissed ? [{ ...item, proposal_id: decisionIdentity(item, index) }] : []);
    const protectedIds = new Set([...retainedActions, ...retainedDecisions].map((item) => item.proposal_id));
    const actions = [...retainedActions, ...result.action_items.filter((item) => !protectedIds.has(item.proposal_id)).map((item) => ({ ...item, task_id: null }))];
    const decisions = [...retainedDecisions, ...result.decision_candidates.filter((item) => !protectedIds.has(item.proposal_id)).map((item) => ({ ...item, decision_id: null, dismissed: false }))];
    if (actions.length > 60 || decisions.length > 40) throw new ControlError('Preserved proposals exceed the meeting limit.', 409, 'invalid_request');
    const followUp = current.follow_up ? JSON.parse(current.follow_up) : null;
    const nextFollowUp = followUp?.approvedAt || followUp?.dismissedAt ? followUp : result.follow_up ? {
      draft: result.follow_up, revision: (followUp?.revision ?? 0) + 1, writtenAt: Date.now(),
      approvedRevision: null, approvedAt: null, dismissedAt: null,
    } : null;
    const receipt: MeetingAgentReceipt = {
      workspace_id: context.workspace_id, room_slug: context.room_slug, meeting_id: current.id, run_id: run.id,
      source_revision: context.source_revision, result_revision: current.revision + 1, committed_at: Date.now(), outcome: 'committed',
    };
    this.storage.transactionSync(() => {
      this.sql.exec(`UPDATE meetings SET title = ?, summary = ?, summary_revision = transcript_revision,
        action_items = ?, decision_candidates = ?, follow_up = ?, summary_model = ?, agent_notes_metadata = ?, revision = revision + 1 WHERE id = ?`,
      result.title, result.summary, JSON.stringify(actions), JSON.stringify(decisions), nextFollowUp ? JSON.stringify(nextFollowUp) : null,
      result.model, JSON.stringify({ agent_sub: context.agent_sub, installation_id: context.installation_id, actor_sub: context.actor_sub,
        grant_id: context.grant_id, invocation_id: context.invocation_id, run_id: run.id, correlation_id: context.correlation_id,
        source_revision: context.source_revision, model: result.model, skill_version: result.skill_version,
        open_questions: result.open_questions, outcome: 'committed', committed_at: receipt.committed_at }), current.id);
      this.sql.exec('UPDATE meeting_agent_runs SET receipt_json = ?, result_digest = ?, delivery_pending = 1 WHERE id = ?', JSON.stringify(receipt), digest, run.id);
    });
    return receipt;
  }

  /** Trusted Worker revocation; late callbacks re-read this persisted grant. */
  revoke(runId: string): void {
    const run = meetingAgentRunSchema.parse(JSON.parse(this.row(runId).run_json));
    run.grant.revoked_at = Date.now();
    this.sql.exec('UPDATE meeting_agent_runs SET run_json = ? WHERE id = ?', JSON.stringify(run), runId);
  }
  pendingDeliveries(): Array<{ meeting_id: string; run_id: string }> {
    return this.sql.exec<{ meeting_id: string; run_id: string }>(`SELECT meeting_id, id AS run_id FROM meeting_agent_runs WHERE delivery_pending = 1 LIMIT 20`).toArray();
  }
  delivered(runId: string): void {
    this.sql.exec('UPDATE meeting_agent_runs SET delivery_pending = 0 WHERE id = ?', runId);
  }
}

function categorySubject(row: MeetingRow) {
  return subjectOfCategory({ meetingKind: row.meeting_kind ?? 'uncategorized', leadId: row.lead_id,
    projectId: row.project_id, partnerOrganizationId: row.partner_organization_id });
}
