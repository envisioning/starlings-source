// What Home is made of, per person — the order of its modules and which of
// them show (`fixtures/home-layout.json`). Stored resolved, read resolved:
// the contract's RESOLVE rule runs on every read so a module that shipped
// after the row was written still lands in its default place, and an id an
// older Worker never knew is dropped rather than drawn blank.

import {
  resolveHomeLayout,
  type HomeModuleSetting,
  type HomePreferencesResponse,
} from '@starlings/contracts/home-layout';

interface Row {
  modules: string;
  updated_at: number;
}

function parseStored(raw: string): Array<{ id: string; enabled: boolean }> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => (
      entry && typeof entry === 'object'
        && typeof (entry as { id?: unknown }).id === 'string'
        && typeof (entry as { enabled?: unknown }).enabled === 'boolean'
        ? [{ id: (entry as { id: string }).id, enabled: (entry as { enabled: boolean }).enabled }]
        : []
    ));
  } catch {
    // A row nobody can read is the default, not a 500 on Home.
    return [];
  }
}

export async function readHomePreferences(env: Env, sub: string): Promise<HomePreferencesResponse> {
  const row = await env.USAGE.prepare('SELECT modules, updated_at FROM home_preferences WHERE sub = ?1')
    .bind(sub)
    .first<Row>();
  return {
    modules: resolveHomeLayout(row ? parseStored(row.modules) : null),
    updated_at: row?.updated_at ?? null,
  };
}

export async function writeHomePreferences(
  env: Env,
  sub: string,
  modules: ReadonlyArray<{ id: string; enabled: boolean }>,
): Promise<HomePreferencesResponse> {
  const resolved: HomeModuleSetting[] = resolveHomeLayout(modules);
  const now = Date.now();
  await env.USAGE.prepare(
    `INSERT INTO home_preferences (sub, modules, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT (sub) DO UPDATE SET modules = excluded.modules, updated_at = excluded.updated_at`,
  ).bind(sub, JSON.stringify(resolved), now).run();
  return { modules: resolved, updated_at: now };
}
