// The agent roster, in D1 (migration 0101).
//
// An agent joins a workspace by enrolling (agent-enrollment.ts) and an admin
// approving it; nothing about it is a deploy. Each row carries the agent's
// own two keys, sealed at rest: `webhook_secret` signs what Starlings sends
// it, `inbound_key` verifies what it sends Starlings.
//
// Transitional: a workspace that still sets `AGENT_ROSTER` has those agents
// imported as `source = 'config'` rows, updated whenever the var changes, and their
// keys read from env secrets, one per agent: `WEBHOOK_KEY_<ADDRESS>` and
// `INBOUND_KEY_<ADDRESS>`. A config agent with no `WEBHOOK_KEY_<ADDRESS>`
// is still signed with the old fleet secret `AGENT_WEBHOOK_SECRET`
// until every agent has its own key. Once every workspace's config rows are in
// D1 the var, its secrets and this import are deleted (docs/AGENTS_SURFACE.md
// §Enrollment).

import { agentRoster, agentSub, agentWriteSchema, type AgentDefinition, type AgentWrite } from './contracts';
import { makeAgentAvatarIdentity } from '@starlings/contracts/agent-avatar-values';
import { openSecret, sealSecret, sha256Hex, type SealedSecret } from './crypto';

export type RosterAgent = AgentDefinition & { source: 'config' | 'enrolled' };

interface AgentRow {
  email: string;
  sub: string;
  name: string;
  endpoint: string | null;
  reset_endpoint: string | null;
  writes_json: string;
  webhook_secret_iv: string | null;
  webhook_secret_sealed: string | null;
  inbound_key_iv: string | null;
  inbound_key_sealed: string | null;
  source: string;
}

/**
 * How long one isolate trusts its copy. A roster read is on the path of every
 * team list and every inbound call, so it is cached; an approval or a removal
 * reaches every isolate inside this window, and the isolate that made it at
 * once.
 */
const CACHE_MILLISECONDS = 10_000;
const cache = new WeakMap<object, { at: number; list: RosterAgent[] }>();
const imported = new WeakMap<object, string>();

export function forgetRoster(env: Env): void {
  cache.delete(env);
}

