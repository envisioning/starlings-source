// Vaults and membership.
//
// The access rule, stated once: **a person can reach a vault only if a
// `vault_members` row wraps its key to them.** Every route here begins by
// loading that row for the caller. Being staff is not enough; being the
// creator is not enough once you have left. There is no admin override,
// because an override would be a key the server holds.
//
// Machine vaults (machine.ts) never pass through here: `MEMBERSHIP_SELECT`
// excludes them, so a person's routes, the reveal among them, answer 404 for
// one. And a person's vault never gains an agent: every wrap here must target
// a `staff_keys` row, and an agent's address can never enrol (keys.ts).

import {
  coverVaultSchema,
  createVaultSchema,
  grantSchema,
  rotateVaultSchema,
  updateVaultSchema,
  type ItemSummary,
  type StaffSession,
  type VaultDetail,
  type VaultMember,
  type VaultSummary,
  type WrappedToPublicKey,
} from '@keep/contracts';
import { auditStatement } from './audit';
import { uuid } from './crypto';
import { ConflictError, KeepError, NotFoundError } from './errors';
import { assertAdmittedEmail } from './identity';
import { getRecoveryKey, publicKeysFor } from './keys';

interface VaultRow {
  id: string;
  name: string;
  icon: string | null;
  project_id: string | null;
  key_version: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface MembershipRow extends VaultRow {
  wrapped_key: string;
  member_key_version: number;
  member_count: number;
  item_count: number;
  recovery_wrapped: number;
}

const MEMBERSHIP_SELECT = `
  SELECT v.*,
         m.wrapped_key,
         m.key_version AS member_key_version,
         (SELECT COUNT(*) FROM vault_members WHERE vault_id = v.id) AS member_count,
         (SELECT COUNT(*) FROM items WHERE vault_id = v.id) AS item_count,
         EXISTS(SELECT 1 FROM vault_recovery_keys r WHERE r.vault_id = v.id AND r.key_version = v.key_version) AS recovery_wrapped
    FROM vaults v
    JOIN vault_members m ON m.vault_id = v.id AND m.email = ? AND v.machine = 0`;

function toSummary(row: MembershipRow): VaultSummary {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon,
    project_id: row.project_id,
    key_version: row.key_version,
    wrapped_key: JSON.parse(row.wrapped_key) as WrappedToPublicKey,
    recovery_wrapped: row.recovery_wrapped === 1,
    member_count: row.member_count,
    item_count: row.item_count,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function listVaults(env: Env, session: StaffSession): Promise<VaultSummary[]> {
  const { results } = await env.DB.prepare(`${MEMBERSHIP_SELECT} ORDER BY v.name`).bind(session.email).all<MembershipRow>();
  return results.map(toSummary);
}

/** The caller's membership, or 404. Not 403: a vault you cannot open does not exist for you. */
export async function requireMembership(env: Env, session: StaffSession, vaultId: string): Promise<VaultSummary> {
  const row = await env.DB.prepare(`${MEMBERSHIP_SELECT} WHERE v.id = ?`).bind(session.email, vaultId).first<MembershipRow>();
  if (!row) throw new NotFoundError('No such vault.');
  return toSummary(row);
}

export async function getVault(env: Env, session: StaffSession, vaultId: string): Promise<VaultDetail> {
  const summary = await requireMembership(env, session, vaultId);
  const [members, items] = await Promise.all([
    env.DB.prepare(
      `SELECT m.email, COALESCE(k.name, m.email) AS name, m.granted_by, m.created_at
         FROM vault_members m LEFT JOIN staff_keys k ON k.email = m.email
        WHERE m.vault_id = ? ORDER BY name`,
    )
      .bind(vaultId)
      .all<VaultMember>(),
    env.DB.prepare(
      `SELECT id, vault_id, name, kind, key_version, created_by, created_at, updated_at, rotated_at
         FROM items WHERE vault_id = ? ORDER BY name`,
    )
      .bind(vaultId)
      .all<ItemSummary>(),
  ]);
  return { ...summary, members: members.results, items: items.results };
}

/**
 * The recovery rule. Once an org recovery key exists, every vault key must
 * also be wrapped to it, or a lost laptop loses the vault. Before one
 * exists, a recovery wrap is meaningless and is refused so nobody wraps to
 * a key of their own invention.
 */
async function assertRecoveryWrap(env: Env, wrap: WrappedToPublicKey | null): Promise<void> {
  const recovery = await getRecoveryKey(env);
  if (recovery && !wrap) {
    throw new KeepError('A recovery key exists; wrap the vault key to it.', 400, 'invalid_request');
  }
  if (!recovery && wrap) {
    throw new KeepError('No recovery key exists yet; nothing to wrap to.', 400, 'invalid_request');
  }
}

/** Every wrap must target an admitted, enrolled person; the caller must be among them. */
async function assertMembersEnrolled(env: Env, session: StaffSession, emails: string[], mustIncludeCaller: boolean): Promise<void> {
  for (const email of emails) assertAdmittedEmail(env, email, 'members.email');
  if (mustIncludeCaller && !emails.includes(session.email)) {
    throw new KeepError('You must wrap the vault key to yourself.', 400, 'invalid_request');
  }
  if (new Set(emails).size !== emails.length) {
    throw new KeepError('A member is listed twice.', 400, 'invalid_request');
  }
  const known = await publicKeysFor(env, emails);
  const missing = emails.filter((email) => !known.has(email));
  if (missing.length > 0) {
    throw new KeepError(`Not enrolled in Keep: ${missing.join(', ')}.`, 400, 'not_enrolled');
  }
}

export async function createVault(env: Env, session: StaffSession, body: unknown, request: Request): Promise<VaultDetail> {
  const input = createVaultSchema.parse(body);
  await assertMembersEnrolled(env, session, input.members.map((member) => member.email), true);
  await assertRecoveryWrap(env, input.recovery_wrapped_key);

  const id = uuid();
  const statements = [
    env.DB.prepare(`INSERT INTO vaults (id, name, icon, project_id, key_version, created_by) VALUES (?, ?, ?, ?, 1, ?)`).bind(
      id,
      input.name,
      input.icon ?? null,
      input.project_id ?? null,
      session.email,
    ),
    ...input.members.map((member) =>
      env.DB.prepare(
        `INSERT INTO vault_members (vault_id, email, key_version, wrapped_key, granted_by) VALUES (?, ?, 1, ?, ?)`,
      ).bind(id, member.email, JSON.stringify(member.wrapped_key), session.email),
    ),
  ];
  if (input.recovery_wrapped_key) {
    statements.push(
      env.DB.prepare(`INSERT INTO vault_recovery_keys (vault_id, key_version, wrapped_key) VALUES (?, 1, ?)`).bind(
        id,
        JSON.stringify(input.recovery_wrapped_key),
      ),
    );
  }
  statements.push(
    auditStatement(env, {
      vaultId: id,
      actor: session.email,
      kind: 'vault.create',
      request,
      detail: { name: input.name, members: input.members.map((member) => member.email) },
    }),
  );
  await env.DB.batch(statements);
  return getVault(env, session, id);
}

export async function updateVault(env: Env, session: StaffSession, vaultId: string, body: unknown, request: Request): Promise<VaultDetail> {
  const input = updateVaultSchema.parse(body);
  const vault = await requireMembership(env, session, vaultId);
  const name = input.name ?? vault.name;
  const icon = input.icon === undefined ? vault.icon : input.icon;
  const projectId = input.project_id === undefined ? vault.project_id : input.project_id;
  await env.DB.batch([
    env.DB.prepare(`UPDATE vaults SET name = ?, icon = ?, project_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).bind(
      name,
      icon,
      projectId,
      vaultId,
    ),
    auditStatement(env, {
      vaultId,
      actor: session.email,
      kind: 'vault.update',
      request,
      detail: { name, icon, project_id: projectId },
    }),
  ]);
  return getVault(env, session, vaultId);
}

/** Grant: a member wraps the current vault key to a colleague. */
export async function grantMember(env: Env, session: StaffSession, vaultId: string, body: unknown, request: Request): Promise<VaultDetail> {
  const input = grantSchema.parse(body);
  const vault = await requireMembership(env, session, vaultId);
  await assertMembersEnrolled(env, session, [input.email], false);
  const existing = await env.DB.prepare(`SELECT 1 AS present FROM vault_members WHERE vault_id = ? AND email = ?`)
    .bind(vaultId, input.email)
    .first();
  if (existing) throw new ConflictError(`${input.email} is already a member.`);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO vault_members (vault_id, email, key_version, wrapped_key, granted_by) VALUES (?, ?, ?, ?, ?)`).bind(
      vaultId,
      input.email,
      vault.key_version,
      JSON.stringify(input.wrapped_key),
      session.email,
    ),
    auditStatement(env, {
      vaultId,
      actor: session.email,
      kind: 'vault.grant',
      request,
      detail: { email: input.email },
    }),
  ]);
  return getVault(env, session, vaultId);
}

/**
 * Rotate: the only way a member leaves. The client sends a complete new
 * generation — every remaining member's wrap, the recovery wrap, and every
 * item re-sealed — and it lands in one batch or not at all.
 *
 * Checked here, because the server can: the version is current + 1, every
 * live item is present exactly once, every wrapped member is enrolled, the
 * caller stays. Not checked, because the server cannot: that the new
 * ciphertexts open under the new key. A client that lies here corrupts
 * the vault for everyone including itself; the previous generation's
 * recovery wrap is kept so the holders can still open the old rows.
 */
export async function rotateVault(env: Env, session: StaffSession, vaultId: string, body: unknown, request: Request): Promise<VaultDetail> {
  const input = rotateVaultSchema.parse(body);
  const vault = await requireMembership(env, session, vaultId);
  if (input.key_version !== vault.key_version + 1) {
    throw new ConflictError(`Vault is at key version ${vault.key_version}; rotation must target ${vault.key_version + 1}.`, 'stale_rotation');
  }
  const members = input.members.map((member) => member.email);
  await assertMembersEnrolled(env, session, members, true);
  await assertRecoveryWrap(env, input.recovery_wrapped_key);

  const { results: live } = await env.DB.prepare(`SELECT id FROM items WHERE vault_id = ?`).bind(vaultId).all<{ id: string }>();
  const liveIDs = new Set(live.map((row) => row.id));
  const sentIDs = new Set(input.items.map((item) => item.id));
  if (liveIDs.size !== sentIDs.size || [...liveIDs].some((id) => !sentIDs.has(id))) {
    throw new ConflictError('Rotation must re-seal every item in the vault exactly once.', 'stale_rotation');
  }

  const { results: before } = await env.DB.prepare(`SELECT email FROM vault_members WHERE vault_id = ?`).bind(vaultId).all<{ email: string }>();
  const removed = before.map((row) => row.email).filter((email) => !members.includes(email));

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`UPDATE vaults SET key_version = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND key_version = ?`).bind(
      input.key_version,
      vaultId,
      vault.key_version,
    ),
    env.DB.prepare(`DELETE FROM vault_members WHERE vault_id = ?`).bind(vaultId),
    ...input.members.map((member) =>
      env.DB.prepare(`INSERT INTO vault_members (vault_id, email, key_version, wrapped_key, granted_by) VALUES (?, ?, ?, ?, ?)`).bind(
        vaultId,
        member.email,
        input.key_version,
        JSON.stringify(member.wrapped_key),
        session.email,
      ),
    ),
    ...input.items.map((item) =>
      env.DB.prepare(
        `UPDATE items SET iv = ?, ciphertext = ?, key_version = ?, rotated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND vault_id = ?`,
      ).bind(item.sealed.iv, item.sealed.ciphertext, input.key_version, item.id, vaultId),
    ),
  ];
  if (input.recovery_wrapped_key) {
    statements.push(
      env.DB.prepare(`INSERT INTO vault_recovery_keys (vault_id, key_version, wrapped_key) VALUES (?, ?, ?)`).bind(
        vaultId,
        input.key_version,
        JSON.stringify(input.recovery_wrapped_key),
      ),
    );
  }
  statements.push(
    auditStatement(env, {
      vaultId,
      actor: session.email,
      kind: 'vault.rotate',
      request,
      detail: { key_version: input.key_version, removed, members, items: input.items.length },
    }),
  );
  await env.DB.batch(statements);
  return getVault(env, session, vaultId);
}

