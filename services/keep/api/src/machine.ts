// Agents and machine vaults (ADR 0007 in envisioning/meet).
//
// An agent is a member that is not a person, named by its Meet roster
// address. A machine vault holds that agent's own service keys. The rules,
// stated once:
//
// - A machine vault has exactly one member: its agent. Its vault key is
//   wrapped to the agent's public key and to nobody else. No person, no
//   recovery copy: a recovery join would make a person a member.
// - Every person of this deployment sees the machine vaults (names, item
//   names, who added what, the trail) and may add, rotate and delete items.
//   Nobody reads a value here. There is no reveal route for a machine vault;
//   the person routes in vaults.ts and items.ts answer 404 for one. Only the
//   broker will read, with the agent's private key, which it holds.
// - A person never holds the vault key, so a person seals each item under a
//   fresh item key and wraps that key to the agent's public key. The server
//   checks shape, not maths, as everywhere else.
// - Revoke ends the agent's standing access in one batch: its tokens are
//   revoked, its membership and its registered key are dropped, and the key
//   version goes up. Items sealed under the old version stay as names only
//   until a person enters a new value. The broker must refuse them.
//
// keep-api still holds no key: the agent's private key lives in the broker,
// never here (ADR 0007 decision 4).

import {
  createMachineItemSchema,
  createMachineVaultSchema,
  grantAgentSchema,
  registerAgentKeySchema,
  updateMachineItemSchema,
  type AgentSelf,
  type AgentSummary,
  type ItemSummary,
  type MachineVaultDetail,
  type MachineVaultSummary,
  type StaffSession,
} from '@keep/contracts';
import { auditStatement } from './audit';
import { uuid } from './crypto';
import { ConflictError, KeepError, NotFoundError } from './errors';
import { revokeAgentTokensStatement, type AgentPrincipal } from './tokens';

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

interface AgentRow {
  address: string;
  name: string;
  public_key: string | null;
  key_registered_at: string | null;
  vault_id: string | null;
}

const AGENT_SELECT = `
  SELECT a.address, a.name, a.public_key, a.key_registered_at,
         (SELECT id FROM vaults v WHERE v.agent = a.address AND v.machine = 1) AS vault_id
    FROM agents a`;

/** Every agent Keep knows: one Meet has brokered a token for. */
export async function listAgents(env: Env): Promise<AgentSummary[]> {
  const { results } = await env.DB.prepare(`${AGENT_SELECT} ORDER BY a.name, a.address`).all<AgentRow>();
  return results;
}

async function requireAgent(env: Env, address: string): Promise<AgentRow> {
  const row = await env.DB.prepare(`${AGENT_SELECT} WHERE a.address = ?`).bind(address).first<AgentRow>();
  if (!row) throw new NotFoundError('No such agent. Meet brokers an agent’s token before Keep knows it.');
  return row;
}

// ---------------------------------------------------------------------------
// The agent's own routes (an `agent` token)
// ---------------------------------------------------------------------------

/** What an agent token sees: itself and its vault, as names and counts. */
export async function agentSelf(env: Env, agent: AgentPrincipal): Promise<AgentSelf> {
  const row = await requireAgent(env, agent.address);
  const { results } = await env.DB.prepare(
    `SELECT v.id, v.name, v.key_version,
            EXISTS(SELECT 1 FROM vault_members m WHERE m.vault_id = v.id AND m.email = v.agent) AS member,
            (SELECT COUNT(*) FROM items WHERE vault_id = v.id) AS item_count
       FROM vaults v WHERE v.machine = 1 AND v.agent = ? ORDER BY v.name`,
  )
    .bind(agent.address)
    .all<{ id: string; name: string; key_version: number; member: number; item_count: number }>();
  return {
    address: row.address,
    name: row.name,
    public_key: row.public_key,
    key_registered_at: row.key_registered_at,
    vaults: results.map((vault) => ({ ...vault, member: vault.member === 1 })),
  };
}

