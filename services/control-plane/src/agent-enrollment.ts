// Agent enrollment: how any agent runtime joins a workspace's Team without a
// deploy (docs/AGENTS_SURFACE.md §Enrollment; the wire is
// @starlings/contracts/agent-enrollment).
//
// The shape is a device-code grant. The runtime asks (`enrollAgent`), a
// workspace admin approves the short code in Admin › Agents
// (`approveEnrollment`), and the runtime collects its address and both keys
// exactly once (`pollEnrollment`). The runtime never picks its address: the
// admin's approval is what puts an agent in front of the whole team, and the
// address Starlings derives is unique for good, removed agents included.

import {
  AGENT_ENROLLMENT_CODE_ALPHABET,
  AGENT_ENROLLMENT_POLL_SECONDS,
  AGENT_ENROLLMENT_TTL_MILLISECONDS,
  agentAddressDomain,
  agentEnrollPollRequestSchema,
  agentEnrollRequestSchema,
  agentLocalPart,
  type AdminAgentEnrollment,
  type AdminAgentEnrollmentApprove,
  type AgentEnrollPollResponse,
  type AgentEnrollResponse,
  type AdminAgentRemoveResponse,
} from '@starlings/contracts/agent-enrollment';
import { validateAgentUrl, type OwnerSession } from './contracts';
import { recordAdminAction } from './admin-audit';
import { agentAddressTaken, forgetRoster, insertEnrolledAgent, pollTokenHash, removeAgent, sealAgentSecret } from './agent-roster';
import { openSecret, randomToken } from './crypto';
import { ControlError } from './errors';
import { assertUnderRateLimit, readBoundedJSON } from './http';

/** At most this many requests wait for an admin at once, so the public door cannot fill the table. */
const MAX_PENDING = 20;

interface EnrollmentRow {
  id: string;
  user_code: string;
  requested_name: string;
  description: string | null;
  runtime: string | null;
  endpoint: string;
  reset_endpoint: string | null;
  status: string;
  created_at: number;
  expires_at: number;
  agent_email: string | null;
  webhook_secret_iv: string | null;
  webhook_secret_sealed: string | null;
  inbound_key_iv: string | null;
  inbound_key_sealed: string | null;
  collected_at: number | null;
}

function allowInsecure(env: Env): boolean {
  return String(env.ENVIRONMENT) === 'development';
}

function userCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (byte) => AGENT_ENROLLMENT_CODE_ALPHABET[byte % AGENT_ENROLLMENT_CODE_ALPHABET.length]).join('');
}

/** `POST /api/agents/enroll` — public. A request, nothing more, until an admin approves it. */
export async function enrollAgent(request: Request, env: Env): Promise<AgentEnrollResponse> {
  await assertUnderRateLimit(env.AGENT_LIMIT, request, 'agent-enroll');
  const parsed = agentEnrollRequestSchema.safeParse(await readBoundedJSON(request));
  if (!parsed.success) throw new ControlError(parsed.error.issues.map((issue) => issue.message).join('; '), 400, 'invalid_request');
  const body = parsed.data;
  const endpoint = validateAgentUrl(body.endpoint, allowInsecure(env));
  if (!endpoint) throw new ControlError('The endpoint must be an absolute https URL.', 400, 'invalid_request');
  const resetEndpoint = body.reset_endpoint ? validateAgentUrl(body.reset_endpoint, allowInsecure(env)) : undefined;
  if (body.reset_endpoint && !resetEndpoint) throw new ControlError('The reset endpoint must be an absolute https URL.', 400, 'invalid_request');
  if (!env.GOOGLE_TOKEN_ENCRYPTION_KEY) throw new ControlError('This workspace cannot store agent keys yet.', 503, 'not_configured');

  const now = Date.now();
  const pending = await env.USAGE.prepare(
    "SELECT COUNT(*) AS count FROM agent_enrollments WHERE status = 'pending' AND expires_at > ?1",
  ).bind(now).first<{ count: number }>();
  if ((pending?.count ?? 0) >= MAX_PENDING) {
    throw new ControlError('Too many agents are waiting for approval. Ask an admin to decide those first.', 429, 'rate_limited');
  }

  const id = crypto.randomUUID();
  const pollToken = randomToken(32);
  const code = userCode();
  const expiresAt = now + AGENT_ENROLLMENT_TTL_MILLISECONDS;
  await env.USAGE.prepare(
    `INSERT INTO agent_enrollments (id, user_code, poll_token_hash, requested_name, description, runtime,
       endpoint, reset_endpoint, status, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', ?9, ?10)`,
  ).bind(id, code, await pollTokenHash(pollToken), body.name, body.description ?? null, body.runtime ?? null,
    endpoint, resetEndpoint ?? null, now, expiresAt).run();

  return {
    enrollment_id: id,
    user_code: code,
    approve_url: `${env.WEB_ORIGIN}/admin/agents?code=${code}`,
    poll_token: pollToken,
    poll_interval_seconds: AGENT_ENROLLMENT_POLL_SECONDS,
    expires_at: expiresAt,
  };
}

