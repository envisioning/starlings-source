// Which work modules this workspace has on (docs/WORK_MODEL.md).
// The table is packages/contracts/src/work-modules.ts; the choice is the
// workspace's, saved in `workspace_settings` as `work_modules` by an admin.
// What is in force is always limited to what this workspace's store serves.

import { WORK_MODULES, workModuleAvailable, workModuleForSubjectKind, workModulesAvailableOn, type WorkModule } from '@starlings/contracts/work-modules';
import type { SubjectKind } from '@starlings/contracts/subject-kinds';
import {
  workModulesUpdateSchema,
  type WorkModulesAdminResponse,
  type WorkModulesUpdate,
} from '@starlings/contracts/work-modules-setting';
import { recordAdminAction } from './admin-audit';
import type { OwnerSession } from './contracts';
import { ControlError } from './errors';
import { workStore } from './work-store';

const KEY = 'work_modules';

function parseStored(raw: string): WorkModulesUpdate | null {
  try {
    const parsed = workModulesUpdateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Before an admin saves: a Core workspace, which is Envisioning, has every
 * work module Core serves; a D1 workspace has the base only (MZ, 2026-10-05).
 */
function defaultOn(env: Pick<Env, 'WORK_STORE'>): WorkModule[] {
  return workStore(env) === 'core' ? workModulesAvailableOn('core') : [];
}

async function readSetting(env: Env): Promise<{ on: WorkModule[]; updatedAt: number | null }> {
  const row = await env.USAGE.prepare('SELECT value, updated_at FROM workspace_settings WHERE key = ?1')
    .bind(KEY)
    .first<{ value: string; updated_at: number }>();
  const saved = row ? parseStored(row.value) : null;
  // A row nobody can read is the default, never every work module.
  return { on: saved?.on ?? defaultOn(env), updatedAt: saved ? row!.updated_at : null };
}

/** The work modules in force: the choice, limited to what this store serves, in the table's order. */
export async function workModulesOn(env: Env): Promise<WorkModule[]> {
  const store = workStore(env);
  const { on } = await readSetting(env);
  return WORK_MODULES.filter((module) => on.includes(module) && workModuleAvailable(module, store));
}

/** True when `module` is on for this workspace. */
export async function workModuleOn(env: Env, module: WorkModule): Promise<boolean> {
  return (await workModulesOn(env)).includes(module);
}

export async function readWorkModulesSetting(env: Env): Promise<WorkModulesAdminResponse> {
  const store = workStore(env);
  const { updatedAt } = await readSetting(env);
  return { store, on: await workModulesOn(env), available: workModulesAvailableOn(store), updated_at: updatedAt };
}

export async function writeWorkModules(env: Env, actor: OwnerSession, update: WorkModulesUpdate): Promise<WorkModulesAdminResponse> {
  const store = workStore(env);
  const unavailable = update.on.filter((module) => !workModuleAvailable(module, store));
  if (unavailable.length > 0) {
    throw new ControlError(`This workspace can’t use ${unavailable.join(', ')} yet.`, 409, 'invalid_request');
  }
  const on = WORK_MODULES.filter((module) => update.on.includes(module));
  await env.USAGE.prepare(
    `INSERT INTO workspace_settings (key, value, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).bind(KEY, JSON.stringify({ on }), actor.sub, Date.now()).run();
  await recordAdminAction(env, actor, 'workspace.work_modules', null, on.length > 0 ? on.join(', ') : 'base only');
  return readWorkModulesSetting(env);
}

/** True when this workspace shows subjects of `kind`: a base kind always, a gated one when its work module is on. */
export async function subjectKindOn(env: Env, kind: SubjectKind): Promise<boolean> {
  return (await subjectKindFilter(env))(kind);
}

/**
 * The same answer for many rows: the work modules are read once, and the
 * filter is a plain function a reader applies to every subject, task or
 * decision it builds (search, INBOX, the feed, MCP;).
 */
export async function subjectKindFilter(env: Env): Promise<(kind: SubjectKind) => boolean> {
  const on = await workModulesOn(env);
  return (kind) => {
    const module = workModuleForSubjectKind(kind);
    return module === null || on.includes(module);
  };
}

/**
 * Refuses a subject of a kind whose work module is off, as not found: the
 * workspace does not have it (docs/WORK_MODEL.md rule 2). Its records stay.
 */
export async function requireSubjectKindOn(env: Env, kind: SubjectKind): Promise<void> {
  if (!(await subjectKindOn(env, kind))) {
    throw new ControlError('This workspace doesn’t use that kind of subject.', 404, 'subject_not_found');
  }
}
