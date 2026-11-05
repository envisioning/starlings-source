// The workspace's plan (BUSINESS (HQ Docs)).
//
// One `workspace_settings` row, key `plan`. No row is Pro
// (`DEFAULT_WORKSPACE_PLAN`), so a workspace that never had a plan set loses
// nothing. A root admin sets the plan until billing does.
//
// Two rules read it:
// - Project create, in `createCrmSubject`: Free holds one project, ever. The
//   D1 insert counts and inserts in one statement, so two creates at once
//   cannot both pass.
// - Subject writes, in `subject-access.ts`: on Free, every project but the
//   kept one is read-only (`isProjectFrozen`).
//
// The plan never grants authority. Both rules run after the role and subject
// access checks, and only ever take a write away.
//
// Fail closed: a stored value nobody can read is a 503, never "no limit".

import {
  DEFAULT_WORKSPACE_PLAN,
  PLAN_ERROR_CODES,
  PLAN_WORDS,
  isWorkspacePlanId,
  workspacePlanSpec,
  type WorkspacePlanFacts,
  type WorkspacePlanId,
} from '@starlings/contracts/workspace-plans';
import type { WorkspacePlanResponse } from '@starlings/contracts/workspace-plan';
import { type OwnerSession } from './contracts';
import { isRootAdminEmail } from './workspace-identity';
import { recordAdminAction } from './admin-audit';
import { ControlError } from './errors';
import { usesCore } from './work-store';

const KEY = 'plan';

interface StoredPlan extends WorkspacePlanFacts {
  kept_project_picked: boolean;
}

const DEFAULT_STORED: StoredPlan = { plan: DEFAULT_WORKSPACE_PLAN, kept_project_id: null, kept_project_picked: false };

/** The SQL that reads the row; `subject-access.ts` puts it in its own batch. */
export const PLAN_SETTING_SQL = 'SELECT value, updated_at FROM workspace_settings WHERE key = ?1';
export const PLAN_SETTING_KEY = KEY;

function unreadable(): ControlError {
  return new ControlError('The workspace plan could not be read.', 503);
}

/** The stored row as facts. No row is the default; a row nobody can read throws. */
export function parsePlanRow(row: { value: string } | null | undefined): StoredPlan {
  if (!row) return DEFAULT_STORED;
  let value: unknown;
  try {
    value = JSON.parse(row.value);
  } catch {
    throw unreadable();
  }
  const record = value as Partial<StoredPlan> | null;
  if (!record || !isWorkspacePlanId(record.plan)) throw unreadable();
  const kept = typeof record.kept_project_id === 'string' && record.kept_project_id ? record.kept_project_id : null;
  return { plan: record.plan, kept_project_id: kept, kept_project_picked: kept !== null && record.kept_project_picked === true };
}

async function readStored(env: Env): Promise<{ stored: StoredPlan; updatedAt: number | null }> {
  const row = await env.USAGE.prepare(PLAN_SETTING_SQL).bind(KEY).first<{ value: string; updated_at: number }>();
  return { stored: parsePlanRow(row), updatedAt: row?.updated_at ?? null };
}

function response(stored: StoredPlan, updatedAt: number | null): WorkspacePlanResponse {
  return {
    plan: stored.plan,
    project_limit: workspacePlanSpec(stored.plan).projectLimit,
    kept_project_id: stored.kept_project_id,
    kept_project_picked: stored.kept_project_picked,
    updated_at: updatedAt,
  };
}

/** `GET /api/workspace/plan`. */
export async function readWorkspacePlan(env: Env): Promise<WorkspacePlanResponse> {
  const { stored, updatedAt } = await readStored(env);
  return response(stored, updatedAt);
}

/** The project limit for a create, or null for none. `createCrmSubject` passes it to the insert. */
export async function projectLimitForCreate(env: Env): Promise<number | null> {
  const { stored } = await readStored(env);
  const limit = workspacePlanSpec(stored.plan).projectLimit;
  // Core counts its own projects; Meet cannot hold its insert to a count.
  // `writeWorkspacePlan` refuses a limit there, so this only fires on a
  // row written by hand. Refuse rather than let the create through.
  if (limit !== null && usesCore(env)) throw new ControlError(PLAN_WORDS.projectLimit, 403, PLAN_ERROR_CODES.projectLimit);
  return limit;
}