/** `POST /api/agents/enroll/poll` — public, holds the poll token. The keys go out once. */
export async function pollEnrollment(request: Request, env: Env): Promise<AgentEnrollPollResponse> {
  await assertUnderRateLimit(env.AGENT_LIMIT, request, 'agent-enroll-poll');
  const parsed = agentEnrollPollRequestSchema.safeParse(await readBoundedJSON(request));
  if (!parsed.success) throw new ControlError('A poll_token is required.', 400, 'invalid_request');
  const row = await env.USAGE.prepare('SELECT * FROM agent_enrollments WHERE poll_token_hash = ?1')
    .bind(await pollTokenHash(parsed.data.poll_token)).first<EnrollmentRow>();
  if (!row) throw new ControlError('No enrollment has that poll token.', 404, 'request_not_found');
  const now = Date.now();

  if (row.status === 'denied') return { status: 'denied' };
  if (row.status === 'pending') {
    return row.expires_at <= now ? { status: 'expired' } : { status: 'pending', expires_at: row.expires_at };
  }
  if (row.collected_at || !row.agent_email || !row.webhook_secret_iv || !row.webhook_secret_sealed || !row.inbound_key_iv || !row.inbound_key_sealed) {
    return { status: 'collected' };
  }
  // An approval the runtime never came back for does not stay collectable for ever.
  if (row.expires_at <= now) return { status: 'expired' };
  // Claim the delivery before reading the keys out, so two polls racing hand them out once.
  const claimed = await env.USAGE.prepare(
    `UPDATE agent_enrollments SET collected_at = ?2,
       webhook_secret_iv = NULL, webhook_secret_sealed = NULL, inbound_key_iv = NULL, inbound_key_sealed = NULL
     WHERE id = ?1 AND collected_at IS NULL`,
  ).bind(row.id, now).run();
  if ((claimed.meta.changes ?? 0) !== 1) return { status: 'collected' };
  const key = env.GOOGLE_TOKEN_ENCRYPTION_KEY;
  const agent = await env.USAGE.prepare('SELECT name FROM agents WHERE email = ?1').bind(row.agent_email).first<{ name: string }>();
  return {
    status: 'approved',
    agent_email: row.agent_email,
    name: agent?.name ?? row.requested_name,
    workspace_origin: env.PUBLIC_API_ORIGIN || env.WEB_ORIGIN,
    webhook_secret: await openSecret(key, { iv: row.webhook_secret_iv, ciphertext: row.webhook_secret_sealed }),
    inbound_key: await openSecret(key, { iv: row.inbound_key_iv, ciphertext: row.inbound_key_sealed }),
  };
}

function toAdmin(row: EnrollmentRow, now: number): AdminAgentEnrollment {
  const status = row.status === 'pending' && row.expires_at <= now ? 'expired' : row.status;
  return {
    id: row.id,
    user_code: row.user_code,
    requested_name: row.requested_name,
    description: row.description,
    runtime: row.runtime,
    endpoint: row.endpoint,
    status: status === 'approved' || status === 'denied' || status === 'expired' ? status : 'pending',
    created_at: row.created_at,
    expires_at: row.expires_at,
    agent_email: row.agent_email,
  };
}

/** Admin › Agents: what waits, and what was decided in the last week. */
export async function listEnrollments(env: Env): Promise<AdminAgentEnrollment[]> {
  const now = Date.now();
  const { results } = await env.USAGE.prepare(
    `SELECT * FROM agent_enrollments
     WHERE (status = 'pending' AND expires_at > ?1) OR created_at > ?2
     ORDER BY created_at DESC LIMIT 50`,
  ).bind(now, now - 7 * 24 * 60 * 60_000).all<EnrollmentRow>();
  return results.map((row) => toAdmin(row, now));
}

async function pendingByCode(env: Env, rawCode: string): Promise<EnrollmentRow> {
  const code = rawCode.toUpperCase().replace(/[^A-Z0-9]/gu, '');
  const row = await env.USAGE.prepare(
    "SELECT * FROM agent_enrollments WHERE user_code = ?1 AND status = 'pending' AND expires_at > ?2 ORDER BY created_at DESC LIMIT 1",
  ).bind(code, Date.now()).first<EnrollmentRow>();
  if (!row) throw new ControlError('No agent is waiting with that code. It may have expired; ask the agent to enroll again.', 404, 'request_not_found');
  return row;
}

