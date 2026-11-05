import { installationProbe, probeJob, probeContext, commitProbe } from './managed-agent-probe';
import { meetingAgentToolRequestSchema, meetingAgentCommitRequestSchema,
  type MeetingAgentContext, type MeetingAgentReceipt, type MeetingAgentStatus } from '@starlings/contracts/meeting-agent';
import { signedMeetingAgentBody } from './meeting-agent-auth';
import { roomStub } from './do-jurisdiction';
import { ControlError } from './errors';
import { requestDelivery } from './deliveries';
import { markNotesDone } from './notes-owed';
import { recordMeetingRecord } from './ledger';
import { knownRoomSlugs } from './internal-rooms';
import { MEETING_AGENT_WORKSPACE_KEY } from './meeting-agent-auth';

function bodyJSON(raw: string): unknown {
  try { return JSON.parse(raw); }
  catch { throw new ControlError('Request body must be valid JSON.', 400, 'invalid_request'); }
}

export async function handleMeetingAgentContext(request: Request, env: Env): Promise<MeetingAgentContext> {
  const caller = await signedMeetingAgentBody(request, env);
  const body = meetingAgentToolRequestSchema.parse(bodyJSON(caller.raw_body));
  const probe = await installationProbe(env, body, caller.agent_sub);
  if (probe) return probeContext(probeJob(body.workspace_id, caller.agent_sub, probe));
  return (await roomStub(env, body.room_slug)).meetingAgentContext(body, caller.agent_sub);
}

export async function handleMeetingAgentCommit(request: Request, env: Env): Promise<MeetingAgentReceipt> {
  const caller = await signedMeetingAgentBody(request, env);
  const body = meetingAgentCommitRequestSchema.parse(bodyJSON(caller.raw_body));
  const probe = await installationProbe(env, body, caller.agent_sub);
  if (probe) return commitProbe(env, probe, probeJob(body.workspace_id, caller.agent_sub, probe), body.result);
  const room = await roomStub(env, body.room_slug);
  const receipt = await room.commitMeetingAgentResult(body, caller.agent_sub, body.result);
  await settleMeetingAgentCommit(env, body.room_slug, body.run_id);
  return receipt;
}

export async function handleMeetingAgentStatus(request: Request, env: Env): Promise<MeetingAgentStatus> {
  const caller = await signedMeetingAgentBody(request, env);
  const body = meetingAgentToolRequestSchema.parse(bodyJSON(caller.raw_body));
  const probe = await installationProbe(env, body, caller.agent_sub);
  if (probe) return { run_id: body.run_id, state: probe.probe_receipt ? 'committed' : 'prepared', receipt: probe.probe_receipt ? JSON.parse(probe.probe_receipt) : null };
  const status = await (await roomStub(env, body.room_slug)).meetingAgentRunStatus(body, caller.agent_sub);
  if (status.receipt) await settleMeetingAgentCommit(env, body.room_slug, body.run_id);
  return status;
}

/** A lost response leaves a durable pending marker. Retry/status uses the same delivery ledger. */
export async function settleMeetingAgentCommit(env: Env, slug: string, runId: string): Promise<void> {
  const room = await roomStub(env, slug);
  const pending = (await room.pendingMeetingAgentDeliveries()).find((entry) => entry.run_id === runId);
  if (!pending) return;
  const record = await room.meetingLedgerRecord(pending.meeting_id);
  if (record) await recordMeetingRecord(env, record);
  // Delivery stores the owed revision before queueing. A retry never adds another artifact store.
  await requestDelivery(env, slug, pending.meeting_id);
  await markNotesDone(env, slug, pending.meeting_id);
  await room.markMeetingAgentDelivered(runId);
}

/** Recover a callback interrupted before it reached the existing delivery ledger. */
export async function sweepMeetingAgentCommits(env: Env): Promise<number> {
  const installed = await env.USAGE.prepare('SELECT value FROM workspace_settings WHERE key = ?1')
    .bind(MEETING_AGENT_WORKSPACE_KEY).first<{ value: string }>();
  if (!installed) return 0;
  let settled = 0;
  for (const slug of await knownRoomSlugs(env)) {
    const room = await roomStub(env, slug);
    for (const pending of await room.pendingMeetingAgentDeliveries()) {
      await settleMeetingAgentCommit(env, slug, pending.run_id);
      if (++settled >= 20) return settled;
    }
  }
  return settled;
}
