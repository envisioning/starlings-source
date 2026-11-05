import { parseWorkspaceAddress } from '@starlings/contracts/workspace-slug';
import { AuthError } from './errors';

/** Explicit rollout aliases only. A subdomain is never proof of tenant membership. */
export function isWorkspaceOrigin(origin: string | null, env: Env): origin is string {
  if (!origin) return false;
  return origin === env.WEB_ORIGIN || workspaceAliases(env).includes(origin);
}
export function workspaceAliases(env: Env): string[] {
  return (env.WORKSPACE_ORIGIN_ALIASES ?? '').split(',').map(value => value.trim()).filter(value => {
    try { const url = new URL(value); return url.protocol === 'https:' && url.origin === value; } catch { return false; }
  });
}
/**
 * The address people see for this workspace's own pages: the first rollout
 * alias (`the built-in workspace's host`), else `WEB_ORIGIN`. An event's sign-up
 * page link and its link preview use it.
 */
export function workspaceSiteOrigin(env: Env): string {
  return workspaceAliases(env)[0] ?? new URL(env.WEB_ORIGIN).origin;
}
export function workspaceOAuthOrigins(request: Request, env: Env): { webOrigin: string; callbackOrigin: string } {
  const origin = new URL(request.url).origin;
  return workspaceAliases(env).includes(origin)
    ? { webOrigin: origin, callbackOrigin: origin }
    : { webOrigin: env.WEB_ORIGIN, callbackOrigin: env.PUBLIC_API_ORIGIN };
}
/** Signed state binds consent to the host that started it. Old in-flight state remains valid. */
export function restoreWorkspaceOAuthOrigins(request: Request, env: Env, state: { webOrigin?: unknown; callbackOrigin?: unknown }) {
  if (state.webOrigin === undefined && state.callbackOrigin === undefined) return { webOrigin: env.WEB_ORIGIN, callbackOrigin: env.PUBLIC_API_ORIGIN };
  const expected = workspaceOAuthOrigins(request, env);
  if (state.webOrigin !== expected.webOrigin || state.callbackOrigin !== expected.callbackOrigin) throw new AuthError('OAuth origin did not match.', 400, 'oauth_failed');
  return expected;
}
/**
 * The origin this workspace's room, booking and meeting links name
 * (`PUBLIC_WEB_ORIGIN`, else `WEB_ORIGIN`). Never a compiled default: a link
 * built here always names this workspace's host.
 */
export function workspacePublicOrigin(env: Pick<Env, 'PUBLIC_WEB_ORIGIN' | 'WEB_ORIGIN'>): string {
  for (const value of [env.PUBLIC_WEB_ORIGIN, env.WEB_ORIGIN]) {
    try { if (value?.trim()) return new URL(value.trim()).origin; } catch { /* the next one */ }
  }
  throw new Error('PUBLIC_WEB_ORIGIN is not configured.');
}

/** The origins a workspace answers on. Typed as plain strings, so any workspace's values fit. */
export interface WorkspaceOrigins {
  WEB_ORIGIN: string;
  WORKSPACE_ORIGIN_ALIASES?: string | undefined;
}

/**
 * The workspace's slug: the first of its own origins that is
 * `https://<slug>.<suffix>`. Envisioning and `hq` have it as their web
 * origin. Null when no origin is on the workspace domain.
 */
export function workspaceSlug(env: WorkspaceOrigins): string | null {
  const origins = [env.WEB_ORIGIN, ...(env.WORKSPACE_ORIGIN_ALIASES ?? '').split(',')];
  for (const origin of origins) {
    const value = origin?.trim() ?? '';
    if (!value.startsWith('https://')) continue;
    const parsed = parseWorkspaceAddress(value);
    if (parsed.ok) return parsed.slug;
  }
  return null;
}