/**
 * The broker's seam. The broker calls this with the agent's token
 * and the public half of the key pair it made and keeps. Set once: the same
 * key again is a no-op, a different one is 409. A person's Revoke clears it.
 */
export async function registerAgentKey(env: Env, agent: AgentPrincipal, body: unknown, request: Request): Promise<AgentSummary> {
  const input = registerAgentKeySchema.parse(body);
  const current = await requireAgent(env, agent.address);
  if (current.public_key === input.public_key) return current;
  if (current.public_key) throw new ConflictError('This agent already has a key. A person’s Revoke clears it.');
  await env.DB.batch([
    env.DB.prepare(`UPDATE agents SET suite = ?, public_key = ?, key_registered_at = ${NOW}, updated_at = ${NOW} WHERE address = ? AND public_key IS NULL`).bind(
      input.suite,
      input.public_key,
      agent.address,
    ),
    auditStatement(env, { vaultId: current.vault_id, actor: agent.address, kind: 'agent.key', request, detail: { registered: true } }),
  ]);
  return requireAgent(env, agent.address);
}

// ---------------------------------------------------------------------------
// Machine vaults (a person)
// ---------------------------------------------------------------------------

interface MachineRow {
  id: string;
  name: string;
  icon: string | null;
  key_version: number;
  agent: string;
  agent_name: string | null;
  agent_public_key: string | null;
  agent_member: number;
  item_count: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

const MACHINE_SELECT = `
  SELECT v.id, v.name, v.icon, v.key_version, v.agent, v.created_by, v.created_at, v.updated_at,
         a.name AS agent_name, a.public_key AS agent_public_key,
         EXISTS(SELECT 1 FROM vault_members m WHERE m.vault_id = v.id AND m.email = v.agent) AS agent_member,
         (SELECT COUNT(*) FROM items WHERE vault_id = v.id) AS item_count
    FROM vaults v LEFT JOIN agents a ON a.address = v.agent
   WHERE v.machine = 1`;

function toMachineSummary(row: MachineRow): MachineVaultSummary {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon,
    machine: true,
    agent: { address: row.agent, name: row.agent_name ?? row.agent, public_key: row.agent_public_key },
    key_version: row.key_version,
    agent_member: row.agent_member === 1,
    item_count: row.item_count,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function listMachineVaults(env: Env): Promise<MachineVaultSummary[]> {
  const { results } = await env.DB.prepare(`${MACHINE_SELECT} ORDER BY v.name`).all<MachineRow>();
  return results.map(toMachineSummary);
}

export async function requireMachineVault(env: Env, vaultId: string): Promise<MachineVaultSummary> {
  const row = await env.DB.prepare(`${MACHINE_SELECT} AND v.id = ?`).bind(vaultId).first<MachineRow>();
  if (!row) throw new NotFoundError('No such vault.');
  return toMachineSummary(row);
}

/** Names and who added them. The list carries no ciphertext and no wrap. */
export async function getMachineVault(env: Env, vaultId: string): Promise<MachineVaultDetail> {
  const summary = await requireMachineVault(env, vaultId);
  const { results } = await env.DB.prepare(
    `SELECT id, vault_id, name, kind, key_version, created_by, created_at, updated_at, rotated_at
       FROM items WHERE vault_id = ? ORDER BY name`,
  )
    .bind(vaultId)
    .all<ItemSummary>();
  return { ...summary, items: results };
}

/** A person makes the agent's vault: a fresh vault key, wrapped to the agent only. */
export async function createMachineVault(env: Env, session: StaffSession, body: unknown, request: Request): Promise<MachineVaultDetail> {
  const input = createMachineVaultSchema.parse(body);
  const agent = await requireAgent(env, input.agent);
  if (!agent.public_key) throw new KeepError('This agent has no key yet. The broker registers it.', 400, 'not_enrolled');
  if (agent.vault_id) throw new ConflictError('This agent already has a vault. One per agent.');
  const id = uuid();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO vaults (id, name, icon, key_version, created_by, machine, agent) VALUES (?, ?, ?, 1, ?, 1, ?)`).bind(
      id,
      input.name,
      input.icon ?? null,
      session.email,
      agent.address,
    ),
    env.DB.prepare(`INSERT INTO vault_members (vault_id, email, key_version, wrapped_key, granted_by) VALUES (?, ?, 1, ?, ?)`).bind(
      id,
      agent.address,
      JSON.stringify(input.wrapped_key),
      session.email,
    ),
    auditStatement(env, {
      vaultId: id,
      actor: session.email,
      kind: 'vault.create',
      request,
      detail: { name: input.name, machine: true, agent: agent.address },
    }),
  ]);
  return getMachineVault(env, id);
}

/**
 * Grant the agent again after a Revoke: a new vault key, wrapped to the key
 * the broker registered since, at the current version. The vault's only
 * member is its agent, so this is the only grant a machine vault takes.
 */
export async function grantAgent(env: Env, session: StaffSession, vaultId: string, body: unknown, request: Request): Promise<MachineVaultDetail> {
  const input = grantAgentSchema.parse(body);
  const vault = await requireMachineVault(env, vaultId);
  if (vault.agent_member) throw new ConflictError('The agent is already a member.');
  if (!vault.agent.public_key) throw new KeepError('This agent has no key yet. The broker registers it.', 400, 'not_enrolled');
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO vault_members (vault_id, email, key_version, wrapped_key, granted_by) VALUES (?, ?, ?, ?, ?)`).bind(
      vaultId,
      vault.agent.address,
      vault.key_version,
      JSON.stringify(input.wrapped_key),
      session.email,
    ),
    auditStatement(env, { vaultId, actor: session.email, kind: 'vault.grant', request, detail: { agent: vault.agent.address, key_version: vault.key_version } }),
  ]);
  return getMachineVault(env, vaultId);
}

