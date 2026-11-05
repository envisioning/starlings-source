// Attended releases (ADR 0007 decisions 5 and 10 to 12 in envisioning/meet).
//
// One item of a person's vault reaches one agent for one task, until an
// expiry. The rules, stated once:
//
// - A member of the vault approves on their own device. The device opens the
//   item, seals its body under a one-time key and wraps that key to the
//   public key the agent made for this request. This Worker stores the sealed
//   body and the wrap. It cannot open either: it holds no key.
// - A machine vault takes no release. `requireMembership` excludes machine
//   vaults, so every route here answers 404 for one. A release is for a
//   person's vault.
// - The named agent fetches the payload once, with its own `agent` token,
//   before the expiry. The fetch clears the payload and writes `item.use`.
//   A second fetch, a fetch after the expiry and a fetch after an end are
//   refused (410). Any other agent gets 404.
// - Any member of the vault may end a release early. The end clears the
//   payload and writes `release.end`. The approval writes `release.approve`.
// - No list carries the sealed body or the wrap.

import { createReleaseSchema, type ReleaseEntry, type ReleasePayload, type ReleaseStatus, type ReleaseSummary, type StaffSession } from '@keep/contracts';
import { auditStatement } from './audit';
import { uuid } from './crypto';
import { ConflictError, KeepError, NotFoundError } from './errors';
import type { AgentPrincipal } from './tokens';
import { requireMembership } from './vaults';

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

interface ReleaseRow {
  id: string;
  vault_id: string;
  item_id: string;
  item_name: string;
  agent: string;
  agent_name: string | null;
  approver: string;
  task: string;
  reason: string | null;
  created_at: string;
  expires_at: string;
  fetched_at: string | null;
  ended_at: string | null;
  ended_by: string | null;
}

/** Metadata only. The payload columns are never selected here. */
const RELEASE_SELECT = `
  SELECT r.id, r.vault_id, r.item_id, r.item_name, r.agent, a.name AS agent_name, r.approver, r.task, r.reason,
         r.created_at, r.expires_at, r.fetched_at, r.ended_at, r.ended_by
    FROM releases r LEFT JOIN agents a ON a.address = r.agent`;

function status(row: ReleaseRow): ReleaseStatus {
  if (row.ended_at) return 'ended';
  if (row.fetched_at) return 'used';
  if (Date.parse(row.expires_at) <= Date.now()) return 'expired';
  return 'live';
}

function toSummary(row: ReleaseRow): ReleaseSummary {
  return {
    id: row.id,
    vault_id: row.vault_id,
    item_id: row.item_id,
    item_name: row.item_name,
    agent: { address: row.agent, name: row.agent_name ?? row.agent },
    approver: row.approver,
    task: row.task,
    reason: row.reason,
    status: status(row),
    created_at: row.created_at,
    expires_at: row.expires_at,
    fetched_at: row.fetched_at,
    ended_at: row.ended_at,
    ended_by: row.ended_by,
  };
}

async function requireRelease(env: Env, vaultId: string, releaseId: string): Promise<ReleaseRow> {
  const row = await env.DB.prepare(`${RELEASE_SELECT} WHERE r.id = ? AND r.vault_id = ?`).bind(releaseId, vaultId).first<ReleaseRow>();
  if (!row) throw new NotFoundError('No such release.');
  return row;
}

// ---------------------------------------------------------------------------
// A person (a member of the vault)
// ---------------------------------------------------------------------------

/** The approval: one item, one agent, one task, one expiry, one audit row. */
export async function createRelease(env: Env, session: StaffSession, vaultId: string, body: unknown, request: Request): Promise<ReleaseSummary> {
  // Membership first: a vault you cannot open, or a machine vault, is 404 whatever the body says.
  await requireMembership(env, session, vaultId);
  const input = createReleaseSchema.parse(body);
  const item = await env.DB.prepare(`SELECT name FROM items WHERE id = ? AND vault_id = ?`).bind(input.item_id, vaultId).first<{ name: string }>();
  if (!item) throw new NotFoundError('No such item.');
  const agent = await env.DB.prepare(`SELECT address FROM agents WHERE address = ?`).bind(input.agent).first();
  if (!agent) throw new NotFoundError('No such agent. Meet brokers an agent’s token before Keep knows it.');
  const taken = await env.DB.prepare(`SELECT 1 AS present FROM releases WHERE id = ?`).bind(input.id).first();
  if (taken) throw new ConflictError('This request already has a release.');
  // `toISOString` writes the same text as `strftime('%Y-%m-%dT%H:%M:%fZ')`,
  // so the SQL comparisons below order it as time.
  const expiresAt = new Date(Date.now() + input.expires_in_seconds * 1000).toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO releases (id, vault_id, item_id, item_name, agent, approver, task, reason, session_public_key, iv, ciphertext, wrapped_key, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      input.id,
      vaultId,
      input.item_id,
      item.name,
      input.agent,
      session.email,
      input.task,
      input.reason ?? null,
      input.session_public_key,
      input.sealed.iv,
      input.sealed.ciphertext,
      JSON.stringify(input.wrapped_key),
      expiresAt,
    ),
    auditStatement(env, {
      vaultId,
      itemId: input.item_id,
      itemName: item.name,
      actor: session.email,
      kind: 'release.approve',
      request,
      detail: { release: input.id, agent: input.agent, approver: session.email, task: input.task, expires_at: expiresAt },
    }),
  ]);
  return toSummary(await requireRelease(env, vaultId, input.id));
}

