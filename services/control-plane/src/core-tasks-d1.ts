// Fold group 2 in Core's names. After the `tasks` group moves to
// D1, Core's own task writers (the proposed task an offer files, the Signals
// demo debrief's next task) and Core's public readers (the project page, the
// milestones.ics feed) come here through `/api/internal/core-writes` and
// `/api/internal/core-reads`. A row goes out in Core's column names, ISO
// times and a `text[]` of tags, so Core reads one shape from either store.
//
// Milestones are read only: Starlings builds no milestone create, edit or
// delete (MZ, 2026-10-22).

import type { CoreTaskValues, CoreTaskWriteRequest } from '@starlings/contracts/core-writes';
import type { CoreMilestone, CoreMilestonesResponse, CoreProjectTask } from '@starlings/contracts/core-reads';
import { FINISHED_TASK_STATUSES } from './contracts';
import { purgeCoreCache } from './core-cache';
import { taskCacheKeys } from './crm';
import { ControlError } from './errors';
import { recordWorkActivity } from './work-activity';
import { assertGroupWritable } from './work-freeze';

type Row = Record<string, string | number | null>;

const isoOf = (value: string | number | null | undefined): string | null =>
  typeof value === 'number' ? new Date(value).toISOString() : null;
/** Core's `date`: the UTC day of the stored midnight. */
const dayOf = (value: string | number | null | undefined): string | null =>
  typeof value === 'number' ? new Date(value).toISOString().slice(0, 10) : null;

function tagList(value: string | number | null | undefined): string[] {
  if (typeof value !== 'string' || value === '') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : [];
  } catch {
    return [];
  }
}

/** A D1 task row in Core's names: every column Core's `tasks` has. */
export function coreTaskRow(row: Row): Record<string, unknown> {
  return {
    id: row.id,
    title: row.title,
    notes: row.notes,
    status: row.status,
    responsible_party: row.responsible_party,
    priority: row.priority,
    due_date: isoOf(row.due_at),
    completed_at: isoOf(row.finished_at),
    assigned_to: row.assignee_id,
    project_id: row.project_id,
    lead_id: row.lead_id,
    organization_id: row.organization_id,
    contact_id: row.contact_id,
    signals_account_id: row.signals_account_id,
    event_id: row.event_id,
    meeting_id: row.meeting_id,
    milestone_id: row.milestone_id,
    goal_id: row.goal_id,
    github_owner: row.github_owner,
    github_repo: row.github_repo,
    github_issue_number: row.github_issue_number,
    tags: tagList(row.tags),
    updated_by: row.updated_by,
    created_at: isoOf(row.created_at),
    updated_at: isoOf(row.updated_at),
  };
}

export async function coreTaskById(env: Env, id: string): Promise<Record<string, unknown> | null> {
  const row = await env.USAGE.prepare('SELECT * FROM tasks WHERE id = ?1').bind(id).first<Row>();
  return row ? coreTaskRow(row) : null;
}

/** The oldest task that carries the tag. Core's proposals are idempotent by tag. */
export async function coreTaskByTag(env: Env, tag: string): Promise<Record<string, unknown> | null> {
  const row = await env.USAGE.prepare(
    `SELECT t.* FROM tasks t WHERE EXISTS (SELECT 1 FROM json_each(t.tags) WHERE json_each.value = ?1)
     ORDER BY t.created_at, t.id LIMIT 1`,
  ).bind(tag).first<Row>();
  return row ? coreTaskRow(row) : null;
}

/** Tasks by every filter sent, by due date with no due date last: Core's Signals lists. */
export async function coreTasks(
  env: Env,
  filter: {
    organization_id?: string | undefined;
    signals_account_ids?: string[] | undefined;
    signals_account_or_none?: string | undefined;
    statuses?: string[] | undefined;
    limit: number;
  },
): Promise<Array<Record<string, unknown>>> {
  const { results } = await env.USAGE.prepare(
    `SELECT * FROM tasks
     WHERE (?1 IS NULL OR organization_id = ?1)
       AND (?2 IS NULL OR signals_account_id IN (SELECT value FROM json_each(?2)))
       AND (?3 IS NULL OR signals_account_id IS NULL OR signals_account_id = ?3)
       AND (?4 IS NULL OR status IN (SELECT value FROM json_each(?4)))
     ORDER BY due_at IS NULL, due_at, id LIMIT ?5`,
  ).bind(
    filter.organization_id ?? null,
    filter.signals_account_ids ? JSON.stringify(filter.signals_account_ids) : null,
    filter.signals_account_or_none ?? null,
    filter.statuses ? JSON.stringify(filter.statuses) : null,
    filter.limit,
  ).all<Row>();
  return results.map(coreTaskRow);
}

