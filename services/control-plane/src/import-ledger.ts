// The mapping, the ledger and the pulse every connector shares (,
// docs/CONNECTORS.md).
//
// - `import_mappings`: what a person decided for one external thing, a
//   subject or a skip. One row per `(source, external_id)`: a mapping is a
//   company decision, whoever's token reads it.
// - `import_ledger`: where the sync stands on one external thing, for one
//   member. `owner_sub = ''` is a workspace-level connector (GitHub, Slack);
//   a per-member connector (Gmail, Drive) keeps one row per member.
// - `connector_pulse`: when each connector last did each thing, for its card.
//
// A connector passes its `source` and never writes these tables itself.
import type { ConnectorId, ImportItemState } from './contracts';

/** A workspace-level connector's ledger rows carry no member. */
export const WORKSPACE = '';

/** `K` is the connector's own subject kinds; the table stores any string. */
export interface MappingRow<K extends string = string> {
  external_id: string;
  subject_kind: K | null;
  subject_id: string | null;
  subject_title: string | null;
  decided_by: string;
  decided_at: number;
}

export interface ItemRow {
  external_id: string;
  owner_sub: string;
  status: string;
  cursor: string | null;
  backfill_done: number;
  count: number;
  last_synced_at: number | null;
  error: string | null;
}

export type ItemPatch = Partial<Omit<ItemRow, 'external_id' | 'owner_sub'>> & { status: string };

export interface MappingInput {
  subject_kind: string | null;
  subject_id: string | null;
  subject_title: string | null;
}

// ------------------------------------------------------------------ mappings

export async function readMappings<K extends string = string>(env: Env, source: string): Promise<Map<string, MappingRow<K>>> {
  const { results } = await env.USAGE.prepare(
    `SELECT external_id, subject_kind, subject_id, subject_title, decided_by, decided_at
       FROM import_mappings WHERE source = ?1`,
  ).bind(source).all<MappingRow<K>>();
  return new Map(results.map((row) => [row.external_id, row]));
}

export async function readMapping<K extends string = string>(env: Env, source: string, externalId: string): Promise<MappingRow<K> | null> {
  return env.USAGE.prepare(
    `SELECT external_id, subject_kind, subject_id, subject_title, decided_by, decided_at
       FROM import_mappings WHERE source = ?1 AND external_id = ?2`,
  ).bind(source, externalId).first<MappingRow<K>>();
}

/** Save a decision. A skip is a row with no subject, so the list does not ask again. */
export async function writeMapping(env: Env, source: string, externalId: string, input: MappingInput, actor: string): Promise<void> {
  await env.USAGE.prepare(
    `INSERT INTO import_mappings (source, external_id, subject_kind, subject_id, subject_title, decided_by, decided_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT(source, external_id) DO UPDATE SET
       subject_kind = excluded.subject_kind,
       subject_id = excluded.subject_id,
       subject_title = excluded.subject_title,
       decided_by = excluded.decided_by,
       decided_at = excluded.decided_at`,
  ).bind(source, externalId, input.subject_kind, input.subject_id, input.subject_title, actor, Date.now()).run();
}

// -------------------------------------------------------------------- ledger

const ITEM_COLUMNS = 'external_id, owner_sub, status, cursor, backfill_done, count, last_synced_at, error';

/** One member's rows for a source, by external id. Workspace connectors read `WORKSPACE`. */
export async function readItems(env: Env, source: string, ownerSub: string = WORKSPACE): Promise<Map<string, ItemRow>> {
  const { results } = await env.USAGE.prepare(
    `SELECT ${ITEM_COLUMNS} FROM import_ledger WHERE source = ?1 AND owner_sub = ?2`,
  ).bind(source, ownerSub).all<ItemRow>();
  return new Map(results.map((row) => [row.external_id, row]));
}

/** Every member's row for one external thing: a per-member list shows one state per mailbox. */
export async function readItemsForExternal(env: Env, source: string, externalId: string): Promise<ItemRow[]> {
  const { results } = await env.USAGE.prepare(
    `SELECT ${ITEM_COLUMNS} FROM import_ledger WHERE source = ?1 AND external_id = ?2 ORDER BY owner_sub`,
  ).bind(source, externalId).all<ItemRow>();
  return results;
}

