/**
 * This workspace's identity domains (docs/ACCESS.md slice 3). The Worker
 * writes them into every page it serves as `<meta name="identity-domains">`,
 * from its `IDENTITY_DOMAINS` var. The browser uses them to read rooms only:
 * whose captions to trust, who looks like a member. The Worker is the gate.
 *
 * The Worker writes the meta on every page. A page without it trusts no
 * domain, except on the Vite dev server, which stands in for
 * Envisioning with the default in `@starlings/contracts/deployment`.
 */
import { IDENTITY_DOMAINS, isIdentityEmail, parseIdentityDomains } from '@starlings/contracts/deployment';

let domains: readonly string[] | null = null;

export function workspaceIdentityDomains(): readonly string[] {
  if (domains) return domains;
  // Read without the DOM types: the Worker's typecheck reads this file too.
  const page = (globalThis as { document?: { querySelector(selector: string): { content: string } | null } }).document;
  const meta = page?.querySelector('meta[name="identity-domains"]') ?? null;
  domains = meta ? parseIdentityDomains(meta.content) : import.meta.env?.DEV ? [...IDENTITY_DOMAINS] : [];
  return domains;
}

/** True for an address on one of this workspace's identity domains. */
export function isWorkspaceMemberEmail(value: string | null | undefined): boolean {
  return isIdentityEmail(workspaceIdentityDomains(), value);
}