/** The first free address for this name: `hermes@agents.<host>`, then `hermes-2@…`. */
async function freeAddress(env: Env, name: string): Promise<string> {
  const domain = agentAddressDomain(env.WEB_ORIGIN);
  const base = agentLocalPart(name);
  for (let suffix = 1; suffix <= 50; suffix += 1) {
    const email = `${suffix === 1 ? base : `${base}-${suffix}`}@${domain}`;
    if (!(await agentAddressTaken(env, email))) return email;
  }
  throw new ControlError('No free address for that name. Choose another name.', 409, 'invalid_request');
}

/** `POST /api/admin/agent-enrollments/:code/approve` — the agent joins Team. */
export async function approveEnrollment(
  env: Env,
  owner: OwnerSession,
  rawCode: string,
  input: AdminAgentEnrollmentApprove,
): Promise<AdminAgentEnrollment> {
  const row = await pendingByCode(env, rawCode);
  const name = input.name ?? row.requested_name;
  const email = await freeAddress(env, name);
  const now = Date.now();
  const webhookSecret = randomToken(32);
  const inboundKey = randomToken(32);
  const [sealedWebhook, sealedInbound, sealedWebhookCopy, sealedInboundCopy] = await Promise.all([
    sealAgentSecret(env, webhookSecret),
    sealAgentSecret(env, inboundKey),
    sealAgentSecret(env, webhookSecret),
    sealAgentSecret(env, inboundKey),
  ]);
  const decided = env.USAGE.prepare(
    `UPDATE agent_enrollments SET status = 'approved', decided_at = ?2, decided_by_email = ?3, agent_email = ?4,
       webhook_secret_iv = ?5, webhook_secret_sealed = ?6, inbound_key_iv = ?7, inbound_key_sealed = ?8,
       expires_at = ?9
     WHERE id = ?1 AND status = 'pending'`,
  ).bind(row.id, now, owner.email, email, sealedWebhookCopy.iv, sealedWebhookCopy.ciphertext,
    sealedInboundCopy.iv, sealedInboundCopy.ciphertext, now + AGENT_ENROLLMENT_TTL_MILLISECONDS);
  const inserted = await insertEnrolledAgent(env, {
    email,
    name,
    endpoint: row.endpoint,
    resetEndpoint: row.reset_endpoint,
    webhookSecret: sealedWebhook,
    inboundKey: sealedInbound,
    approvedBy: owner.email,
    now,
  });
  await env.USAGE.batch([decided, inserted]);
  forgetRoster(env);
  await recordAdminAction(env, owner, 'agent.approve', email, null);
  const after = await env.USAGE.prepare('SELECT * FROM agent_enrollments WHERE id = ?1').bind(row.id).first<EnrollmentRow>();
  return toAdmin(after ?? row, now);
}

/** `POST /api/admin/agent-enrollments/:code/deny`. */
export async function denyEnrollment(env: Env, owner: OwnerSession, rawCode: string): Promise<AdminAgentEnrollment> {
  const row = await pendingByCode(env, rawCode);
  const now = Date.now();
  await env.USAGE.prepare(
    "UPDATE agent_enrollments SET status = 'denied', decided_at = ?2, decided_by_email = ?3 WHERE id = ?1 AND status = 'pending'",
  ).bind(row.id, now, owner.email).run();
  await recordAdminAction(env, owner, 'agent.deny', row.requested_name, null);
  return toAdmin({ ...row, status: 'denied' }, now);
}

/** `POST /api/admin/agents/:id/remove` — an enrolled agent leaves Team; its keys stop working at once. */
export async function removeEnrolledAgent(env: Env, owner: OwnerSession, rawId: string): Promise<AdminAgentRemoveResponse> {
  let email: string;
  try {
    email = decodeURIComponent(rawId).trim().toLowerCase();
  } catch {
    throw new ControlError('That is not an agent address.', 400, 'invalid_request');
  }
  if (!(await removeAgent(env, email, owner.email, Date.now()))) {
    throw new ControlError('No enrolled agent on the roster has that address.', 404, 'person_not_found');
  }
  await recordAdminAction(env, owner, 'agent.remove', email, null);
  return { agent_email: email, removed: true };
}

/** Daily: forget requests nobody decided and deliveries nobody collected. */
export async function pruneEnrollments(env: Env, now: number): Promise<number> {
  const result = await env.USAGE.prepare(
    `DELETE FROM agent_enrollments WHERE expires_at < ?1`,
  ).bind(now - 7 * 24 * 60 * 60_000).run();
  return result.meta.changes ?? 0;
}
