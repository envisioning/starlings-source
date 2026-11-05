// The existing artifact queue is the scheduler. This module sends only a scoped
// job; text is read separately through the installation's signed context door.
import { BUILT_IN_MEETING_AGENT_ROLE } from '@starlings/contracts/built-in-agent';
import { meetingAgentAcknowledgementSchema } from '@starlings/contracts/meeting-agent';
import { MEETING_AGENT_WORKSPACE_KEY, meetingAgentInstallation } from './meeting-agent-auth';
import { roomStub } from './do-jurisdiction';
import { ControlError } from './errors';
import { hmacSHA256Hex, openSecret } from './crypto';
import { readBoundedText } from './http';
import { settleMeetingAgentCommit } from './meeting-agent-tools';

const SKILL_VERSION = 'meeting-follow-through-v1';
const HANDOFF_PATH = '/meet/meeting/handoff';
const pending = () => new ControlError('Meeting assistance is pending; retry the same assignment.', 503, 'not_configured');

/** True owns this meeting's engine. False leaves an uninstalled workspace on the legacy path until #1090. */
export async function dispatchMeetingAgent(env: Env, slug: string, meetingId: string): Promise<boolean> {
  const room = await roomStub(env, slug);
  let run = await room.automaticMeetingAgentRun(meetingId);
  const target = await env.USAGE.prepare(`SELECT i.id, p.stage, p.verified_at, p.runtime_origin, p.runtime_version,
      a.webhook_secret_iv AS iv, a.webhook_secret_sealed AS ciphertext
    FROM built_in_agent_installations i LEFT JOIN managed_agent_provisioning p ON p.installation_id = i.id
    LEFT JOIN agents a ON a.sub = i.agent_sub
    WHERE i.workspace_id = (SELECT value FROM workspace_settings WHERE key = ?1) AND i.role = ?2
      AND (?3 IS NULL OR i.id = ?3) ORDER BY (i.removed_at IS NULL) DESC, i.created_at DESC LIMIT 1`)
    .bind(MEETING_AGENT_WORKSPACE_KEY, BUILT_IN_MEETING_AGENT_ROLE, run?.invocation.installation_id ?? null)
    .first<{ id: string; stage: string | null; verified_at: number | null; runtime_origin: string | null;
      runtime_version: string | null; iv: string | null; ciphertext: string | null }>();
  if (!target && !run) return false;
  // A local receipt is stronger than an HTTP acknowledgement and stays recoverable
  // after key removal or grant expiry. Settlement reads no runtime/private context.
  const committed = (await room.pendingMeetingAgentDeliveries()).find((entry) => entry.meeting_id === meetingId);
  if (committed) {
    await settleMeetingAgentCommit(env, slug, committed.run_id);
    return true;
  }
  if (!target) { await room.fallbackMeetingAgent(meetingId, 'unavailable'); return true; }
  const installation = await meetingAgentInstallation(env, target.id);
  const expectedOrigin = `https://starlings-meeting-${target.id.replaceAll('-', '')}.vercel.app`;
  if (installation.state !== 'ready' || target.stage !== 'ready' || !target.verified_at
    || target.runtime_origin !== expectedOrigin || !/^[a-f0-9]{7,40}$/.test(target.runtime_version ?? '')
    || !target.iv || !target.ciphertext || !env.GOOGLE_TOKEN_ENCRYPTION_KEY) {
    await room.fallbackMeetingAgent(meetingId, 'unavailable');
    return true;
  }
  const artifact = await room.artifactForProcessing(meetingId);
  if (!artifact.transcript.some((segment) => segment.is_final)) { await room.fallbackMeetingAgent(meetingId, 'no_text'); return true; }
  const secret = await openSecret(env.GOOGLE_TOKEN_ENCRYPTION_KEY, { iv: target.iv, ciphertext: target.ciphertext });
  if (secret.length < 32) { await room.fallbackMeetingAgent(meetingId, 'unavailable'); return true; }
  let claim;
  try {
    run ??= await room.prepareAutomaticMeetingAgentRun(meetingId, target.id, SKILL_VERSION);
    claim = await room.claimMeetingAgentDispatch(run.id);
  } catch (error) {
    // Policy/revision/coverage refusal has no model fallback under another name.
    // A transient database/RPC error remains a queue retry and cannot write notes.
    const status = error instanceof Error && 'status' in error ? error.status : null;
    if (status !== 403 && status !== 409 && status !== 413) throw error;
    await room.fallbackMeetingAgent(meetingId, run && run.grant.expires_at <= Date.now() ? 'expired' : 'refused');
    return true;
  }
  if (!claim) throw pending();
  try {
    // No transcript, human email or callback URL rides with this bounded payload.
    const raw = JSON.stringify(claim.job), stamp = String(Date.now());
    // Manual mode is supported at the edge; the non-2xx check refuses redirects.
    const response = await fetch(expectedOrigin + HANDOFF_PATH, {
      method: 'POST', redirect: 'manual', body: raw, signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/json', 'x-internal-timestamp': stamp,
        'x-internal-signature': await hmacSHA256Hex(secret, `${stamp}.meeting-agent.POST.${HANDOFF_PATH}.${raw}`) },
    });
    if (!response.ok) { await response.body?.cancel(); throw pending(); }
    const accepted = meetingAgentAcknowledgementSchema.parse(JSON.parse(await readBoundedText(response, 8_000)));
    if (accepted.run_id !== run.id) throw pending();
    await room.acceptMeetingAgentDispatch(run.id, claim.lease_id, accepted.runtime_run_id ?? null);
  } catch {
    await room.releaseMeetingAgentDispatch(run.id, claim.lease_id);
    // Provider errors/response bodies can contain private data. Keep only this fixed code.
    throw pending();
  }
  if ((await room.pendingMeetingAgentDeliveries()).some((entry) => entry.run_id === run.id)) {
    await settleMeetingAgentCommit(env, slug, run.id);
    return true;
  }
  // Even outcome=committed in an ACK is not a canonical receipt.
  if ((await room.artifactForProcessing(meetingId)).summary !== null) return true;
  throw pending();
}