/**
 * Revoke is rotate, for an agent. One batch: every token of the agent is
 * revoked, its membership and its registered key go, and the key version
 * goes up, so nothing sealed before can pass for current. A person cannot
 * re-seal what they cannot read, so the items stay as names until a person
 * enters a new value (and rotates it at the vendor, ADR 0007 decision 6).
 */
export async function revokeAgent(env: Env, session: StaffSession, vaultId: string, request: Request): Promise<MachineVaultDetail> {
  const vault = await requireMachineVault(env, vaultId);
  const next = vault.key_version + 1;
  await env.DB.batch([
    revokeAgentTokensStatement(env, vault.agent.address),
    env.DB.prepare(`DELETE FROM vault_members WHERE vault_id = ?`).bind(vaultId),
    env.DB.prepare(`UPDATE vaults SET key_version = ?, updated_at = ${NOW} WHERE id = ? AND key_version = ?`).bind(next, vaultId, vault.key_version),
    env.DB.prepare(`UPDATE agents SET suite = NULL, public_key = NULL, key_registered_at = NULL, updated_at = ${NOW} WHERE address = ?`).bind(
      vault.agent.address,
    ),
    auditStatement(env, {
      vaultId,
      actor: session.email,
      kind: 'agent.revoke',
      request,
      detail: { agent: vault.agent.address, key_version: next, items: vault.item_count },
    }),
  ]);
  return getMachineVault(env, vaultId);
}

// ---------------------------------------------------------------------------
// Machine vault items (a person writes; nobody reads here)
// ---------------------------------------------------------------------------

/** A write needs the agent to be a member at the version the client sealed for. */
function assertWritable(vault: MachineVaultSummary, keyVersion: number): void {
  if (!vault.agent_member || !vault.agent.public_key) {
    throw new KeepError('The agent has no access to this vault. Grant it again first.', 409, 'conflict');
  }
  if (keyVersion !== vault.key_version) {
    throw new ConflictError(`Vault is at key version ${vault.key_version}; reload and seal again.`, 'stale_rotation');
  }
}

