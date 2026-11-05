// The activity trail of the work model on D1 (migration 0133).
//
// Every work-model write the Worker sends to D1 adds one row: who, which
// table and row, insert, update or delete, the fields the write set, when.
// Core keeps its own `activity_events` for the groups still on Core; this
// trail starts with the first D1 write. Admin › Activity reads it, for
// admins only.
//
// Best effort, as the admin audit is: the row is written after the write it
// describes, and a lost row is logged, never turned into a failed write.

import type { WorkActivityQuery, WorkActivityResponse } from '@starlings/contracts/work-activity';

export type WorkActivityAction = 'insert' | 'update' | 'delete';

export interface WorkActivityEntry {
  actor: string | null;
  table: string;
  id: string;
  action: WorkActivityAction;
  label?: string | null;
  /** The fields the write set. */
  fields?: readonly string[];
}

/** Keys that steer a write rather than set a field. */
const NOT_FIELDS = new Set(['kind', 'actor_email', 'source_key']);

/** The fields an input sets: present, not undefined, not a steering key. */
export function fieldsOf(input: object | null | undefined): string[] {
  if (!input) return [];
  return Object.entries(input).filter(([key, value]) => value !== undefined && !NOT_FIELDS.has(key)).map(([key]) => key).sort();
}

const LABEL_MAX = 200;

/** One trail row, for a caller that writes it in the same batch as the change. */
export function workActivityStatement(env: Env, entry: WorkActivityEntry, at = Date.now()): D1PreparedStatement {
  return env.USAGE.prepare(
    `INSERT INTO work_activity (at, actor, table_name, row_id, action, label, changed_fields)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  ).bind(
    at, entry.actor?.trim().toLowerCase() || null, entry.table, entry.id, entry.action,
    entry.label?.trim().slice(0, LABEL_MAX) || null, JSON.stringify([...new Set(entry.fields ?? [])]),
  );
}

/** Append trail rows after the write they describe. Never throws. */
export async function recordWorkActivity(env: Env, ...entries: WorkActivityEntry[]): Promise<void> {
  if (entries.length === 0) return;
  try {
    const at = Date.now();
    await env.USAGE.batch(entries.map((entry) => workActivityStatement(env, entry, at)));
  } catch (error) {
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'work.activity.write.failed',
      table: entries[0]!.table,
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
  }
}

interface ActivityRow {
  id: number;
  at: number;
  actor: string | null;
  table_name: string;
  row_id: string;
  action: WorkActivityAction;
  label: string | null;
  changed_fields: string;
}

const PAGE = 50;

const like = (query: string) => `%${query.trim().replace(/[\\%_]/gu, (match) => `\\${match}`)}%`;

function fieldList(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * `GET /api/admin/activity`: newest first, 50 a page, with Core's feed's
 * filters: text (label, row id, field), table, action, actor, and a day
 * range. `cursor` is the last row's id.
 */
export async function listWorkActivity(env: Env, query: WorkActivityQuery): Promise<WorkActivityResponse> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (query.q?.trim()) {
    where.push(`(label LIKE ? ESCAPE '\\' OR row_id LIKE ? ESCAPE '\\' OR changed_fields LIKE ? ESCAPE '\\')`);
    binds.push(like(query.q), like(query.q), like(query.q));
  }
  if (query.table) { where.push('table_name = ?'); binds.push(query.table); }
  if (query.action) { where.push('action = ?'); binds.push(query.action); }
  if (query.actor) { where.push('actor = ?'); binds.push(query.actor.toLowerCase()); }
  if (query.from) { where.push('at >= ?'); binds.push(Date.parse(`${query.from}T00:00:00Z`)); }
  if (query.to) { where.push('at < ?'); binds.push(Date.parse(`${query.to}T00:00:00Z`) + 86_400_000); }
  if (query.cursor) { where.push('id < ?'); binds.push(query.cursor); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [page, tables, actors] = await env.USAGE.batch([
    env.USAGE.prepare(`SELECT id, at, actor, table_name, row_id, action, label, changed_fields FROM work_activity ${clause}
                        ORDER BY id DESC LIMIT ?`).bind(...binds, PAGE + 1),
    env.USAGE.prepare('SELECT DISTINCT table_name AS value FROM work_activity ORDER BY value'),
    env.USAGE.prepare('SELECT DISTINCT actor AS value FROM work_activity WHERE actor IS NOT NULL ORDER BY value'),
  ]);
  const rows = page!.results as unknown as ActivityRow[];
  const items = rows.slice(0, PAGE).map((row) => ({
    id: row.id,
    at: new Date(row.at).toISOString(),
    actor: row.actor,
    table: row.table_name,
    row_id: row.row_id,
    action: row.action,
    label: row.label,
    changed_fields: fieldList(row.changed_fields),
  }));
  return {
    items,
    next_cursor: rows.length > PAGE ? items[items.length - 1]!.id : null,
    tables: (tables!.results as Array<{ value: string }>).map((row) => row.value),
    actors: (actors!.results as Array<{ value: string }>).map((row) => row.value),
  };
}
