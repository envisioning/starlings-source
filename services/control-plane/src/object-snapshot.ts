// A Durable Object's SQLite tables as JSON, and back (,
// docs/OPERATIONS.md §Backups and restore). Used by RoomCoordinator and
// ThreadCoordinator for the daily export to R2 and the admin restore, and
// by the jurisdiction move (object-moves.ts).
//
// The table list is read from `sqlite_master`, not from a hand list, so a
// table a later migration adds is exported without a change here. Cloudflare's
// own tables (`_cf_*`) and SQLite's (`sqlite_*`) are not ours and are left out.

import { z } from 'zod';

export const SNAPSHOT_VERSION = 1;

/** A SQLite value as JSON: a BLOB goes as base64 under `$base64`. */
export type SnapshotValue = string | number | null | { $base64: string };

export interface ObjectSnapshot {
  version: typeof SNAPSHOT_VERSION;
  exported_at: number;
  tables: Record<string, Array<Record<string, SnapshotValue>>>;
}

/** What `importState` accepts. A snapshot comes from R2, so it is read, not trusted. */
export const objectSnapshotSchema = z.object({
  version: z.literal(SNAPSHOT_VERSION),
  exported_at: z.number(),
  tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
});

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function ownTables(sql: SqlStorage): string[] {
  return sql.exec<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  ).toArray()
    .map((row) => row.name)
    .filter((name) => IDENTIFIER.test(name) && !name.startsWith('sqlite_') && !name.startsWith('_cf_'));
}

/**
 * Bookkeeping tables (`_sql_schema_migrations`) are exported but never
 * imported: the object's schema is the one its code has now, whatever the
 * snapshot's was.
 */
function isBookkeeping(table: string): boolean {
  return table.startsWith('_');
}

/** A BLOB does not survive JSON; it goes as base64 under one key and comes back as bytes. */
function encodeValue(value: SqlStorageValue): SnapshotValue {
  if (value instanceof ArrayBuffer) {
    let binary = '';
    for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
    return { $base64: btoa(binary) };
  }
  return value;
}

function decodeValue(value: unknown): SqlStorageValue {
  if (value && typeof value === 'object' && typeof (value as { $base64?: unknown }).$base64 === 'string') {
    const binary = atob((value as { $base64: string }).$base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes.buffer;
  }
  if (value === null || typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  throw new Error('A snapshot value is not a SQLite value.');
}

/** Every row of every table this object owns. */
export function exportSqlState(sql: SqlStorage, now = Date.now()): ObjectSnapshot {
  const tables: ObjectSnapshot['tables'] = {};
  for (const table of ownTables(sql)) {
    tables[table] = sql.exec(`SELECT * FROM "${table}"`).toArray()
      .map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, encodeValue(value)])));
  }
  return { version: SNAPSHOT_VERSION, exported_at: now, tables };
}

/**
 * Replace this object's tables with the snapshot's rows, in one transaction.
 * Fails closed before it writes anything: a snapshot that is not version 1,
 * or that names a table this object does not have (a thread's snapshot sent
 * to a room), is refused. A table the snapshot does not name is emptied, as
 * it was empty or did not exist when the snapshot was taken. A column the
 * snapshot has and the table no longer has is left out; a column the table
 * has and the snapshot does not takes its default.
 */