export async function readItem(env: Env, source: string, externalId: string, ownerSub: string = WORKSPACE): Promise<ItemRow | null> {
  return env.USAGE.prepare(
    `SELECT ${ITEM_COLUMNS} FROM import_ledger WHERE source = ?1 AND external_id = ?2 AND owner_sub = ?3`,
  ).bind(source, externalId, ownerSub).first<ItemRow>();
}

/**
 * Move a row forward. A null cursor or time keeps the stored one, a count of
 * zero keeps the stored count, and `backfill_done` never goes back to 0 here:
 * only a reverse resets them.
 */
export async function writeItem(
  env: Env,
  source: string,
  externalId: string,
  patch: ItemPatch,
  ownerSub: string = WORKSPACE,
): Promise<void> {
  await env.USAGE.prepare(
    `INSERT INTO import_ledger (source, external_id, owner_sub, status, cursor, backfill_done, count, last_synced_at, error)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT(source, external_id, owner_sub) DO UPDATE SET
       status = excluded.status,
       cursor = COALESCE(excluded.cursor, import_ledger.cursor),
       backfill_done = MAX(import_ledger.backfill_done, excluded.backfill_done),
       count = CASE WHEN excluded.count > 0 THEN excluded.count ELSE import_ledger.count END,
       last_synced_at = COALESCE(excluded.last_synced_at, import_ledger.last_synced_at),
       error = excluded.error`,
  ).bind(
    source, externalId, ownerSub, patch.status, patch.cursor ?? null, patch.backfill_done ?? 0,
    patch.count ?? 0, patch.last_synced_at ?? null, patch.error ?? null,
  ).run();
}

/**
 * The ledger half of a reverse: the cursor, the count and the backfill flag
 * reset, the mapping stays. With no `ownerSub`, every member's row resets;
 * with one, only that member's (Gmail's reverse is per mailbox).
 */
export async function resetItems(env: Env, sources: string[], externalId: string, ownerSub?: string): Promise<void> {
  const placeholders = sources.map((_, index) => `?${index + 3}`).join(', ');
  const ownerClause = ownerSub === undefined ? '' : ' AND owner_sub = ?2';
  await env.USAGE.prepare(
    `UPDATE import_ledger SET status = 'queued', cursor = NULL, backfill_done = 0, count = 0, error = NULL
      WHERE external_id = ?1${ownerClause} AND source IN (${placeholders})`,
  ).bind(externalId, ownerSub ?? null, ...sources).run();
}

/** The state a connector list draws for one row. */
export function stateOf(mapping: MappingRow<string> | null | undefined, item: ItemRow | null | undefined): ImportItemState {
  if (!mapping) return 'unmapped';
  if (!mapping.subject_kind) return 'skipped';
  if (!item) return 'queued';
  switch (item.status) {
    case 'importing': return 'importing';
    case 'synced': return 'synced';
    case 'failed': return 'failed';
    default: return 'queued';
  }
}

// --------------------------------------------------------------------- pulse

export type ConnectorEvent = 'webhook' | 'import' | 'sync' | 'tick' | 'run';

/** The latest time a connector did a thing, for its card. Best effort. */
export async function touchConnector(env: Env, connector: ConnectorId, event: ConnectorEvent): Promise<void> {
  try {
    await env.USAGE.prepare(
      `INSERT INTO connector_pulse (connector, event, at) VALUES (?1, ?2, ?3)
       ON CONFLICT(connector, event) DO UPDATE SET at = excluded.at`,
    ).bind(connector, event, Date.now()).run();
  } catch {
    // A missed pulse is a stale timestamp on a card, never a failed import.
  }
}

export async function connectorPulse(env: Env, connector: ConnectorId): Promise<Record<string, number>> {
  try {
    const { results } = await env.USAGE.prepare(
      'SELECT event, at FROM connector_pulse WHERE connector = ?1',
    ).bind(connector).all<{ event: string; at: number }>();
    return Object.fromEntries(results.map((row) => [row.event, row.at]));
  } catch {
    return {};
  }
}
