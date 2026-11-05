import { workspaceDefaultsSchema, type WorkspaceDefaults, type WorkspaceDefaultsAdminResponse } from '@starlings/contracts/workspace-defaults';
import { BOOKING_SETTINGS_DEFAULTS } from '@starlings/contracts/booking-settings';
import { CONTACT_EMAIL } from '@starlings/contracts/deployment';
import { recordAdminAction } from './admin-audit';
import type { OwnerSession } from './contracts';
import { ControlError } from './errors';
import { coreApiOrigin, usesCore } from './work-store';
import { workspaceDisplayName } from './workspace-profile';
import { workspaceAliases } from './workspace-origins';

type Stored = { defaults: WorkspaceDefaults; updatedAt: number };
// Key by D1 binding: tests and fleet tools may read more than one workspace in one isolate.
let cache = new WeakMap<D1Database, { value: Stored | null; at: number }>();
export function resetWorkspaceDefaultsCache(): void { cache = new WeakMap(); }

async function storedDefaults(env: Pick<Env, 'USAGE'>): Promise<Stored | null> {
  const cached = cache.get(env.USAGE);
  if (cached && Date.now() - cached.at < 30_000) return cached.value;
  let value: Stored | null = null;
  try {
    const row = await env.USAGE.prepare('SELECT value, updated_at FROM workspace_settings WHERE key = ?1')
      .bind('defaults').first<{ value: string; updated_at: number }>();
    const parsed = row ? workspaceDefaultsSchema.safeParse(JSON.parse(row.value)) : null;
    if (row && parsed?.success && (!parsed.data.public_events_feed || isPublicFeedUrl(parsed.data.public_events_feed))) {
      value = { defaults: parsed.data, updatedAt: row.updated_at };
    }
  } catch { /* A missing/unreadable row keeps the existing defaults. */ }
  cache.set(env.USAGE, { value, at: Date.now() });
  return value;
}

/** No credentials, private/literal addresses, or local development hosts in a configured public feed. */
export function isPublicFeedUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash
      && (!url.port || url.port === '443')
      && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/iu.test(url.hostname)
      && url.hostname.includes('.') && !/^[\d.]+$/u.test(url.hostname)
      && !/(?:^|\.)(?:localhost|local|internal|invalid|test)$/iu.test(url.hostname);
  } catch { return false; }
}

export async function readWorkspaceDefaults(env: Env): Promise<WorkspaceDefaultsAdminResponse> {
  const [stored, name] = await Promise.all([storedDefaults(env), workspaceDisplayName(env)]);
  const defaults = stored?.defaults ?? workspaceDefaultsSchema.parse({});
  return {
    defaults: {
      ...defaults,
      project_group_name: defaults.project_group_name ?? name,
      booking_slot_minutes: defaults.booking_slot_minutes ?? (usesCore(env) ? 60 : BOOKING_SETTINGS_DEFAULTS.slot_step_minutes),
      // Only the legacy Core workspace inherits its public CMS. A saved null switches it off.
      public_events_feed: stored ? defaults.public_events_feed : usesCore(env) ? `${coreApiOrigin(env)}/api/public/meet-events` : null,
    },
    source: stored ? 'settings' : 'default', updated_at: stored?.updatedAt ?? null,
  };
}

export async function workspaceDefaults(env: Env): Promise<WorkspaceDefaults> {
  return (await readWorkspaceDefaults(env)).defaults;
}

/** Auth's mail sender shares this helper, but does not have workspace vars. */
export async function workspaceMailContact(env: Pick<Env, 'USAGE'>): Promise<string> {
  return (await storedDefaults(env))?.defaults.contact_email ?? CONTACT_EMAIL;
}

export async function workspaceBookingSlotMinutes(env: Env, fallback: number): Promise<number> {
  return (await storedDefaults(env))?.defaults.booking_slot_minutes ?? fallback;
}

export async function writeWorkspaceDefaults(env: Env, actor: OwnerSession, input: WorkspaceDefaults): Promise<WorkspaceDefaultsAdminResponse> {
  const defaults = workspaceDefaultsSchema.parse(input);
  if (defaults.public_events_feed && !isPublicFeedUrl(defaults.public_events_feed)) {
    throw new ControlError('Use a public HTTPS events feed without credentials.', 400, 'invalid_request');
  }
  if (defaults.public_events_feed) {
    const feed = new URL(defaults.public_events_feed);
    const origins = [env.WEB_ORIGIN, env.PUBLIC_WEB_ORIGIN, env.PUBLIC_API_ORIGIN, ...workspaceAliases(env)].filter(Boolean);
    const ownOrigin = origins.some(value => { try { return new URL(value).origin === feed.origin; } catch { return false; } });
    if (ownOrigin && /^\/api\/public\/events\/?$/u.test(feed.pathname)) {
      throw new ControlError('The events feed cannot point to itself.', 400, 'invalid_request');
    }
  }
  const now = Date.now();
  await env.USAGE.prepare(`INSERT INTO workspace_settings (key, value, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .bind('defaults', JSON.stringify(defaults), actor.sub, now).run();
  cache.set(env.USAGE, { value: { defaults, updatedAt: now }, at: now });
  await recordAdminAction(env, actor, 'workspace.defaults', null, 'Updated workspace defaults');
  return readWorkspaceDefaults(env);
}