async function requireMachineItem(env: Env, vaultId: string, itemId: string): Promise<ItemSummary> {
  const row = await env.DB.prepare(
    `SELECT id, vault_id, name, kind, key_version, created_by, created_at, updated_at, rotated_at FROM items WHERE id = ? AND vault_id = ?`,
  )
    .bind(itemId, vaultId)
    .first<ItemSummary>();
  if (!row) throw new NotFoundError('No such item.');
  return row;
}

export async function createMachineItem(env: Env, session: StaffSession, vaultId: string, body: unknown, request: Request): Promise<ItemSummary> {
  const input = createMachineItemSchema.parse(body);
  const vault = await requireMachineVault(env, vaultId);
  assertWritable(vault, input.key_version);
  const taken = await env.DB.prepare(`SELECT 1 AS present FROM items WHERE id = ?`).bind(input.id).first();
  if (taken) throw new ConflictError('Item id already used.');
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO items (id, vault_id, name, kind, key_version, iv, ciphertext, wrapped_key, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      input.id,
      vaultId,
      input.name,
      input.kind,
      input.key_version,
      input.sealed.iv,
      input.sealed.ciphertext,
      JSON.stringify(input.wrapped_key),
      session.email,
    ),
    auditStatement(env, { vaultId, itemId: input.id, itemName: input.name, actor: session.email, kind: 'item.create', request, detail: { machine: true } }),
  ]);
  return requireMachineItem(env, vaultId, input.id);
}

/** Rename, or rotate: a new body with its new item key wrap, both or neither. */
export async function updateMachineItem(
  env: Env,
  session: StaffSession,
  vaultId: string,
  itemId: string,
  body: unknown,
  request: Request,
): Promise<ItemSummary> {
  const input = updateMachineItemSchema.parse(body);
  const vault = await requireMachineVault(env, vaultId);
  const current = await requireMachineItem(env, vaultId, itemId);
  const resealed = Boolean(input.sealed);
  if (resealed !== Boolean(input.wrapped_key) || resealed !== (input.key_version !== undefined)) {
    throw new KeepError('sealed, wrapped_key and key_version travel together.', 400, 'invalid_request');
  }
  if (resealed) assertWritable(vault, input.key_version!);
  const name = input.name ?? current.name;
  const kind = input.kind ?? current.kind;
  const statement = input.sealed && input.wrapped_key
    ? env.DB.prepare(
        `UPDATE items SET name = ?, kind = ?, iv = ?, ciphertext = ?, wrapped_key = ?, key_version = ?, updated_at = ${NOW}, rotated_at = ${NOW}
          WHERE id = ? AND vault_id = ?`,
      ).bind(name, kind, input.sealed.iv, input.sealed.ciphertext, JSON.stringify(input.wrapped_key), vault.key_version, itemId, vaultId)
    : env.DB.prepare(`UPDATE items SET name = ?, kind = ?, updated_at = ${NOW} WHERE id = ? AND vault_id = ?`).bind(name, kind, itemId, vaultId);
  await env.DB.batch([
    statement,
    auditStatement(env, {
      vaultId,
      itemId,
      itemName: name,
      actor: session.email,
      kind: 'item.update',
      request,
      detail: { machine: true, resealed, renamed: name !== current.name },
    }),
  ]);
  return requireMachineItem(env, vaultId, itemId);
}

export async function deleteMachineItem(env: Env, session: StaffSession, vaultId: string, itemId: string, request: Request): Promise<void> {
  await requireMachineVault(env, vaultId);
  const current = await requireMachineItem(env, vaultId, itemId);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM items WHERE id = ? AND vault_id = ?`).bind(itemId, vaultId),
    auditStatement(env, { vaultId, itemId, itemName: current.name, actor: session.email, kind: 'item.delete', request, detail: { machine: true } }),
  ]);
}