export function importSqlState(storage: DurableObjectStorage, input: unknown): Record<string, number> {
  const snapshot = objectSnapshotSchema.parse(input);
  const sql = storage.sql;
  const tables = ownTables(sql).filter((table) => !isBookkeeping(table));
  const unknown = Object.keys(snapshot.tables).filter((table) => !isBookkeeping(table) && !tables.includes(table));
  if (unknown.length > 0) throw new Error(`The snapshot has tables this object does not: ${unknown.join(', ')}.`);
  const columns = new Map(tables.map((table) => [
    table,
    new Set(sql.exec<{ name: string }>(`PRAGMA table_info("${table}")`).toArray().map((column) => column.name)),
  ]));
  const counts: Record<string, number> = {};
  storage.transactionSync(() => {
    for (const table of tables) sql.exec(`DELETE FROM "${table}"`);
    for (const table of tables) {
      const known = columns.get(table)!;
      const rows = snapshot.tables[table] ?? [];
      for (const row of rows) {
        const keys = Object.keys(row).filter((key) => known.has(key));
        if (keys.length === 0) continue;
        sql.exec(
          `INSERT INTO "${table}" (${keys.map((key) => `"${key}"`).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
          ...keys.map((key) => decodeValue(row[key])),
        );
      }
      counts[table] = rows.length;
    }
  });
  return counts;
}

// ── Freeze: an object that refuses every write ──────────────────
//
// An object that is moving to another jurisdiction must not take a write
// between the copy and the switch, or the write is lost. The freeze is a set
// of SQLite triggers on every table the object owns, so it covers every write
// path the coordinator has now and every one added later, without a check in
// each method. Reads still answer. A write fails with an error whose message
// holds `OBJECT_MOVING`; the Worker answers it with a 503 (worker-fetch.ts).

/** The marker a refused write's error message carries. */
export const OBJECT_MOVING = 'object_moving';

const FREEZE_PREFIX = '_frozen_';
const FREEZE_OPERATIONS = ['insert', 'update', 'delete'] as const;

function freezeTriggers(sql: SqlStorage): string[] {
  return sql.exec<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '\\_frozen\\_%' ESCAPE '\\'",
  ).toArray().map((row) => row.name);
}

export function isFrozenSql(sql: SqlStorage): boolean {
  return freezeTriggers(sql).length > 0;
}

/** Refuse every write to every table this object owns. Running it twice is harmless. */
export function freezeSql(sql: SqlStorage): void {
  for (const table of ownTables(sql).filter((name) => !isBookkeeping(name))) {
    for (const operation of FREEZE_OPERATIONS) {
      sql.exec(
        `CREATE TRIGGER IF NOT EXISTS "${FREEZE_PREFIX}${table}_${operation}" BEFORE ${operation.toUpperCase()} ON "${table}"
         BEGIN SELECT RAISE(ABORT, '${OBJECT_MOVING}'); END`,
      );
    }
  }
}

export function unfreezeSql(sql: SqlStorage): void {
  for (const name of freezeTriggers(sql)) {
    if (IDENTIFIER.test(name)) sql.exec(`DROP TRIGGER IF EXISTS "${name}"`);
  }
}

/**
 * Run the object's schema migration on a frozen object. A migration can write
 * rows (a backfill), and a frozen table would refuse it and break the object
 * in its constructor. So the freeze comes off for the migration and goes back
 * on, on every table, a table the migration added included.
 */
export function migrateFrozen(sql: SqlStorage, migrate: () => void): void {
  if (!isFrozenSql(sql)) {
    migrate();
    return;
  }
  unfreezeSql(sql);
  try {
    migrate();
  } finally {
    freezeSql(sql);
  }
}

/** True for an error a frozen object raised. It can arrive as a plain object after RPC. */
export function isObjectMovingError(error: unknown): boolean {
  const message = error instanceof Error
    ? error.message
    : error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string'
      ? (error as { message: string }).message
      : '';
  return message.includes(OBJECT_MOVING);
}

// ── Compare two snapshots ───────────────────────────────────────

export interface SnapshotMismatch {
  table: string;
  sourceRows: number;
  targetRows: number;
  /** The row counts agree and the rows do not. */
  rowsDiffer: boolean;
}

/** SHA-256 of a table's rows on `columns`, row and column order ignored. The table-group move (work-group-moves.ts) uses it too. */
export async function tableDigest(rows: ReadonlyArray<Record<string, SnapshotValue>>, columns: ReadonlySet<string>): Promise<string> {
  const lines = rows.map((row) => JSON.stringify(
    [...columns].sort().map((column) => [column, row[column] ?? null]),
  )).sort();
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(lines.join('\n')));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Every table where the target's rows are not the source's. A copy goes
 * through `importSqlState`, which keeps only the columns the target's table
 * has, so the rows are compared on the columns both sides have. Row order
 * and column order are not compared: a table built by later `ALTER`s has
 * another column order than one created fresh. Bookkeeping tables are left
 * out, as the import leaves them out. A table only the target has must be
 * empty.
 */
export async function compareSnapshots(source: ObjectSnapshot, target: ObjectSnapshot): Promise<SnapshotMismatch[]> {
  const mismatches: SnapshotMismatch[] = [];
  const tables = new Set([...Object.keys(source.tables), ...Object.keys(target.tables)]);
  for (const table of [...tables].sort()) {
    if (isBookkeeping(table)) continue;
    const from = source.tables[table] ?? [];
    const to = target.tables[table] ?? [];
    if (from.length !== to.length) {
      mismatches.push({ table, sourceRows: from.length, targetRows: to.length, rowsDiffer: false });
      continue;
    }
    if (from.length === 0) continue;
    const targetColumns = new Set(Object.keys(to[0]!));
    const columns = new Set(Object.keys(from[0]!).filter((column) => targetColumns.has(column)));
    if (await tableDigest(from, columns) !== await tableDigest(to, columns)) {
      mismatches.push({ table, sourceRows: from.length, targetRows: to.length, rowsDiffer: true });
    }
  }
  return mismatches;
}
