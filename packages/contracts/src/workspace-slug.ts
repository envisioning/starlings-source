/**
 * Workspace slugs and their hosts (ADR 0004 decisions 3, 4 and 5). One list
 * and one rule for every surface that reads a slug: the product site's sign
 * in, and later the dispatch Worker, provisioning and sign-up.
 */

import { WORKSPACE_HOST_SUFFIX } from './deployment-values.ts';

/** Every workspace answers at `<slug>.<suffix>` (ADR 0004 decision 3). */
export { WORKSPACE_HOST_SUFFIX };

/** Names no firm can take (ADR 0004 decision 5). */
export const RESERVED_WORKSPACE_SLUGS: ReadonlySet<string> = new Set([
  'www', 'app', 'api', 'auth', 'admin', 'mcp', 'mail', 'in', 'custom', 'status', 'help', 'docs', 'cdn',
  'assets', 'static', 'dev', 'staging', 'test', 'billing', 'support', 'starlings', 'starlingshq',
  // A workspace's Worker is `starlings-<slug>`; `site` would be the product site's.
  'site',
  'keep',
]);

/**
 * The services a workspace may run beside itself. Each answers
 * at `<service>-<slug>.<suffix>` and signs in through the auth host
 * as that workspace (docs/CENTRAL_AUTH.md "Services").
 */
export const WORKSPACE_SERVICES = ['docs', 'keep'] as const;
export type WorkspaceService = (typeof WORKSPACE_SERVICES)[number];

/**
 * Prefixes no firm can take: a workspace's own Docs and Keep answer at
 * `docs-<slug>.<suffix>` and `keep-<slug>.<suffix>`.
 * A firm with the slug `keep-acme` would hold Acme's Keep host.
 */
export const RESERVED_WORKSPACE_SLUG_PREFIXES: readonly string[] = WORKSPACE_SERVICES.map((service) => `${service}-`);

/**
 * Workspaces the platform runs itself, outside the slug rules: `hq`, the
 * experiment workspace after Envisioning (MZ, 2026-10-03;). Two
 * characters, so the rules keep every firm off it.
 */
export const PLATFORM_WORKSPACE_SLUGS: ReadonlySet<string> = new Set(['hq']);

export type WorkspaceSlugResult =
  | { ok: true; slug: string }
  | { ok: false; reason: 'empty' | 'shape' | 'reserved' };

/**
 * ADR 0004 decision 4: `a-z0-9-`, 3 to 63 characters, no leading or trailing
 * hyphen, and no `--` in positions 3 and 4, which keeps out `xn--` look-alikes.
 * Compared lowercase. A platform slug passes as it is.
 */
export function checkWorkspaceSlug(value: string): WorkspaceSlugResult {
  const slug = value.trim().toLowerCase();
  if (!slug) return { ok: false, reason: 'empty' };
  if (PLATFORM_WORKSPACE_SLUGS.has(slug)) return { ok: true, slug };
  if (!/^[a-z0-9](?:[a-z0-9-]{1,61})[a-z0-9]$/.test(slug) || slug.slice(2, 4) === '--') return { ok: false, reason: 'shape' };
  if (RESERVED_WORKSPACE_SLUGS.has(slug)) return { ok: false, reason: 'reserved' };
  if (RESERVED_WORKSPACE_SLUG_PREFIXES.some((prefix) => slug.startsWith(prefix))) return { ok: false, reason: 'reserved' };
  return { ok: true, slug };
}

/**
 * What a person types to name their workspace: `<slug>`, `<slug>.<suffix>`,
 * or a pasted `https://<slug>.<suffix>/…`. Anything on another host is
 * refused as a shape error; custom domains are not resolved here.
 */
export function parseWorkspaceAddress(input: string): WorkspaceSlugResult {
  let value = input.trim().toLowerCase();
  if (!value) return { ok: false, reason: 'empty' };
  value = value.replace(/^https?:\/\//, '').replace(/[/?#].*$/, '');
  const suffix = `.${WORKSPACE_HOST_SUFFIX}`;
  if (value.endsWith(suffix)) value = value.slice(0, -suffix.length);
  if (value.includes('.')) return { ok: false, reason: 'shape' };
  return checkWorkspaceSlug(value);
}

/** The workspace's own address. Web sign-in starts there and passes through the auth host (docs/CENTRAL_AUTH.md). */
export function workspaceOrigin(slug: string): string {
  return `https://${slug}.${WORKSPACE_HOST_SUFFIX}`;
}

/** A workspace service's own address: `https://<service>-<slug>.<suffix>`. */
export function serviceOrigin(service: WorkspaceService, slug: string): string {
  return `https://${service}-${slug}.${WORKSPACE_HOST_SUFFIX}`;
}

/**
 * Where the product site's sign-in sends a person: the workspace's own Google
 * sign-in, which returns to the workspace's Home. The workspace root is the
 * visitor door, so sending a person there made them sign in twice. The auth
 * host replaces this with.
 */
export function workspaceSignInURL(slug: string, returnTo = '/'): string {
  return workspaceOriginSignInURL(workspaceOrigin(slug), returnTo);
}

/** The same sign-in on any workspace origin, the web's Add a workspace included. */
export function workspaceOriginSignInURL(origin: string, returnTo = '/'): string {
  return `${origin}/api/auth/google/start?return_to=${encodeURIComponent(returnTo)}`;
}

/**
 * True for exactly `https://<slug>.<suffix>`, with a slug the rules
 * accept, lowercase, no port, no path. The auth Worker sends a browser back
 * only to an origin that passes this or one it lists by name.
 */
export function isWorkspaceHostOrigin(value: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== 'https:' || url.port !== '' || url.origin !== value) return false;
  const suffix = `.${WORKSPACE_HOST_SUFFIX}`;
  if (!url.hostname.endsWith(suffix)) return false;
  const slug = url.hostname.slice(0, -suffix.length);
  if (slug.includes('.')) return false;
  const checked = checkWorkspaceSlug(slug);
  return checked.ok && checked.slug === slug;
}

/** The host label of an exact `https://<label>.<suffix>` origin: lowercase, no port, no path. Null otherwise. */
function hostLabel(value: string): string | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.port !== '' || url.origin !== value) return null;
  const suffix = `.${WORKSPACE_HOST_SUFFIX}`;
  if (!url.hostname.endsWith(suffix)) return null;
  const label = url.hostname.slice(0, -suffix.length);
  return label.includes('.') ? null : label;
}

/** The slug of an origin that passes `isWorkspaceHostOrigin`, or null. */
export function workspaceSlugOfOrigin(value: string): string | null {
  return isWorkspaceHostOrigin(value) ? hostLabel(value) : null;
}

/**
 * True for exactly `https://<service>-<slug>.<suffix>`: a service in
 * WORKSPACE_SERVICES and a slug the rules accept. The auth Worker returns a
 * browser to one only when the caller's binding names that service and
 * workspace (docs/CENTRAL_AUTH.md "Services").
 */
export function isServiceHostOrigin(value: string): boolean {
  const label = hostLabel(value);
  if (!label) return false;
  return WORKSPACE_SERVICES.some((service) => {
    if (!label.startsWith(`${service}-`)) return false;
    const slug = label.slice(service.length + 1);
    const checked = checkWorkspaceSlug(slug);
    return checked.ok && checked.slug === slug;
  });
}