function milestoneOf(row: Row): CoreMilestone {
  return {
    id: String(row.id),
    project_id: String(row.project_id),
    title: String(row.title ?? ''),
    status: String(row.status ?? 'planned'),
    notes: (row.notes as string | null) ?? null,
    due_date: dayOf(row.due_at),
    start_at: isoOf(row.start_at),
    start_time: (row.start_time as string | null) ?? null,
    timezone: (row.timezone as string | null) ?? null,
    location: (row.location as string | null) ?? null,
    place: (row.place as string | null) ?? null,
    created_at: isoOf(row.created_at) ?? '',
  };
}

/** What the public project page shows from group 2, ordered as Core's page orders it. */
export async function coreProjectWork(env: Env, projectId: string): Promise<{ milestones: CoreMilestone[]; tasks: CoreProjectTask[] }> {
  const [milestones, tasks] = await env.USAGE.batch<Row>([
    env.USAGE.prepare('SELECT * FROM milestones WHERE project_id = ?1 ORDER BY due_at IS NULL, due_at, id').bind(projectId),
    env.USAGE.prepare('SELECT * FROM tasks WHERE project_id = ?1 ORDER BY created_at DESC, id').bind(projectId),
  ]);
  return {
    milestones: (milestones?.results ?? []).map(milestoneOf),
    tasks: (tasks?.results ?? []).map((row) => ({
      id: String(row.id),
      title: String(row.title ?? ''),
      notes: (row.notes as string | null) ?? null,
      status: String(row.status ?? 'pending'),
      due_date: isoOf(row.due_at),
      completed_at: isoOf(row.finished_at),
      milestone_id: (row.milestone_id as string | null) ?? null,
      responsible_party: String(row.responsible_party ?? 'unassigned'),
      created_at: isoOf(row.created_at) ?? '',
    })),
  };
}

/** Every milestone with its project's title, by due date then start: Core's milestones.ics order. */
export async function coreMilestones(env: Env): Promise<CoreMilestonesResponse['data']> {
  const { results } = await env.USAGE.prepare(
    `SELECT m.*, p.title AS project_title FROM milestones m LEFT JOIN projects p ON p.id = m.project_id
     ORDER BY m.due_at IS NULL, m.due_at, m.start_at IS NOT NULL, m.start_at, m.id`,
  ).all<Row>();
  return results.map((row) => ({ ...milestoneOf(row), project_title: (row.project_title as string | null) ?? null }));
}

/** Core's column to D1's, and how the value is stored. */
const TASK_COLUMNS: Record<keyof CoreTaskValues, { column: string; cell: (value: unknown) => string | number | null }> = {
  title: { column: 'title', cell: (value) => String(value).trim() },
  notes: { column: 'notes', cell: (value) => (value === null ? null : String(value)) },
  status: { column: 'status', cell: String },
  responsible_party: { column: 'responsible_party', cell: String },
  priority: { column: 'priority', cell: (value) => (value === null ? null : String(value)) },
  due_date: { column: 'due_at', cell: (value) => (value === null ? null : Date.parse(String(value))) },
  assigned_to: { column: 'assignee_id', cell: (value) => (value === null ? null : String(value)) },
  project_id: { column: 'project_id', cell: (value) => (value === null ? null : String(value)) },
  lead_id: { column: 'lead_id', cell: (value) => (value === null ? null : String(value)) },
  organization_id: { column: 'organization_id', cell: (value) => (value === null ? null : String(value)) },
  contact_id: { column: 'contact_id', cell: (value) => (value === null ? null : String(value)) },
  signals_account_id: { column: 'signals_account_id', cell: (value) => (value === null ? null : String(value)) },
  milestone_id: { column: 'milestone_id', cell: (value) => (value === null ? null : String(value)) },
  // Core's `text[]` as JSON text; an empty list is null, as the group copy stores it.
  tags: { column: 'tags', cell: (value) => (Array.isArray(value) && value.length > 0 ? JSON.stringify(value) : null) },
};

