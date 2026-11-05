import { meetingAgentAcknowledgementSchema, meetingAgentRuntimeProbeResponseSchema, MEETING_AGENT_MAX_DURATION_MS } from '@starlings/contracts/meeting-agent';
import { MANAGED_AGENT_REPIN_STEPS, managedAgentProvisionRequestSchema, managedAgentReadinessSchema,
  type ManagedAgentReadiness, type ManagedAgentBootstrapResponse, type ManagedAgentProvisionRequest } from '@starlings/contracts/managed-agent';
import { BUILT_IN_MEETING_AGENT_NAME, BUILT_IN_MEETING_AGENT_ROLE } from '@starlings/contracts/built-in-agent';
import { agentAddressDomain } from '@starlings/contracts/agent-enrollment';
import { agentSub, parseAgentManifest, type OwnerSession } from './contracts';
import { randomToken, openSecret, hmacSHA256Hex, constantTimeEqualSync } from './crypto';
import { sealAgentSecret, insertEnrolledAgent, agentAddressTaken, forgetRoster } from './agent-roster';
import { meetingAgentInstallation, MEETING_AGENT_WORKSPACE_KEY, meetingAgentWorkspaceId } from './meeting-agent-auth';
import { assertUnderRateLimit, readBoundedText } from './http';
import { ControlError, AuthError } from './errors';
import { isRootAdminEmail } from './workspace-identity';
import { probeJob, type ProbeRow } from './managed-agent-probe';

