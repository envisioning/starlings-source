// Personal access tokens — how a CLI, an MCP server, or any agent gets in.
//
// Modelled on Core's PATs so the mental model transfers: a token belongs to a
// person, carries explicit scopes, and every write it makes is attributed to
// that person with the agent's name alongside. The extra dimension here is
// `path_prefix`, which confines a token to one subtree — the difference
// between "an agent that files research notes" and "an agent that can rewrite
// the company".

import { AGENT_SCOPES, meetExchangeSchema, pathSchema, type AgentScope, type MeetExchangeResponse, type TokenSummary } from '@docs/contracts';
import { z } from 'zod';
import { randomToken, sha256Hex, uuid } from './crypto';
import { AuthError, NotFoundError } from './errors';
import { isIdentityEmail } from './identity';
import { TOKEN_PREFIX } from './auth';

export const tokenCreateSchema = z.object({
  name: z.string().min(1).max(200),
  scopes: z.array(z.enum(AGENT_SCOPES)).min(1),
  agent_name: z.string().max(200).optional(),
  path_prefix: pathSchema.optional(),
  expires_in_days: z.number().int().min(1).max(3650).optional(),
});

export type { TokenSummary };

export async function createToken(
  env: Env,
  input: unknown,
  owner: string,
): Promise<TokenSummary & { token: string }> {
  const parsed = tokenCreateSchema.parse(input);
  const secret = `${TOKEN_PREFIX}${randomToken(32)}`;
  const id = uuid();
  const prefix = secret.slice(0, TOKEN_PREFIX.length + 6);
  const expiresAt = parsed.expires_in_days
    ? new Date(Date.now() + parsed.expires_in_days * 86_400_000).toISOString()
    : null;

  await env.DB.prepare(
    `INSERT INTO api_tokens (id, name, prefix, token_hash, owner, scopes, path_prefix, agent_name, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      parsed.name,
      prefix,
      await sha256Hex(secret),
      owner,
      JSON.stringify(parsed.scopes),
      parsed.path_prefix ?? null,
      parsed.agent_name ?? null,
      expiresAt,
    )
    .run();

  const row = await get(env, id);
  // Shown exactly once. Nothing stores the secret, so a lost token is
  // re-issued, never recovered.
  return { ...row, token: secret };
}

/** What a Meet device may do. Write, share, send for signature; never `sync:write`. */
const MEET_SCOPES: AgentScope[] = ['docs:read', 'docs:write', 'annotations:read', 'annotations:write', 'grants:write', 'sign:manage'];
const MEET_TOKEN_DAYS = 90;
/** How old the device's previous token must be before a mint revokes it. */
const MEET_TOKEN_REPLACE_AFTER_MS = 86_400_000;

/**
 * Mint a token for one owner's Meet device. The Meet Worker has already
 * proven the owner; this re-checks the domain and replaces whatever token
 * that device held before, so a phone that re-links holds exactly one.
 * Attribution: `agent_name = meet:<device>`, owner = the person.
 *
 * **A token minted in the last day is not revoked.** Meet's Worker is not one
 * device: a queue draining hundreds of jobs runs across isolates that all mint
 * as `Meet web` for the same owner, and a revoke-on-every-mint rule had them
 * revoking each other's live tokens mid-flight. Meet retries a 401 once, so
 * the losers of that race silently dropped their write — it cost the date on
 * a third of an imported meeting history (2026-09-22). Re-linking a real
 * device still replaces yesterday's token; a burst coexists.
 */
export async function exchangeMeetToken(env: Env, input: unknown): Promise<MeetExchangeResponse> {
  const parsed = meetExchangeSchema.parse(input);
  const email = parsed.email.trim().toLowerCase();
  if (!isIdentityEmail(env, email)) {
    throw new AuthError('Docs tokens are for this deployment\'s identity domains.', 403, 'forbidden');
  }
  const agentName = `meet:${parsed.device_name.trim()}`;

  const now = new Date();
  await env.DB.prepare(
    `UPDATE api_tokens SET revoked_at = ?
      WHERE owner = ? AND agent_name = ? AND revoked_at IS NULL AND created_at <= ?`,
  )
    .bind(
      now.toISOString(),
      email,
      agentName,
      new Date(now.getTime() - MEET_TOKEN_REPLACE_AFTER_MS).toISOString(),
    )
    .run();

  const created = await createToken(
    env,
    { name: `Meet on ${parsed.device_name.trim()}`, scopes: MEET_SCOPES, agent_name: agentName, expires_in_days: MEET_TOKEN_DAYS },
    email,
  );
  return { token: created.token, scopes: created.scopes, expires_at: created.expires_at!, email };
}

export async function listTokens(env: Env, owner: string): Promise<TokenSummary[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM api_tokens WHERE owner = ? ORDER BY created_at DESC`,
  )
    .bind(owner)
    .all<Record<string, unknown>>();
  return results.map(toSummary);
}

export async function revokeToken(env: Env, id: string, owner: string): Promise<void> {
  const result = await env.DB.prepare(
    `UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND owner = ? AND revoked_at IS NULL`,
  )
    .bind(new Date().toISOString(), id, owner)
    .run();
  if (!result.meta.changes) throw new NotFoundError('No such token, or it is already revoked.');
}

async function get(env: Env, id: string): Promise<TokenSummary> {
  const row = await env.DB.prepare(`SELECT * FROM api_tokens WHERE id = ?`).bind(id).first<Record<string, unknown>>();
  if (!row) throw new NotFoundError('No such token.');
  return toSummary(row);
}

function toSummary(row: Record<string, unknown>): TokenSummary {
  let scopes: AgentScope[] = [];
  try {
    const parsed: unknown = JSON.parse(String(row.scopes ?? '[]'));
    if (Array.isArray(parsed)) scopes = parsed as AgentScope[];
  } catch {
    scopes = [];
  }
  return {
    id: String(row.id),
    name: String(row.name),
    prefix: String(row.prefix),
    owner: String(row.owner),
    scopes,
    agent_name: (row.agent_name as string | null) ?? null,
    path_prefix: (row.path_prefix as string | null) ?? null,
    created_at: String(row.created_at),
    last_used_at: (row.last_used_at as string | null) ?? null,
    expires_at: (row.expires_at as string | null) ?? null,
    revoked_at: (row.revoked_at as string | null) ?? null,
  };
}