/** Every agent on the roster now: removed ones excluded. */
export async function loadAgents(env: Env): Promise<RosterAgent[]> {
  const cached = cache.get(env);
  if (cached && Date.now() - cached.at < CACHE_MILLISECONDS && imported.get(env) === configFingerprint(env)) return cached.list;
  try {
    await importConfigRoster(env);
    const { results } = await env.USAGE.prepare(
      `SELECT email, sub, name, endpoint, reset_endpoint, writes_json,
              webhook_secret_iv, webhook_secret_sealed, inbound_key_iv, inbound_key_sealed, source
       FROM agents WHERE removed_at IS NULL ORDER BY created_at, email`,
    ).all<AgentRow>();
    const list = results.map(toAgent);
    cache.set(env, { at: Date.now(), list });
    return list;
  } catch (error) {
    // A broken read must not take the team roster down with it.
    console.error(JSON.stringify({
      level: 'error',
      message: 'agents.roster.read_failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
    return cached?.list ?? [];
  }
}

export async function agentByEmail(env: Env, email: string): Promise<RosterAgent | null> {
  const wanted = email.trim().toLowerCase();
  return (await loadAgents(env)).find((agent) => agent.email === wanted) ?? null;
}

/** A per-agent key shorter than this is treated as not set. */
const MIN_AGENT_KEY_LENGTH = 32;

/**
 * The Worker secret that holds one caller's own key: `INBOUND_KEY` + `core`
 * → `INBOUND_KEY_CORE`; `WEBHOOK_KEY` + `vocab@example.com` →
 * `WEBHOOK_KEY_VOCAB_ENVISIONING_COM`.
 */
export function callerSecretName(prefix: 'INBOUND_KEY' | 'WEBHOOK_KEY', id: string): string {
  return `${prefix}_${id.toUpperCase().replace(/[^A-Z0-9]+/gu, '_')}`;
}

function envSecret(env: Env, name: string): string | null {
  return (env as unknown as Record<string, string | undefined>)[name]?.trim() || null;
}

/**
 * The secret Starlings signs hand-offs and resets to this agent with; null
 * when it has none (the caller sends nothing outside development).
 *
 * A config agent uses its own `WEBHOOK_KEY_<ADDRESS>`. Without one
 * it falls back to the old fleet secret `AGENT_WEBHOOK_SECRET`, and each such
 * hand-off is logged with the agent's name, so the log says which agents
 * still wait for their own key. Delete the fallback once none does.
 */
export async function agentWebhookSecret(env: Env, agent: RosterAgent): Promise<string | null> {
  if (agent.source !== 'config') return openRowSecret(env, agent.email, 'webhook_secret');
  const name = callerSecretName('WEBHOOK_KEY', agent.email);
  const own = envSecret(env, name);
  if (own && own.length >= MIN_AGENT_KEY_LENGTH) return own;
  if (own) {
    // A short key is a mistake at `wrangler secret put`, not a key: say so, never use it.
    console.error(JSON.stringify({ level: 'error', message: 'agents.webhook_key.too_short', secret: name }));
  }
  const shared = env.AGENT_WEBHOOK_SECRET?.trim() || null;
  if (shared) {
    console.warn(JSON.stringify({ level: 'warn', message: 'agents.webhook.shared_secret', agent: agent.email.split('@')[0] }));
  }
  return shared;
}

/** The key this agent signs inbound requests with; null when it has none. */
export async function agentInboundKey(env: Env, agent: RosterAgent): Promise<string | null> {
  if (agent.source === 'config') return envSecret(env, callerSecretName('INBOUND_KEY', agent.email));
  return openRowSecret(env, agent.email, 'inbound_key');
}

async function openRowSecret(env: Env, email: string, column: 'webhook_secret' | 'inbound_key'): Promise<string | null> {
  const row = await env.USAGE.prepare(
    `SELECT ${column}_iv AS iv, ${column}_sealed AS ciphertext FROM agents WHERE email = ?1 AND removed_at IS NULL`,
  ).bind(email).first<{ iv: string | null; ciphertext: string | null }>();
  if (!row?.iv || !row.ciphertext) return null;
  const key = env.GOOGLE_TOKEN_ENCRYPTION_KEY;
  if (!key) return null;
  return openSecret(key, { iv: row.iv, ciphertext: row.ciphertext });
}

export async function sealAgentSecret(env: Env, plaintext: string): Promise<SealedSecret> {
  const key = env.GOOGLE_TOKEN_ENCRYPTION_KEY;
  if (!key) throw new Error('GOOGLE_TOKEN_ENCRYPTION_KEY is not set.');
  return sealSecret(key, plaintext);
}

/** Insert one enrolled agent. The caller has already chosen a free address. */
export async function insertEnrolledAgent(
  env: Env,
  input: { email: string; name: string; endpoint: string; resetEndpoint: string | null; webhookSecret: SealedSecret; inboundKey: SealedSecret; approvedBy: string; now: number },
): Promise<D1PreparedStatement> {
  return env.USAGE.prepare(
    `INSERT INTO agents (email, sub, name, endpoint, reset_endpoint, writes_json,
       webhook_secret_iv, webhook_secret_sealed, inbound_key_iv, inbound_key_sealed,
       source, created_at, approved_by_email)
     VALUES (?1, ?2, ?3, ?4, ?5, '[]', ?6, ?7, ?8, ?9, 'enrolled', ?10, ?11)`,
  ).bind(
    input.email, agentSub(input.email), input.name, input.endpoint, input.resetEndpoint,
    input.webhookSecret.iv, input.webhookSecret.ciphertext, input.inboundKey.iv, input.inboundKey.ciphertext,
    input.now, input.approvedBy,
  );
}

/** Whether any row, removed or not, already holds this address. Addresses are never reused. */
export async function agentAddressTaken(env: Env, email: string): Promise<boolean> {
  const row = await env.USAGE.prepare('SELECT 1 AS taken FROM agents WHERE email = ?1').bind(email).first<{ taken: number }>();
  return Boolean(row);
}

/** Take an enrolled agent off the roster. Its conversations and history stay. */
export async function removeAgent(env: Env, email: string, by: string, now: number): Promise<boolean> {
  const results = await env.USAGE.batch([
    env.USAGE.prepare(`UPDATE agents SET removed_at = ?2, removed_by_email = ?3,
      webhook_secret_iv = NULL, webhook_secret_sealed = NULL, inbound_key_iv = NULL, inbound_key_sealed = NULL
      WHERE email = ?1 AND removed_at IS NULL AND source = 'enrolled'`).bind(email, now, by),
    env.USAGE.prepare(`UPDATE managed_agent_provisioning SET stage = 'removed', erase_requested_at = COALESCE(erase_requested_at, ?2), updated_at = ?2
      WHERE installation_id IN (SELECT i.id FROM built_in_agent_installations i JOIN agents a ON a.sub = i.agent_sub
      WHERE a.email = ?1 AND a.source = 'enrolled' AND a.removed_at IS NOT NULL)`).bind(email, now),
    env.USAGE.prepare(`UPDATE built_in_agent_installations SET state = 'removed', removed_at = COALESCE(removed_at, ?2)
      WHERE agent_sub IN (SELECT sub FROM agents WHERE email = ?1 AND source = 'enrolled' AND removed_at IS NOT NULL)`).bind(email, now),
  ]);
  forgetRoster(env);
  return (results[0]!.meta.changes ?? 0) === 1;
}

function toAgent(row: AgentRow): RosterAgent {
  let writes: AgentWrite[] = [];
  try {
    const parsed: unknown = JSON.parse(row.writes_json);
    if (Array.isArray(parsed)) writes = parsed.flatMap((item) => {
      const result = agentWriteSchema.safeParse(item);
      return result.success ? [result.data] : [];
    });
  } catch {
    writes = [];
  }
  return {
    email: row.email,
    sub: row.sub,
    name: row.name,
    avatar: makeAgentAvatarIdentity(row.email),
    ...(row.endpoint ? { endpoint: row.endpoint } : {}),
    ...(row.reset_endpoint ? { resetEndpoint: row.reset_endpoint } : {}),
    ...(writes.length > 0 ? { writes } : {}),
    source: row.source === 'config' ? 'config' : 'enrolled',
  };
}

function configFingerprint(env: Env): string {
  return `${String(env.ENVIRONMENT)}|${env.AGENT_ROSTER ?? ''}`;
}

/**
 * Keep the `config` rows equal to `AGENT_ROSTER`: upsert what it names, retire
 * what it no longer names. Enrolled rows are never touched. Runs when the var
 * differs from what this isolate last imported, so normally once.
 */
async function importConfigRoster(env: Env): Promise<void> {
  const fingerprint = configFingerprint(env);
  if (imported.get(env) === fingerprint) return;
  let defined: AgentDefinition[] = [];
  try {
    defined = agentRoster(env.AGENT_ROSTER, { allowInsecureEndpoints: String(env.ENVIRONMENT) === 'development' });
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      message: 'agents.roster.invalid',
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
  }
  const now = Date.now();
  const statements = defined.map((agent) => env.USAGE.prepare(
    `INSERT INTO agents (email, sub, name, endpoint, reset_endpoint, writes_json, source, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'config', ?7)
     ON CONFLICT(email) DO UPDATE SET name = ?3, endpoint = ?4, reset_endpoint = ?5, writes_json = ?6, removed_at = NULL
       WHERE agents.source = 'config'`,
  ).bind(agent.email, agent.sub, agent.name, agent.endpoint ?? null, agent.resetEndpoint ?? null, JSON.stringify(agent.writes ?? []), now));
  const named = defined.map((agent) => agent.email);
  statements.push(env.USAGE.prepare(
    named.length > 0
      ? `UPDATE agents SET removed_at = ?1 WHERE source = 'config' AND removed_at IS NULL AND email NOT IN (${named.map((_, index) => `?${index + 2}`).join(', ')})`
      : `UPDATE agents SET removed_at = ?1 WHERE source = 'config' AND removed_at IS NULL`,
  ).bind(now, ...named));
  await env.USAGE.batch(statements);
  imported.set(env, fingerprint);
  cache.delete(env);
}

/** The stored form of a poll token: its SHA-256, hex. */
export function pollTokenHash(token: string): Promise<string> {
  return sha256Hex(token);
}
