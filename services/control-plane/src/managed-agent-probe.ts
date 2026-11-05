// A fixed synthetic installation diagnostic. It never reads a Room DO,
// creates a human grant, files work, or enters the meeting delivery ledger.
import { meetingAgentContextSchema, meetingAgentReceiptSchema, validateMeetingAgentResult,
  type MeetingAgentContext, type MeetingAgentHandoff, type MeetingAgentToolRequest, type MeetingAgentResult, type MeetingAgentReceipt } from '@starlings/contracts/meeting-agent';
import { meetingAgentInstallation } from './meeting-agent-auth';
import { ControlError } from './errors';

export const MANAGED_SKILL_VERSION = 'meeting-follow-through-v1';
export const PROBE_SOURCE_REVISION = 'installation-fixture-v1';
export interface ProbeRow {
  installation_id: string; probe_run_id: string | null; probe_deadline: number | null;
  probe_receipt: string | null; probe_runtime_run_id: string | null;
}
export function probeJob(workspaceId: string, agentSub: string, row: ProbeRow): MeetingAgentHandoff {
  if (!row.probe_run_id || !row.probe_deadline) throw new ControlError('No installation check.', 409, 'invalid_request');
  return { kind: 'meeting_follow_through', workspace_id: workspaceId, installation_id: row.installation_id,
    agent_sub: agentSub, room_slug: 'installation-check', meeting_id: row.probe_run_id, run_id: row.probe_run_id,
    source_revision: PROBE_SOURCE_REVISION, skill_version: MANAGED_SKILL_VERSION, deadline_at: row.probe_deadline };
}
export async function installationProbe(env: Env, request: MeetingAgentToolRequest, agentSub: string): Promise<ProbeRow | null> {
  const row = await env.USAGE.prepare(`SELECT * FROM managed_agent_provisioning WHERE probe_run_id = ?1`)
    .bind(request.run_id).first<ProbeRow>();
  if (!row) return null;
  const agent = await meetingAgentInstallation(env, row.installation_id);
  if (agent.agent_sub !== agentSub || agent.workspace_id !== request.workspace_id || request.meeting_id !== row.probe_run_id
    || request.room_slug !== 'installation-check' || agent.state === 'removed' || agent.state === 'frozen'
    || !row.probe_deadline || row.probe_deadline <= Date.now()) {
    throw new ControlError('Installation check refused.', 403, 'capability_denied');
  }
  return row;
}
export function probeContext(job: MeetingAgentHandoff): MeetingAgentContext {
  return meetingAgentContextSchema.parse({
    workspace_id: job.workspace_id, installation_id: job.installation_id, agent_sub: job.agent_sub,
    room_slug: job.room_slug, meeting_id: job.meeting_id, source_revision: job.source_revision, run_id: job.run_id,
    content_kind: 'untrusted_meeting_source', actor_sub: 'installation-diagnostic', grant_id: job.run_id,
    invocation_id: job.run_id, correlation_id: job.run_id, expected_result_revision: 0,
    started_at: job.deadline_at - 600_000, ended_at: job.deadline_at - 600_000,
    title: 'Synthetic installation check', participants: [],
    segments: [{ id: 'installation-segment', speaker: 'fixture', speaker_name: 'Fixture', starts_at_ms: 0, ends_at_ms: 1000,
      text: 'This is a synthetic installation check. No actions or decisions were agreed.' }],
    subject: null, agenda: null, previous_proposals: [], skill_version: MANAGED_SKILL_VERSION,
  });
}
export async function commitProbe(env: Env, row: ProbeRow, job: MeetingAgentHandoff, result: MeetingAgentResult): Promise<MeetingAgentReceipt> {
  try { validateMeetingAgentResult(probeContext(job), result); }
  catch { throw new ControlError('Invalid installation result.', 400, 'invalid_request'); }
  if ( result.action_items.length || result.decision_candidates.length || result.follow_up !== null) {
    throw new ControlError('Invalid installation result.', 400, 'invalid_request');
  }
  const receipt = meetingAgentReceiptSchema.parse({ workspace_id: job.workspace_id, room_slug: job.room_slug,
    meeting_id: job.meeting_id, run_id: job.run_id, source_revision: job.source_revision,
    result_revision: 1, committed_at: Date.now(), outcome: 'committed' });
  await env.USAGE.prepare(`UPDATE managed_agent_provisioning SET probe_receipt = ?2
    WHERE installation_id = ?1 AND probe_receipt IS NULL AND probe_run_id = ?3 AND stage != 'removed'`)
    .bind(row.installation_id, JSON.stringify(receipt), row.probe_run_id).run();
  const saved = await env.USAGE.prepare('SELECT probe_receipt FROM managed_agent_provisioning WHERE installation_id = ?1')
    .bind(row.installation_id).first<{ probe_receipt: string | null }>();
  if (!saved?.probe_receipt) throw new ControlError('Installation check was cancelled.', 409, 'invalid_request');
  return meetingAgentReceiptSchema.parse(JSON.parse(saved.probe_receipt));
}