const finished = (status: unknown) => (FINISHED_TASK_STATUSES as readonly unknown[]).includes(status);

/** An assignee must be a person this workspace knows by id ( seeds Core's ids). Fails closed. */
async function assertKnownPerson(env: Env, personId: string | null | undefined): Promise<void> {
  if (!personId) return;
  const row = await env.USAGE.prepare('SELECT 1 FROM people WHERE person_id = ?1').bind(personId).first();
  if (!row) throw new ControlError('That person is not on this workspace.', 400, 'invalid_request');
}

/**
 * One task write from Core, into D1. The answer is Core's: the row with the
 * `select` columns, null for an update or delete that matched no row.
 */
export async function writeCoreTask(env: Env, actor: string, write: CoreTaskWriteRequest): Promise<Record<string, unknown> | null> {
  await assertGroupWritable(env, 'tasks');
  if (write.action === 'delete') {
    const row = await env.USAGE.prepare('SELECT * FROM tasks WHERE id = ?1').bind(write.id).first<Row>();
    if (!row) return null;
    await env.USAGE.prepare('DELETE FROM tasks WHERE id = ?1').bind(write.id).run();
    await purgeCoreCache(taskCacheKeys(row as Parameters<typeof taskCacheKeys>[0]));
    await recordWorkActivity(env, { actor, table: 'tasks', id: write.id, action: 'delete', label: String(row.title ?? '') });
    return { id: write.id };
  }
  const values = write.values;
  await assertKnownPerson(env, values.assigned_to);
  const now = Date.now();
  const entries = (Object.keys(values) as (keyof CoreTaskValues)[])
    .filter((key) => values[key] !== undefined)
    .map((key) => [TASK_COLUMNS[key].column, TASK_COLUMNS[key].cell(values[key])] as const);
  let id: string;
  if (write.action === 'create') {
    if (!values.project_id && !values.lead_id && !values.organization_id && !values.signals_account_id) {
      throw new ControlError('A task needs a project, a lead, an organization or a Signals account.', 400, 'invalid_request');
    }
    id = crypto.randomUUID();
    const status = values.status ?? 'pending';
    const cells: Record<string, string | number | null> = {
      status, responsible_party: 'unassigned', ...Object.fromEntries(entries),
      id, created_at: now, updated_at: now, finished_at: finished(status) ? now : null,
    };
    const columns = Object.keys(cells);
    await env.USAGE.prepare(`INSERT INTO tasks (${columns.join(', ')}) VALUES (${columns.map((_, index) => `?${index + 1}`).join(', ')})`)
      .bind(...columns.map((column) => cells[column] ?? null)).run();
  } else {
    id = write.id;
    const current = await env.USAGE.prepare('SELECT status FROM tasks WHERE id = ?1').bind(id).first<{ status: string }>();
    if (!current) return null;
    const cells: Record<string, string | number | null> = { ...Object.fromEntries(entries), updated_at: now };
    if (values.status !== undefined) {
      if (finished(values.status) && !finished(current.status)) cells.finished_at = now;
      if (!finished(values.status)) cells.finished_at = null;
    }
    const columns = Object.keys(cells);
    await env.USAGE.prepare(`UPDATE tasks SET ${columns.map((column, index) => `${column} = ?${index + 2}`).join(', ')} WHERE id = ?1`)
      .bind(id, ...columns.map((column) => cells[column] ?? null)).run();
  }
  const row = await env.USAGE.prepare('SELECT * FROM tasks WHERE id = ?1').bind(id).first<Row>();
  if (!row) throw new ControlError('The task was not saved.', 500);
  await purgeCoreCache(taskCacheKeys(row as Parameters<typeof taskCacheKeys>[0]));
  await recordWorkActivity(env, {
    actor, table: 'tasks', id, action: write.action === 'create' ? 'insert' : 'update', label: String(row.title ?? ''),
    fields: Object.keys(values).sort(),
  });
  const task = coreTaskRow(row);
  const columns = (write.select ?? 'id').split(',').map((column) => column.trim());
  return Object.fromEntries(columns.map((column) => [column, task[column] ?? null]));
}