interface ProvisionRow extends ProbeRow {
  accountable_email: string; accountable_sub: string | null; stage: ManagedAgentReadiness['stage'];
  project_id: string | null; runtime_origin: string | null; runtime_version: string | null;
  verified_at: number | null; failed_step: string | null;
}
const endpoint = '/api/internal/managed-agent/provision';
async function rowFor(env: Env): Promise<ProvisionRow | null> {
  return env.USAGE.prepare(`SELECT p.* FROM managed_agent_provisioning p JOIN built_in_agent_installations i ON i.id = p.installation_id
    WHERE i.workspace_id = (SELECT value FROM workspace_settings WHERE key = ?1) AND i.role = ?2 ORDER BY i.created_at LIMIT 1`)
    .bind(MEETING_AGENT_WORKSPACE_KEY, BUILT_IN_MEETING_AGENT_ROLE).first<ProvisionRow>();
}
async function readiness(env: Env, row: ProvisionRow): Promise<ManagedAgentReadiness> {
  const installation = await meetingAgentInstallation(env, row.installation_id);
  return managedAgentReadinessSchema.parse({ installation, stage: installation.state === 'removed' ? 'removed' : row.stage,
    accountable_sub: row.accountable_sub, runtime_project_id: row.project_id, runtime_version: row.runtime_version,
    verified_at: row.verified_at, failed_step: row.failed_step,
    retryable: installation.state === 'provisioning' && row.stage === 'failed' });
}
export async function readManagedAgentReadiness(env: Env): Promise<ManagedAgentReadiness | null> {
  const row = await rowFor(env); return row ? readiness(env, row) : null;
}
async function activateHuman(env: Env, row: ProvisionRow): Promise<void> {
  if (!row.verified_at) return;
  const human = await env.USAGE.prepare(`SELECT sub, email, kind, role, revoked_at FROM people WHERE email = ?1`)
    .bind(row.accountable_email).first<{ sub: string; email: string; kind: string; role: string; revoked_at: number | null }>();
  if (!human || human.kind !== 'human' || human.revoked_at !== null || (human.role !== 'admin' && !isRootAdminEmail(env, human.email))) return;
  // Fresh authority, no seeded person or platform operator becomes the actor.
  await env.USAGE.batch([
    env.USAGE.prepare(`UPDATE managed_agent_provisioning SET accountable_sub = ?2, stage = 'ready', failed_step = NULL, updated_at = ?3
      WHERE installation_id = ?1 AND verified_at IS NOT NULL AND stage = 'awaiting_admin'
      AND EXISTS (SELECT 1 FROM built_in_agent_installations i JOIN agents a ON a.sub = i.agent_sub JOIN people p ON p.sub = a.sub
        WHERE i.id = ?1 AND i.state = 'provisioning' AND i.removed_at IS NULL AND a.removed_at IS NULL AND p.revoked_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM agent_freezes f WHERE f.agent_sub = i.agent_sub))`).bind(row.installation_id, human.sub, Date.now()),
    env.USAGE.prepare(`UPDATE built_in_agent_installations SET state = 'ready' WHERE id = ?1 AND state = 'provisioning'
      AND removed_at IS NULL AND EXISTS (SELECT 1 FROM managed_agent_provisioning p WHERE p.installation_id = ?1 AND p.stage = 'ready')
      AND NOT EXISTS (SELECT 1 FROM agent_freezes f WHERE f.agent_sub = built_in_agent_installations.agent_sub)`).bind(row.installation_id),
  ]);
}
export async function activateManagedAgentAfterSignIn(env: Env, owner: OwnerSession): Promise<void> {
  const row = await rowFor(env);
  if (!row || row.accountable_email !== owner.email || row.stage !== 'awaiting_admin') return;
  const agent = await meetingAgentInstallation(env, row.installation_id);
  if (agent.state !== 'provisioning') return;
  await activateHuman(env, row);
}
async function begin(env: Env, email: string | undefined): Promise<ProvisionRow> {
  if (!email) throw new ControlError('The first admin is required.', 400, 'invalid_request');
  email = email.toLowerCase();
  let existing = await rowFor(env);
  if (existing) {
    if (existing.accountable_email !== email) throw new ControlError('The installation belongs to a different admin.', 409, 'invalid_request');
    return existing; // Includes removed installations: never silently resurrect one.
  }
  const human = await env.USAGE.prepare('SELECT kind, role, revoked_at FROM people WHERE email = ?1')
    .bind(email).first<{ kind: string; role: string; revoked_at: number | null }>();
  if ((!human && !isRootAdminEmail(env, email)) || (human && (human.kind !== 'human' || human.revoked_at !== null
    || (human.role !== 'admin' && !isRootAdminEmail(env, email))))) throw new AuthError('The accountable person must be the workspace admin.', 403, 'capability_denied');
  if (!env.GOOGLE_TOKEN_ENCRYPTION_KEY) throw new ControlError('Cannot seal installation keys.', 503, 'not_configured');
  await env.USAGE.prepare(`INSERT INTO workspace_settings (key, value, updated_at, updated_by) VALUES (?1, ?2, ?3, 'managed-installer')
    ON CONFLICT(key) DO NOTHING`).bind(MEETING_AGENT_WORKSPACE_KEY, crypto.randomUUID(), Date.now()).run();
  const workspaceId = await meetingAgentWorkspaceId(env);
  // Do not adopt a pre-existing foundation row or an unrelated enrolled agent.
  const occupied = await env.USAGE.prepare('SELECT id FROM built_in_agent_installations WHERE workspace_id = ?1 AND role = ?2')
    .bind(workspaceId, BUILT_IN_MEETING_AGENT_ROLE).first();
  if (occupied) throw new ControlError('An existing managed installation needs reconciliation.', 409, 'invalid_request');
  let address = '';
  for (let n = 1; n <= 50; n++) {
    const candidate = `${n === 1 ? 'steward' : `steward-${n}`}@${agentAddressDomain(env.WEB_ORIGIN)}`;
    if (!(await agentAddressTaken(env, candidate))) { address = candidate; break; }
  }
  if (!address) throw new ControlError('No free managed address.', 409, 'invalid_request');
  const id = crypto.randomUUID(), now = Date.now();
  const [webhook, inbound] = await Promise.all([sealAgentSecret(env, randomToken()), sealAgentSecret(env, randomToken())]);
  const inserted = await insertEnrolledAgent(env, { email: address, name: BUILT_IN_MEETING_AGENT_NAME,
    endpoint: '', resetEndpoint: null, webhookSecret: webhook, inboundKey: inbound, approvedBy: email, now });
  try {
    await env.USAGE.batch([
      inserted,
      env.USAGE.prepare(`INSERT INTO people (sub, email, name, kind, first_seen_at, last_seen_at) VALUES (?1, ?2, ?3, 'agent', ?4, ?4)`)
        .bind(agentSub(address), address, BUILT_IN_MEETING_AGENT_NAME, now),
      env.USAGE.prepare(`INSERT INTO built_in_agent_installations (id, workspace_id, agent_sub, role, state, created_at)
        VALUES (?1, ?2, ?3, ?4, 'provisioning', ?5)`).bind(id, workspaceId, agentSub(address), BUILT_IN_MEETING_AGENT_ROLE, now),
      env.USAGE.prepare(`INSERT INTO managed_agent_provisioning (installation_id, accountable_email, stage, updated_at)
        VALUES (?1, ?2, 'reserved', ?3)`).bind(id, email, now),
    ]);
  } catch (error) {
    existing = await rowFor(env);
    if (!existing || existing.accountable_email !== email) throw error;
    return existing;
  }
  forgetRoster(env);
  return (await rowFor(env))!;
}
function runtimeOrigin(raw: string | undefined): string {
  if (!raw) throw new ControlError('Runtime origin required.', 400, 'invalid_request');
  const url = new URL(raw);
  // Managed projects only. Arbitrary hosts, redirects and deployment URLs supplied by a model are not a provisioning path.
  if (url.protocol !== 'https:' || !/^starlings-meeting-[a-f0-9]{32}\.vercel\.app$/.test(url.hostname)
    || url.pathname !== '/' || url.username || url.password || url.search || url.hash) {
    throw new ControlError('Invalid managed runtime origin.', 400, 'invalid_request');
  }
  return url.origin;
}
// Workers supports manual redirects; error mode throws before making the request.
// Non-2xx responses are refused below, so signatures never follow an alias redirect.
async function signedRuntime(env: Env, row: ProvisionRow, path: string, body: unknown): Promise<unknown> {
  const keys = await installationKeys(env, row);
  const raw = JSON.stringify(body), stamp = String(Date.now());
  const response = await fetch(row.runtime_origin! + path, { method: 'POST', redirect: 'manual', body: raw,
    headers: { 'content-type': 'application/json', 'x-internal-timestamp': stamp,
      'x-internal-signature': await hmacSHA256Hex(keys.webhook_key!, `${stamp}.meeting-agent.POST.${path}.${raw}`) },
    signal: AbortSignal.timeout(10_000) });
  if (!response.ok) { await response.body?.cancel(); throw new ControlError('Runtime check unavailable.', 503, 'not_configured'); }
  return JSON.parse(await readBoundedText(response, 16_000));
}
async function installationKeys(env: Env, row: ProvisionRow): Promise<Pick<ManagedAgentBootstrapResponse, 'webhook_key' | 'inbound_key'>> {
  const state = await readiness(env, row);
  if (state.installation.state === 'removed' || state.installation.state === 'frozen') return { webhook_key: null, inbound_key: null };
  const keys = await env.USAGE.prepare(`SELECT webhook_secret_iv, webhook_secret_sealed, inbound_key_iv, inbound_key_sealed FROM agents WHERE sub = ?1 AND removed_at IS NULL`)
    .bind(state.installation.agent_sub).first<{ webhook_secret_iv: string; webhook_secret_sealed: string; inbound_key_iv: string; inbound_key_sealed: string }>();
  if (!keys) throw new ControlError('Installation keys unavailable.', 503, 'not_configured');
  return { webhook_key: await openSecret(env.GOOGLE_TOKEN_ENCRYPTION_KEY, { iv: keys.webhook_secret_iv, ciphertext: keys.webhook_secret_sealed }),
    inbound_key: await openSecret(env.GOOGLE_TOKEN_ENCRYPTION_KEY, { iv: keys.inbound_key_iv, ciphertext: keys.inbound_key_sealed }) };
}
async function verifyRuntime(env: Env, row: ProvisionRow): Promise<void> {
  if (!row.runtime_origin || !row.runtime_version || !row.project_id) throw new ControlError('Runtime is not configured.', 409, 'invalid_request');
  const res = await fetch(row.runtime_origin + '/manifest', { redirect: 'manual', signal: AbortSignal.timeout(5_000) });
  if (!res.ok) { await res.body?.cancel(); throw new ControlError('Runtime manifest unavailable.', 503, 'not_configured'); }
  const manifest = parseAgentManifest(JSON.parse(await readBoundedText(res, 64_000)));
  if (!manifest || manifest.version !== row.runtime_version || manifest.skills?.length !== 1 || manifest.tools?.length !== 1 || manifest.skills[0]?.name !== 'meeting-follow-through' || manifest.tools[0]?.name !== 'meeting-process') {
    throw new ControlError('Runtime version or skill differs.', 409, 'invalid_request');
  }
  if (!row.probe_run_id || !row.probe_deadline || row.probe_deadline <= Date.now()) {
    const now = Date.now();
    await env.USAGE.prepare(`UPDATE managed_agent_provisioning SET probe_run_id = ?2, probe_deadline = ?3,
      probe_runtime_run_id = NULL, probe_receipt = NULL, stage = 'verifying', updated_at = ?4 WHERE installation_id = ?1 AND stage != 'removed'`)
      .bind(row.installation_id, crypto.randomUUID(), now + MEETING_AGENT_MAX_DURATION_MS, now).run();
    row = (await rowFor(env))!;
  }
  const state = await readiness(env, row), job = probeJob(state.installation.workspace_id, state.installation.agent_sub, row);
  if (!row.probe_runtime_run_id) {
    const accepted = meetingAgentAcknowledgementSchema.parse(await signedRuntime(env, row, '/meet/meeting/handoff', job));
    if (accepted.run_id !== job.run_id) throw new ControlError('Runtime acknowledgement differs.', 503, 'not_configured');
    if (accepted.outcome === 'committed' && !accepted.runtime_run_id) {
      // A lost acknowledgement cannot prove which hosted run was erased. Use a new synthetic diagnostic.
      await env.USAGE.prepare('UPDATE managed_agent_provisioning SET probe_run_id = NULL, probe_receipt = NULL WHERE installation_id = ?1').bind(row.installation_id).run();
      return;
    }
    if (typeof accepted.runtime_run_id !== 'string' || !/^wrun_[A-Za-z0-9]{26}$/.test(accepted.runtime_run_id)) {
      throw new ControlError('No durable runtime acknowledgement.', 503, 'not_configured');
    }
    await env.USAGE.prepare('UPDATE managed_agent_provisioning SET probe_runtime_run_id = ?2 WHERE installation_id = ?1')
      .bind(row.installation_id, accepted.runtime_run_id).run();
    return; // The operator polls; no model call runs on this request's lifetime.
  }
  if (!row.probe_receipt) return;
  const proof = meetingAgentRuntimeProbeResponseSchema.parse(await signedRuntime(env, row, '/meet/meeting/verify', { job, runtime_run_id: row.probe_runtime_run_id }));
  if (proof.erased !== true || proof.runtime_run_id !== row.probe_runtime_run_id) throw new ControlError('Runtime erasure unverified.', 503, 'not_configured');
  await env.USAGE.prepare(`UPDATE managed_agent_provisioning SET verified_at = ?2, failed_step = NULL, stage = 'awaiting_admin', updated_at = ?2 WHERE installation_id = ?1 AND stage != 'removed'`)
    .bind(row.installation_id, Date.now()).run();
  await activateHuman(env, (await rowFor(env))!);
}
export async function handleManagedAgentProvision(request: Request, env: Env): Promise<ManagedAgentBootstrapResponse> {
  const key = env.MANAGED_AGENT_PROVISIONING_KEY;
  if (!key || key.length < 32) throw new ControlError('Not found.', 404, 'room_not_found');
  if (request.headers.has('authorization') || request.headers.has('x-meet-agent')) throw new AuthError('Bootstrap signature required.', 403, 'owner_auth_required');
  await assertUnderRateLimit(env.AGENT_LIMIT, request, 'managed-agent-provision');
  const stamp = request.headers.get('x-internal-timestamp') ?? '', sig = request.headers.get('x-internal-signature') ?? '';
  if (!/^\d+$/.test(stamp) || Math.abs(Date.now() - Number(stamp)) > 300_000) throw new AuthError('Bootstrap signature expired.', 403, 'owner_auth_required');
  const raw = await readBoundedText(request, 8_000);
  if (!constantTimeEqualSync(await hmacSHA256Hex(key, `${stamp}.managed-agent.POST.${endpoint}.${raw}`), sig.toLowerCase())) throw new AuthError('Bootstrap refused.', 403, 'owner_auth_required');
  let decoded: unknown;
  try { decoded = JSON.parse(raw); } catch { throw new ControlError('Request body must be valid JSON.', 400, 'invalid_request'); }
  const input = managedAgentProvisionRequestSchema.parse(decoded);
  let row = input.action === 'begin' ? await begin(env, input.accountable_email) : await rowFor(env);
  if (!row || (input.installation_id && input.installation_id !== row.installation_id)) throw new ControlError('No such installation.', 404, 'room_not_found');
  const before = await readiness(env, row);
  if (input.action !== 'status' && input.action !== 'begin' && ((input.action === 'offboard' || input.action === 'erased') || (before.installation.state !== 'removed' && before.installation.state !== 'frozen' && before.installation.state !== 'paused'))) {
    try { await applyAction(env, row, input); }
    catch (error) {
      if (input.action === 'verify') await env.USAGE.prepare("UPDATE managed_agent_provisioning SET stage = 'failed', failed_step = 'runtime_verify', updated_at = ?2 WHERE installation_id = ?1 AND verified_at IS NULL").bind(row.installation_id, Date.now()).run();
      throw error;
    }
    row = (await rowFor(env))!;
  }
  const after = await readiness(env, row);
  // No key-bearing response to status. The trusted installer can resume with begin.
  const keys = input.action === 'begin' ? await installationKeys(env, row) : { webhook_key: null, inbound_key: null };
  return { readiness: after, ...keys };
}
async function applyAction(env: Env, row: ProvisionRow, input: ManagedAgentProvisionRequest): Promise<void> {
  if (input.action === 'bind') {
    const origin = runtimeOrigin(input.runtime_origin);
    const expected = `https://starlings-meeting-${row.installation_id.replaceAll('-', '')}.vercel.app`;
    // A deploy that failed before verification may pin a new commit; nothing else may.
    const repinnable = row.verified_at === null && row.stage === 'failed' && MANAGED_AGENT_REPIN_STEPS.includes(row.failed_step ?? '');
    if (input.repin && !repinnable) throw new ControlError('Only a failed, unverified runtime deploy may re-pin.', 409, 'invalid_request');
    if (origin !== expected || !input.project_id || !input.runtime_version || (row.project_id && row.project_id !== input.project_id)
      || (row.runtime_origin && row.runtime_origin !== origin) || (row.runtime_version && row.runtime_version !== input.runtime_version && !input.repin)) {
      throw new ControlError('Reinstall or upgrade must be explicit.', 409, 'invalid_request');
    }
    await env.USAGE.batch([
      env.USAGE.prepare(`UPDATE managed_agent_provisioning SET project_id = ?2, runtime_origin = ?3, runtime_version = ?4,
        stage = CASE WHEN verified_at IS NULL THEN 'runtime' ELSE stage END, failed_step = NULL, updated_at = ?5 WHERE installation_id = ?1`)
        .bind(row.installation_id, input.project_id, origin, input.runtime_version, Date.now()),
      // General message handoffs remain refused by the template (#1088).
      env.USAGE.prepare(`UPDATE agents SET endpoint = ?2 WHERE sub = (SELECT agent_sub FROM built_in_agent_installations WHERE id = ?1) AND removed_at IS NULL`)
        .bind(row.installation_id, origin + '/meet/handoff'),
    ]);
    forgetRoster(env);
  } else if (input.action === 'verify' && !row.verified_at) {
    await verifyRuntime(env, row);
  } else if (input.action === 'failed') {
    if (!input.failed_step) throw new ControlError('Failed step required.', 400, 'invalid_request');
    await env.USAGE.prepare(`UPDATE managed_agent_provisioning SET stage = 'failed', failed_step = ?2, updated_at = ?3 WHERE installation_id = ?1 AND verified_at IS NULL`)
      .bind(row.installation_id, input.failed_step, Date.now()).run();
  } else if (input.action === 'erased') {
    if ((input.project_id ?? null) !== row.project_id || row.stage !== 'removed') throw new ControlError('Erasure does not match a removed installation.', 409, 'invalid_request');
    await env.USAGE.prepare('UPDATE managed_agent_provisioning SET erased_at = COALESCE(erased_at, ?2), failed_step = NULL, updated_at = ?2 WHERE installation_id = ?1 AND erase_requested_at IS NOT NULL').bind(row.installation_id, Date.now()).run();
  } else if (input.action === 'offboard') {
    if (input.project_id && row.project_id && input.project_id !== row.project_id) throw new ControlError('Runtime resource differs.', 409, 'invalid_request');
    await env.USAGE.batch([
      env.USAGE.prepare(`UPDATE managed_agent_provisioning SET stage = 'removed', project_id = COALESCE(project_id, ?3), erase_requested_at = COALESCE(erase_requested_at, ?2), updated_at = ?2 WHERE installation_id = ?1`).bind(row.installation_id, Date.now(), input.project_id ?? null),
      env.USAGE.prepare(`UPDATE built_in_agent_installations SET state = 'removed', removed_at = COALESCE(removed_at, ?2) WHERE id = ?1`).bind(row.installation_id, Date.now()),
      env.USAGE.prepare(`UPDATE agents SET removed_at = COALESCE(removed_at, ?2), webhook_secret_iv = NULL, webhook_secret_sealed = NULL, inbound_key_iv = NULL, inbound_key_sealed = NULL
        WHERE sub = (SELECT agent_sub FROM built_in_agent_installations WHERE id = ?1)`).bind(row.installation_id, Date.now()),
    ]);
    forgetRoster(env);
  }
}
