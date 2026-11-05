// Recovery: opening a vault when nobody who can is left.
//
// The recovery private key lives as two shares held by two people. A
// person holding both joins the shares on their device, opens a vault's
// recovery copy of its key, wraps that key to their own public key, and
// becomes a member. The server can verify none of the cryptography; what
// it can do is refuse to hand out anything that is not already sealed to
// the recovery key, and write down who asked and who joined. The audit row
// is the control: two named holders, and a trail anyone on staff can read.

import { recoveryJoinSchema, type RecoveryVaultEntry, type StaffSession, type WrappedToPublicKey } from '@keep/contracts';
import { auditStatement } from './audit';
import { ConflictError, KeepError, NotFoundError } from './errors';
import { getRecoveryKey, publicKeysFor } from './keys';

interface RecoveryRow {
  id: string;
  name: string;
  icon: string | null;
  project_id: string | null;
  key_version: number;
  member_count: number;
  members: string;
  wrapped_key: string;
}

/** Every vault with a recovery copy at its current key version. Audited. */
export async function listRecoveryVaults(env: Env, session: StaffSession, request: Request): Promise<RecoveryVaultEntry[]> {
  if (!(await getRecoveryKey(env))) throw new KeepError('No recovery key exists.', 400, 'invalid_request');
  const { results } = await env.DB.prepare(
    `SELECT v.id, v.name, v.icon, v.project_id, v.key_version,
            (SELECT COUNT(*) FROM vault_members WHERE vault_id = v.id) AS member_count,
            (SELECT COALESCE(GROUP_CONCAT(email, ','), '') FROM vault_members WHERE vault_id = v.id) AS members,
            r.wrapped_key
       FROM vaults v
       JOIN vault_recovery_keys r ON r.vault_id = v.id AND r.key_version = v.key_version
      WHERE v.machine = 0
      ORDER BY v.name`,
  ).all<RecoveryRow>();
  await auditStatement(env, { vaultId: null, actor: session.email, kind: 'recovery.list', request, detail: { vaults: results.length } }).run();
  return results.map((row) => ({
    id: row.id,
    name: row.name,
    icon: row.icon,
    project_id: row.project_id,
    key_version: row.key_version,
    member_count: row.member_count,
    members: row.members ? row.members.split(',') : [],
    recovery_wrapped_key: JSON.parse(row.wrapped_key) as WrappedToPublicKey,
  }));
}

/** The caller joins a vault they opened through recovery. Loud in the audit. */
export async function recoveryJoin(env: Env, session: StaffSession, vaultId: string, body: unknown, request: Request): Promise<void> {
  const input = recoveryJoinSchema.parse(body);
  // A machine vault never gains a person member, through recovery or otherwise.
  const vault = await env.DB.prepare(`SELECT id, name, key_version FROM vaults WHERE id = ? AND machine = 0`)
    .bind(vaultId)
    .first<{ id: string; name: string; key_version: number }>();
  if (!vault) throw new NotFoundError('No such vault.');
  const enrolled = await publicKeysFor(env, [session.email]);
  if (!enrolled.has(session.email)) throw new KeepError('Enrol before recovering a vault.', 400, 'not_enrolled');
  const member = await env.DB.prepare(`SELECT 1 AS present FROM vault_members WHERE vault_id = ? AND email = ?`).bind(vaultId, session.email).first();
  if (member) throw new ConflictError('You are already a member of this vault.');
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO vault_members (vault_id, email, key_version, wrapped_key, granted_by) VALUES (?, ?, ?, ?, ?)`).bind(
      vaultId,
      session.email,
      vault.key_version,
      JSON.stringify(input.wrapped_key),
      `recovery:${session.email}`,
    ),
    auditStatement(env, {
      vaultId,
      actor: session.email,
      kind: 'recovery.join',
      request,
      detail: { name: vault.name, key_version: vault.key_version },
    }),
  ]);
}