export async function getRelease(env: Env, session: StaffSession, vaultId: string, releaseId: string): Promise<ReleaseSummary> {
  await requireMembership(env, session, vaultId);
  return toSummary(await requireRelease(env, vaultId, releaseId));
}

/**
 * End now. Any member of the vault may end a release. The payload goes in
 * the same write. Ending a release that is already closed changes nothing
 * and writes no row; the answer is its current state.
 */
export async function endRelease(env: Env, session: StaffSession, vaultId: string, releaseId: string, request: Request): Promise<ReleaseSummary> {
  await requireMembership(env, session, vaultId);
  await requireRelease(env, vaultId, releaseId);
  const open = `id = ? AND vault_id = ? AND ended_at IS NULL AND expires_at > ${NOW}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO audit_events (id, vault_id, item_id, item_name, actor, kind, ip, user_agent, detail)
       SELECT ?, vault_id, item_id, item_name, ?, 'release.end', ?, ?,
              json_object('release', id, 'agent', agent, 'approver', approver, 'task', task)
         FROM releases WHERE ${open}`,
    ).bind(
      uuid(),
      session.email,
      request.headers.get('cf-connecting-ip'),
      request.headers.get('user-agent')?.slice(0, 500) ?? null,
      releaseId,
      vaultId,
    ),
    env.DB.prepare(`UPDATE releases SET ended_at = ${NOW}, ended_by = ?, iv = NULL, ciphertext = NULL, wrapped_key = NULL WHERE ${open}`).bind(
      session.email,
      releaseId,
      vaultId,
    ),
  ]);
  return toSummary(await requireRelease(env, vaultId, releaseId));
}

/**'s hook: live releases (not ended, not expired) of a vault, or of one item. */
export async function liveReleases(env: Env, vaultId: string, itemId: string | null): Promise<ReleaseEntry[]> {
  const itemClause = itemId ? `AND r.item_id = ?` : '';
  const statement = env.DB.prepare(
    `${RELEASE_SELECT} WHERE r.vault_id = ? ${itemClause} AND r.ended_at IS NULL AND r.expires_at > ${NOW} ORDER BY r.expires_at`,
  );
  const { results } = await (itemId ? statement.bind(vaultId, itemId) : statement.bind(vaultId)).all<ReleaseRow>();
  return results.map((row) => ({
    id: row.id,
    agent: { address: row.agent, name: row.agent_name ?? row.agent },
    item_id: row.item_id,
    item_name: row.item_name,
    approver: row.approver,
    task: row.task,
    created_at: row.created_at,
    expires_at: row.expires_at,
    last_used_at: row.fetched_at,
  }));
}

// ---------------------------------------------------------------------------
// The agent (an `agent` token)
// ---------------------------------------------------------------------------

/** The state of one release, for the agent it names. Another agent gets 404. */
export async function agentRelease(env: Env, agent: AgentPrincipal, releaseId: string): Promise<ReleaseSummary> {
  const row = await env.DB.prepare(`${RELEASE_SELECT} WHERE r.id = ? AND r.agent = ?`).bind(releaseId, agent.address).first<ReleaseRow>();
  if (!row) throw new NotFoundError('No such release.');
  return toSummary(row);
}

/**
 * The one fetch. One batch, one transaction: read the payload, write the
 * audit row and close the release, each only while it is open. D1 runs
 * batches one at a time, so two fetches cannot both win: the second reads
 * the release after the first closed it and gets nothing.
 */
export async function fetchRelease(env: Env, agent: AgentPrincipal, releaseId: string, request: Request): Promise<ReleasePayload> {
  const open = `id = ? AND agent = ? AND fetched_at IS NULL AND ended_at IS NULL AND expires_at > ${NOW} AND ciphertext IS NOT NULL`;
  const [claimed] = await env.DB.batch<{ iv: string; ciphertext: string; wrapped_key: string; session_public_key: string }>([
    env.DB.prepare(`SELECT iv, ciphertext, wrapped_key, session_public_key FROM releases WHERE ${open}`).bind(releaseId, agent.address),
    env.DB.prepare(
      `INSERT INTO audit_events (id, vault_id, item_id, item_name, actor, kind, ip, user_agent, detail)
       SELECT ?, vault_id, item_id, item_name, agent, 'item.use', ?, ?,
              json_object('release', id, 'agent', agent, 'approver', approver, 'task', task)
         FROM releases WHERE ${open}`,
    ).bind(
      uuid(),
      request.headers.get('cf-connecting-ip'),
      request.headers.get('user-agent')?.slice(0, 500) ?? null,
      releaseId,
      agent.address,
    ),
    env.DB.prepare(`UPDATE releases SET fetched_at = ${NOW}, iv = NULL, ciphertext = NULL, wrapped_key = NULL WHERE ${open}`).bind(
      releaseId,
      agent.address,
    ),
  ]);
  const payload = claimed?.results[0];
  const row = await env.DB.prepare(`${RELEASE_SELECT} WHERE r.id = ? AND r.agent = ?`).bind(releaseId, agent.address).first<ReleaseRow>();
  if (!row) throw new NotFoundError('No such release.');
  if (!payload) {
    const why = { used: 'It was fetched already.', ended: 'It was ended.', expired: 'It expired.', live: 'It is closed.' }[status(row)];
    throw new KeepError(`This release is closed. ${why}`, 410, 'release_closed');
  }
  return {
    release: toSummary(row),
    session_public_key: payload.session_public_key,
    sealed: { iv: payload.iv, ciphertext: payload.ciphertext },
    wrapped_key: JSON.parse(payload.wrapped_key) as ReleasePayload['wrapped_key'],
  };
}
