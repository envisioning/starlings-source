// Device tokens — how the native Meet client gets in.
//
// Modelled on Docs' Meet exchange: the Meet Worker has already proven the
// owner with Google, signs a request over the shared secret, and Keep mints
// a per-device bearer token. The token is a second way to say "this is
// mz@" — it carries no key and opens no vault. Every reveal it makes is
// audited under the owner's email like a cookie session's.
//
// An agent token (scope `agent`, ADR 0007) is the same token with a smaller
// reach: its owner is the agent's Meet roster address, and it reaches only
// `/api/agent/*`. Meet's signature is the proof that the address is on its
// roster. The broker holds it; the agent's sandbox never does.

import {
  DEVICE_TOKEN_DAYS,
  DEVICE_TOKEN_PREFIX,
  meetExchangeSchema,
  type DeviceTokenScope,
  type DeviceTokenSummary,
  type MeetExchangeResponse,
  type StaffSession,
} from '@keep/contracts';
import { constantTimeEqual, hmacSHA256Hex, randomToken, sha256Hex, uuid } from './crypto';
import { AuthError, ConflictError, KeepError, NotFoundError } from './errors';
import { assertAdmittedEmail, isAdmittedEmail } from './identity';

const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

export async function assertInternalSignature(request: Request, env: Env, body: string): Promise<void> {
  const secret = env.KEEP_INTERNAL_SECRET?.trim();
  if (!secret) throw new KeepError('KEEP_INTERNAL_SECRET is not configured.', 503, 'not_configured');
  const timestamp = request.headers.get('x-internal-timestamp');
  const signature = request.headers.get('x-internal-signature');
  if (!timestamp || !signature) throw new AuthError('Missing internal signature.', 401, 'unauthorized');
  const age = Math.abs(Date.now() - Number(timestamp));
  if (!Number.isFinite(age) || age > SIGNATURE_WINDOW_MS) {
    throw new AuthError('Internal signature is stale.', 401, 'unauthorized');
  }
  const expected = await hmacSHA256Hex(secret, `${timestamp}.${body}`);
  if (!(await constantTimeEqual(expected, signature))) {
    throw new AuthError('Internal signature does not match.', 401, 'unauthorized');
  }
}

/**
 * Who is asking. A person (cookie or a `person` token), or an agent (an
 * `agent` token). The router sends an agent to its own routes only.
 */
export type Principal = { kind: 'person'; session: StaffSession } | { kind: 'agent'; agent: AgentPrincipal };

export interface AgentPrincipal {
  /** The Meet roster address. */
  address: string;
  name: string;
}

/**
 * Replaces whatever token that device held, so a phone that re-links holds
 * exactly one. A person and an agent never share an address: an agent
 * address is refused for a person token, and an enrolled person's address
 * for an agent token.
 */
export async function exchangeMeetToken(env: Env, input: unknown): Promise<MeetExchangeResponse> {
  const parsed = meetExchangeSchema.parse(input);
  const statements: D1PreparedStatement[] = [];
  if (parsed.scope === 'person') {
    assertAdmittedEmail(env, parsed.email, 'email');
    const agent = await env.DB.prepare(`SELECT 1 AS present FROM agents WHERE address = ?`).bind(parsed.email).first();
    if (agent) throw new ConflictError('That address is an agent’s.');
  } else {
    const person = await env.DB.prepare(`SELECT 1 AS present FROM staff_keys WHERE email = ?`).bind(parsed.email).first();
    if (person) throw new ConflictError('That address is an enrolled person’s.');
    statements.push(
      env.DB.prepare(
        `INSERT INTO agents (address, name) VALUES (?, ?)
         ON CONFLICT(address) DO UPDATE SET name = excluded.name, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      ).bind(parsed.email, parsed.name),
    );
  }
  const secret = `${DEVICE_TOKEN_PREFIX}${randomToken(32)}`;
  const expiresAt = new Date(Date.now() + DEVICE_TOKEN_DAYS * 86_400_000).toISOString();
  await env.DB.batch([
    ...statements,
    env.DB.prepare(`UPDATE device_tokens SET revoked_at = ? WHERE owner = ? AND device_name = ? AND scope = ? AND revoked_at IS NULL`).bind(
      new Date().toISOString(),
      parsed.email,
      parsed.device_name,
      parsed.scope,
    ),
    env.DB.prepare(`INSERT INTO device_tokens (id, token_hash, owner, name, device_name, expires_at, scope) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(
      uuid(),
      await sha256Hex(secret),
      parsed.email,
      parsed.name,
      parsed.device_name,
      expiresAt,
      parsed.scope,
    ),
  ]);
  return { token: secret, expires_at: expiresAt, email: parsed.email, scope: parsed.scope };
}

export async function principalFromDeviceToken(env: Env, token: string): Promise<Principal | null> {
  if (!token.startsWith(DEVICE_TOKEN_PREFIX)) return null;
  const row = await env.DB.prepare(`SELECT id, owner, name, scope, expires_at, revoked_at FROM device_tokens WHERE token_hash = ?`)
    .bind(await sha256Hex(token))
    .first<{ id: string; owner: string; name: string; scope: DeviceTokenScope; expires_at: string; revoked_at: string | null }>();
  if (!row || row.revoked_at) return null;
  if (Date.parse(row.expires_at) < Date.now()) return null;
  if (row.scope === 'agent') {
    // The agent row is the roster entry Meet vouched for. No row, no agent.
    const agent = await env.DB.prepare(`SELECT address, name FROM agents WHERE address = ?`).bind(row.owner).first<AgentPrincipal>();
    if (!agent) return null;
    touch(env, row.id);
    return { kind: 'agent', agent };
  }
  if (row.scope !== 'person') return null;
  if (!isAdmittedEmail(env, row.owner)) return null;
  touch(env, row.id);
  return { kind: 'person', session: { sub: `device-${row.id}`, email: row.owner, name: row.name } };
}

/** Fire-and-forget: a failed last_used_at write must never fail the request. */
function touch(env: Env, id: string): void {
  void env.DB.prepare(`UPDATE device_tokens SET last_used_at = ? WHERE id = ?`).bind(new Date().toISOString(), id).run().catch(() => {});
}

/** A person's own device tokens. Never an agent's, even at the same address. */
export async function listDeviceTokens(env: Env, owner: string): Promise<DeviceTokenSummary[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, name, device_name, scope, created_at, last_used_at, expires_at, revoked_at
       FROM device_tokens WHERE owner = ? AND scope = 'person' ORDER BY created_at DESC`,
  )
    .bind(owner)
    .all<DeviceTokenSummary>();
  return results;
}

/** Every live token of one agent, revoked in the caller's batch. */
export function revokeAgentTokensStatement(env: Env, address: string): D1PreparedStatement {
  return env.DB.prepare(`UPDATE device_tokens SET revoked_at = ? WHERE owner = ? AND scope = 'agent' AND revoked_at IS NULL`).bind(
    new Date().toISOString(),
    address,
  );
}

export async function revokeDeviceToken(env: Env, id: string, owner: string): Promise<void> {
  const result = await env.DB.prepare(`UPDATE device_tokens SET revoked_at = ? WHERE id = ? AND owner = ? AND scope = 'person' AND revoked_at IS NULL`)
    .bind(new Date().toISOString(), id, owner)
    .run();
  if (!result.meta.changes) throw new NotFoundError('No such device, or it is already revoked.');
}
