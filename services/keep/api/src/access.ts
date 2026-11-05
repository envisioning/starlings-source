// Who can use a vault or an item (ADR 0007 decision 7).
//
// Standing access is membership: people in a person's vault, the agent in a
// machine vault. Last use is the newest `item.reveal` (a person) or
// `item.use` (the broker) by that principal, from the audit trail.
// Releases join from `releases.ts`. Names and times only:
// never a wrap, never a ciphertext.

import type { AccessEntry, VaultAccess } from '@keep/contracts';
import { NotFoundError } from './errors';
import { liveReleases } from './releases';

const USE_KINDS = `('item.reveal', 'item.use')`;

/**
 * The members of one vault with their last use. The caller has already
 * proved it may see this vault (`requireMembership` or `requireMachineVault`).
 */
export async function vaultAccess(env: Env, vault: { id: string; machine: boolean }, itemId: string | null): Promise<VaultAccess> {
  if (itemId) {
    const item = await env.DB.prepare(`SELECT 1 AS present FROM items WHERE id = ? AND vault_id = ?`).bind(itemId, vault.id).first();
    if (!item) throw new NotFoundError('No such item.');
  }
  const names = vault.machine ? `LEFT JOIN agents n ON n.address = m.email` : `LEFT JOIN staff_keys n ON n.email = m.email`;
  const itemClause = itemId ? `AND e.item_id = ?` : '';
  const statement = env.DB.prepare(
    `SELECT m.email AS address, COALESCE(n.name, m.email) AS name, m.granted_by, m.created_at AS since,
            (SELECT MAX(e.created_at) FROM audit_events e
              WHERE e.vault_id = m.vault_id AND e.actor = m.email AND e.kind IN ${USE_KINDS} ${itemClause}) AS last_used_at
       FROM vault_members m ${names}
      WHERE m.vault_id = ?
      ORDER BY name`,
  );
  const { results } = await (itemId ? statement.bind(itemId, vault.id) : statement.bind(vault.id)).all<Omit<AccessEntry, 'kind'>>();
  const kind = vault.machine ? 'agent' : 'person';
  const entries: AccessEntry[] = results.map((row) => ({ kind, ...row }));
  return {
    vault_id: vault.id,
    item_id: itemId,
    people: vault.machine ? [] : entries,
    agents: vault.machine ? entries : [],
    // A machine vault takes no release (releases.ts), so it has no section.
    ...(vault.machine ? {} : { releases: await liveReleases(env, vault.id, itemId) }),
  };
}
