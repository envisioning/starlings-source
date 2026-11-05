// Where the workspace's mail and calendar live: `google`, `microsoft` or
// `other`. One reader for the descriptor (`/.well-known/meet`), every page's
// `<head>` and Admin. The shape and its meaning are in
// `@starlings/contracts/workspace-profile`.
//
// Where the value comes from, first answer wins, as for the brand
// (workspace-profile.ts):
//   1. what an admin saved in Admin › People (`workspace_settings`, key `suite`);
//   2. the Worker's `WORKSPACE_SUITE` var, the answer signup gave, which
//      `scripts/provision-workspace.mjs` writes;
//   3. `google`.

import {
  DEFAULT_WORKSPACE_SUITE,
  parseWorkspaceSuite,
  type WorkspaceSuite,
  type WorkspaceSuiteAdminResponse,
  type WorkspaceSuiteUpdate,
} from '@starlings/contracts/workspace-profile';
import { recordAdminAction } from './admin-audit';
import type { OwnerSession } from './contracts';

const KEY = 'suite';

type Stored = { suite: WorkspaceSuite; updatedAt: number } | null;

/** The saved row, read at most every 30 seconds per isolate; a write here refreshes it at once. */
let storedCache: { value: Stored; at: number } | null = null;
const STORED_TTL_MS = 30_000;

async function storedSuite(env: Pick<Env, 'USAGE' | 'WORKSPACE_SUITE'>): Promise<Stored> {
  if (storedCache && Date.now() - storedCache.at < STORED_TTL_MS) return storedCache.value;
  let value: Stored = null;
  try {
    const row = await env.USAGE.prepare('SELECT value, updated_at FROM workspace_settings WHERE key = ?1')
      .bind(KEY)
      .first<{ value: string; updated_at: number }>();
    const suite = row ? parseWorkspaceSuite(JSON.parse(row.value)?.suite) : null;
    // A row nobody can read answers as if it were not there.
    value = row && suite ? { suite, updatedAt: row.updated_at } : null;
  } catch {
    value = null;
  }
  storedCache = { value, at: Date.now() };
  return value;
}

/** Forget the cached row; tests use it between cases. */
export function resetWorkspaceSuiteCache(): void {
  storedCache = null;
}

function configuredSuite(env: Pick<Env, 'WORKSPACE_SUITE'>): WorkspaceSuite | null {
  return parseWorkspaceSuite(env.WORKSPACE_SUITE);
}

/** `GET /api/admin/workspace/suite`: the suite in force and where it comes from. */
export async function readWorkspaceSuite(env: Pick<Env, 'USAGE' | 'WORKSPACE_SUITE'>): Promise<WorkspaceSuiteAdminResponse> {
  const stored = await storedSuite(env);
  if (stored) return { suite: stored.suite, source: 'settings', updated_at: stored.updatedAt };
  const configured = configuredSuite(env);
  if (configured) return { suite: configured, source: 'deployment', updated_at: null };
  return { suite: DEFAULT_WORKSPACE_SUITE, source: 'default', updated_at: null };
}

/** The suite in force. */
export async function workspaceSuite(env: Pick<Env, 'USAGE' | 'WORKSPACE_SUITE'>): Promise<WorkspaceSuite> {
  return (await readWorkspaceSuite(env)).suite;
}

/** `PUT /api/admin/workspace/suite`. */
export async function writeWorkspaceSuite(env: Env, actor: OwnerSession, update: WorkspaceSuiteUpdate): Promise<WorkspaceSuiteAdminResponse> {
  const now = Date.now();
  await env.USAGE.prepare(
    `INSERT INTO workspace_settings (key, value, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).bind(KEY, JSON.stringify({ suite: update.suite }), actor.sub, now).run();
  storedCache = { value: { suite: update.suite, updatedAt: now }, at: Date.now() };
  await recordAdminAction(env, actor, 'workspace.suite', null, update.suite);
  return readWorkspaceSuite(env);
}