/**
 * Cover: a member adds the recovery wrap a vault is missing — one made
 * before the recovery key existed. Requires a recovery key; refuses a vault
 * already covered at its current version.
 */
export async function coverVault(env: Env, session: StaffSession, vaultId: string, body: unknown, request: Request): Promise<VaultDetail> {
  const input = coverVaultSchema.parse(body);
  const vault = await requireMembership(env, session, vaultId);
  if (!(await getRecoveryKey(env))) throw new KeepError('No recovery key exists yet.', 400, 'invalid_request');
  if (vault.recovery_wrapped) throw new ConflictError('This vault is already covered.');
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO vault_recovery_keys (vault_id, key_version, wrapped_key) VALUES (?, ?, ?)`).bind(
      vaultId,
      vault.key_version,
      JSON.stringify(input.recovery_wrapped_key),
    ),
    auditStatement(env, { vaultId, actor: session.email, kind: 'vault.cover', request, detail: { key_version: vault.key_version } }),
  ]);
  return getVault(env, session, vaultId);
}

/** Delete: any member may. The audit rows stay; the ciphertext goes. */
export async function deleteVault(env: Env, session: StaffSession, vaultId: string, request: Request): Promise<void> {
  const vault = await requireMembership(env, session, vaultId);
  await env.DB.batch([
    // Cascades to members, recovery keys and items.
    env.DB.prepare(`DELETE FROM vaults WHERE id = ?`).bind(vaultId),
    auditStatement(env, {
      vaultId,
      actor: session.email,
      kind: 'vault.delete',
      request,
      detail: { name: vault.name, items: vault.item_count },
    }),
  ]);
}