/** What the create throws when the plan's project limit is reached. */
export function projectLimitError(): ControlError {
  return new ControlError(PLAN_WORDS.projectLimit, 403, PLAN_ERROR_CODES.projectLimit);
}

/** What a write on a frozen project throws. */
export function projectFrozenError(): ControlError {
  return new ControlError(PLAN_WORDS.projectFrozen, 403, PLAN_ERROR_CODES.projectFrozen);
}

/** The most recently updated project, and whether there is more than one to choose from. */
async function defaultKeptProject(env: Env): Promise<{ id: string | null; choice: boolean }> {
  const row = await env.USAGE.prepare(
    `SELECT id, (SELECT COUNT(*) FROM projects) AS total FROM projects ORDER BY updated_at DESC, id LIMIT 1`,
  ).first<{ id: string; total: number }>();
  return { id: row?.id ?? null, choice: (row?.total ?? 0) > 1 };
}

async function projectExists(env: Env, id: string): Promise<boolean> {
  return (await env.USAGE.prepare('SELECT 1 AS found FROM projects WHERE id = ?1').bind(id).first<{ found: number }>()) !== null;
}

async function save(env: Env, actor: OwnerSession, stored: StoredPlan): Promise<number> {
  const now = Date.now();
  await env.USAGE.prepare(
    `INSERT INTO workspace_settings (key, value, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).bind(KEY, JSON.stringify(stored), actor.sub, now).run();
  return now;
}

/**
 * `PUT /api/admin/plan`: root admins only, until billing sets the plan. A
 * move to a plan with a project limit keeps the admin's earlier pick when
 * that project still exists, and otherwise keeps the most recently updated
 * project writable until an admin picks.
 */
export async function writeWorkspacePlan(env: Env, actor: OwnerSession, plan: WorkspacePlanId): Promise<WorkspacePlanResponse> {
  if (!isRootAdminEmail(env, actor.email)) {
    throw new ControlError('Only an Envisioning root admin can change the plan.', 403, 'not_org_admin');
  }
  const limit = workspacePlanSpec(plan).projectLimit;
  if (limit !== null && usesCore(env)) {
    throw new ControlError('A workspace on Core cannot be on a plan with a project limit.', 409, 'plan_not_supported');
  }
  const { stored: before } = await readStored(env);
  let next: StoredPlan = { plan, kept_project_id: null, kept_project_picked: false };
  if (limit !== null) {
    const keepPick = before.kept_project_picked && before.kept_project_id !== null && await projectExists(env, before.kept_project_id);
    if (keepPick) {
      next = { plan, kept_project_id: before.kept_project_id, kept_project_picked: true };
    } else {
      // With one project or none there is nothing to pick, so the pick is settled.
      const kept = await defaultKeptProject(env);
      next = { plan, kept_project_id: kept.id, kept_project_picked: kept.id !== null && !kept.choice };
    }
  } else if (before.kept_project_picked) {
    // An upgrade freezes nothing, but a later downgrade keeps the final pick.
    next = { plan, kept_project_id: before.kept_project_id, kept_project_picked: true };
  }
  const now = await save(env, actor, next);
  await recordAdminAction(env, actor, 'workspace.plan', null, `${before.plan} → ${plan}`);
  return response(next, now);
}

/** `PUT /api/admin/plan/kept-project`: an admin picks the one writable project on Free. Once. */
export async function writeKeptProject(env: Env, actor: OwnerSession, projectId: string): Promise<WorkspacePlanResponse> {
  const { stored } = await readStored(env);
  if (workspacePlanSpec(stored.plan).projectLimit === null) {
    throw new ControlError('Every project is writable on this plan.', 409, 'invalid_request');
  }
  if (stored.kept_project_picked) {
    throw new ControlError('The writable project was already picked.', 409, 'plan_kept_project_final');
  }
  if (!(await projectExists(env, projectId))) {
    throw new ControlError('No such subject.', 404, 'subject_not_found');
  }
  const next: StoredPlan = { plan: stored.plan, kept_project_id: projectId, kept_project_picked: true };
  const now = await save(env, actor, next);
  await recordAdminAction(env, actor, 'workspace.plan.kept_project', projectId, null);
  return response(next, now);
}
