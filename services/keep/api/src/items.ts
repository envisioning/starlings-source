// Items. A list returns names; a reveal returns one ciphertext and writes
// one audit row. There is no route that returns more than one ciphertext,
// except rotation's input, which is a write.

import { createItemSchema, updateItemSchema, type ItemDetail, type ItemSummary, type StaffSession } from '@keep/contracts';
import { auditStatement } from './audit';
import { ConflictError, KeepError, NotFoundError } from './errors';
import { requireMembership } from './vaults';

interface ItemRow extends ItemSummary {
  iv: string;
  ciphertext: string;
}

const ITEM_COLUMNS = `id, vault_id, name, kind, key_version, iv, ciphertext, created_by, created_at, updated_at, rotated_at`;

async function requireItem(env: Env, vaultId: string, itemId: string): Promise<ItemRow> {
  const row = await env.DB.prepare(`SELECT ${ITEM_COLUMNS} FROM items WHERE id = ? AND vault_id = ?`)
    .bind(itemId, vaultId)
    .first<ItemRow>();
  if (!row) throw new NotFoundError('No such item.');
  return row;
}

function toDetail(row: ItemRow): ItemDetail {
  const { iv, ciphertext, ...summary } = row;
  return { ...summary, sealed: { iv, ciphertext } };
}

export async function createItem(env: Env, session: StaffSession, vaultId: string, body: unknown, request: Request): Promise<ItemDetail> {
  const input = createItemSchema.parse(body);
  const vault = await requireMembership(env, session, vaultId);
  if (input.key_version !== vault.key_version) {
    throw new ConflictError(`Vault is at key version ${vault.key_version}; reload and seal again.`, 'stale_rotation');
  }
  const taken = await env.DB.prepare(`SELECT 1 AS present FROM items WHERE id = ?`).bind(input.id).first();
  if (taken) throw new ConflictError('Item id already used.');
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO items (id, vault_id, name, kind, key_version, iv, ciphertext, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(input.id, vaultId, input.name, input.kind, input.key_version, input.sealed.iv, input.sealed.ciphertext, session.email),
    auditStatement(env, {
      vaultId,
      itemId: input.id,
      itemName: input.name,
      actor: session.email,
      kind: 'item.create',
      request,
    }),
  ]);
  return toDetail(await requireItem(env, vaultId, input.id));
}

/** The reveal. One item, one audit row, rate-limited per person. */
export async function revealItem(env: Env, session: StaffSession, vaultId: string, itemId: string, request: Request): Promise<ItemDetail> {
  await requireMembership(env, session, vaultId);
  const row = await requireItem(env, vaultId, itemId);
  await auditStatement(env, {
    vaultId,
    itemId,
    itemName: row.name,
    actor: session.email,
    kind: 'item.reveal',
    request,
  }).run();
  return toDetail(row);
}

export async function updateItem(
  env: Env,
  session: StaffSession,
  vaultId: string,
  itemId: string,
  body: unknown,
  request: Request,
): Promise<ItemDetail> {
  const input = updateItemSchema.parse(body);
  const vault = await requireMembership(env, session, vaultId);
  const current = await requireItem(env, vaultId, itemId);
  if (input.sealed && input.key_version !== vault.key_version) {
    throw new ConflictError(`Vault is at key version ${vault.key_version}; reload and seal again.`, 'stale_rotation');
  }
  if (!input.sealed && input.key_version !== undefined) {
    throw new KeepError('key_version travels with a new sealed body.', 400, 'invalid_request');
  }
  const name = input.name ?? current.name;
  const kind = input.kind ?? current.kind;
  const iv = input.sealed?.iv ?? current.iv;
  const ciphertext = input.sealed?.ciphertext ?? current.ciphertext;
  const keyVersion = input.sealed ? vault.key_version : current.key_version;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE items SET name = ?, kind = ?, iv = ?, ciphertext = ?, key_version = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ? AND vault_id = ?`,
    ).bind(name, kind, iv, ciphertext, keyVersion, itemId, vaultId),
    auditStatement(env, {
      vaultId,
      itemId,
      itemName: name,
      actor: session.email,
      kind: 'item.update',
      request,
      detail: { resealed: Boolean(input.sealed), renamed: name !== current.name },
    }),
  ]);
  return toDetail(await requireItem(env, vaultId, itemId));
}

export async function deleteItem(env: Env, session: StaffSession, vaultId: string, itemId: string, request: Request): Promise<void> {
  await requireMembership(env, session, vaultId);
  const current = await requireItem(env, vaultId, itemId);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM items WHERE id = ? AND vault_id = ?`).bind(itemId, vaultId),
    auditStatement(env, {
      vaultId,
      itemId,
      itemName: current.name,
      actor: session.email,
      kind: 'item.delete',
      request,
    }),
  ]);
}
