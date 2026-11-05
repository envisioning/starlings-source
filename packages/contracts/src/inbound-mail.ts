/**
 * The fixed mail addresses every workspace takes on its own host,
 * `<local>@<slug>.<suffix>`. One list: the Worker accepts
 * these, `scripts/ensure-mail-routing.mjs` routes these, the docs name these.
 *
 * A fixed address is a literal Email Routing rule on the workspace's mail
 * subdomain, aimed at the workspace's own Worker. Cloudflare gives a
 * subdomain no catch-all, so channel addresses, minted per subject, stay on
 * the apex as `<slug>.<local>@<suffix>`. Zod-free: the routing script
 * and the browser read it.
 */
import { WORKSPACE_HOST_SUFFIX } from './workspace-slug';

export const WORKSPACE_FIXED_ADDRESSES = ['calendar'] as const;
export type WorkspaceFixedAddress = (typeof WORKSPACE_FIXED_ADDRESSES)[number];

export function isWorkspaceFixedAddress(local: string): local is WorkspaceFixedAddress {
  return (WORKSPACE_FIXED_ADDRESSES as readonly string[]).includes(local);
}

/** The workspace's own mail host: `<slug>.<suffix>`, the same host as its web address. */
export function workspaceMailHost(slug: string): string {
  return `${slug}.${WORKSPACE_HOST_SUFFIX}`;
}

/** `calendar@<slug>.<suffix>`. */
export function workspaceFixedAddress(local: WorkspaceFixedAddress, slug: string): string {
  return `${local}@${workspaceMailHost(slug)}`;
}
