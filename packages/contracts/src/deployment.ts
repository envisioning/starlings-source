// Every string that says *which organisation this deployment is*: the identity
// domains, the public hosts, the sibling CRM, the address a human writes to.
//
// The values live in `deployment-values.ts`, the one file an org that is not
// this one changes, so no host literal can drift between the Worker, the SPA,
// and the two Swift apps. Runtime-configurable values (`CORE_API_ORIGIN`,
// `OWNER_ROOM_MAP`, …) still come from wrangler vars — what lives here is the
// *default*. `pnpm registries:gen` writes the values the native clients need
// into `ContractConstants` (Sources/Generated/SharedConstantsRegistry.swift).
//
// Deliberately dependency-free (no zod): the browser bundle and `paths.ts`
// both import it.
//
// `Sources/EnvisioningIdentity.swift` reads the generated values.

import {
  CORE_API_ORIGIN,
  ORG_ICS_PRODUCT_ID,
  ORG_NAME,
  ORG_WEB_ORIGIN,
  PRODUCT_SITE_ORIGIN,
} from './deployment-values.ts';

export {
  CONTACT_EMAIL,
  CORE_API_ORIGIN,
  IDENTITY_DOMAINS,
  KEEP_WEB_ORIGIN,
  LEGACY_ALIAS_HOSTS,
  LEGACY_SESSION_ISSUER,
  LEGACY_WORKER_HOST,
  ORG_ICS_PRODUCT_ID,
  ORG_NAME,
  ORG_WEB_ORIGIN,
  ORG_WWW_ORIGIN,
  PLATFORM_WORKSPACE_ORIGIN,
  PRIVACY_CONTACT_EMAIL,
  PRIVACY_OFFICER_NAME,
  PRODUCT_SITE_ORIGIN,
  PUBLIC_WEB_ORIGIN,
  SERVED_WEB_ORIGIN,
  SHARED_SECRETS_STORE_ID,
  SIGNALS_ORIGIN,
  SIGN_IN_DOMAIN,
  SYSTEM_SENDER_EMAIL,
} from './deployment-values.ts';

/** The organisation's public site without its scheme, as copy names it. */
export const ORG_WEB_HOST = new URL(ORG_WEB_ORIGIN).host;

/*
 * `IDENTITY_DOMAINS` (deployment-values): the default a workspace that names
 * none would get, and the value the native apps compile in (they reach the
 * built-in workspace only). All of them are one Google Workspace: `hd` comes
 * back as whichever domain the account lives on, so the list needs every one.
 *
 * **Not the gate.** Each workspace names its own domains in the Worker's
 * `IDENTITY_DOMAINS` var (docs/ACCESS.md slice 3), and the Worker reads them
 * through `workspace-identity.ts`. Nothing on the server may call the helpers
 * below with this constant.
 *
 * Identity only. Attaching a Google account as a *calendar to read* is
 * deliberately exempt — that credential is data, not a claim about who you are.
 */

/** One domain, lowercased: letters, digits and hyphens in dot-separated labels. */
const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;

/**
 * A workspace's identity domains from config text: a comma list, lowercased,
 * each checked. Anything that is not a domain is dropped, so a typo admits
 * nobody rather than everybody. Empty text is an empty list.
 */
export function parseIdentityDomains(raw: string | null | undefined): string[] {
  const domains = (raw ?? '').split(',').map((part) => part.trim().toLowerCase()).filter((part) => DOMAIN_PATTERN.test(part));
  return [...new Set(domains)];
}

/** True for an address on one of `domains`. */
export function isIdentityEmail(domains: readonly string[], value: string | null | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return domains.some((domain) => normalized.endsWith(`@${domain}`));
}

/*
 * `SIGN_IN_DOMAIN` (deployment-values): the single domain Google's account
 * chooser is narrowed to at sign-in (`hd`) on the built-in workspace, and the
 * native apps' compiled value. A workspace sets its own with the Worker's
 * `SIGN_IN_DOMAIN` var.
 *
 * `hd` takes one domain, and it shapes the picker — it is not the gate. The
 * Worker still admits every identity domain, so a token on another of them
 * that arrives is honoured.
 *
 * `PUBLIC_WEB_ORIGIN`: the public join permalink host for invite and calendar
 * links — never localhost, and never workers.dev. A workspace sets its own with
 * the Worker's `PUBLIC_WEB_ORIGIN` var, which the descriptor carries.
 *
 * `SERVED_WEB_ORIGIN`: the origin that serves the app. Every URL an agent or
 * crawler reads (llms.txt, robots.txt, sitemap.xml, canonical links) uses it, so
 * an agent sees one host, the same one the MCP instructions and the OAuth
 * metadata name. It follows WEB_ORIGIN in services/control-plane/wrangler.jsonc.
 *
 * `PRODUCT_SITE_ORIGIN`: product marketing and help, deployed apart from
 * workspace hosts.
 */

/** The latest notarized Mac zip. The product site serves it, not a workspace (docs/UPDATER.md). */
export const MAC_DOWNLOAD_URL = `${PRODUCT_SITE_ORIGIN}/download/mac`;
/** The product site's door to the public TestFlight invite. */
export const IOS_DOWNLOAD_URL = `${PRODUCT_SITE_ORIGIN}/download/ios`;

// `CORE_API_ORIGIN`: default origin of the sibling CRM's API. Overridden by the var of that name.

/**
 * Core's CRM dashboard, the canonical page a project or lead row links to.
 * Served from the API origin; Core's *guest-facing* reschedule/cancel pages
 * are elsewhere and come from the `CORE_WEB_ORIGIN` var instead.
 */
export function coreDashboardURL(collection: string, id: string): string {
  return `${CORE_API_ORIGIN}/dashboard/${collection}/${id}`;
}

/** The Core collection for each Meet subject kind. */
export const CORE_SUBJECT_COLLECTIONS = {
  lead: 'leads',
  project: 'projects',
  organization: 'organizations',
  event: 'events',
} as const;

export type CoreSubjectKind = keyof typeof CORE_SUBJECT_COLLECTIONS;

/** The canonical Core dashboard route for a Meet subject. */
export function coreSubjectURL(kind: CoreSubjectKind, id: string): string {
  return coreDashboardURL(CORE_SUBJECT_COLLECTIONS[kind], encodeURIComponent(id));
}

/**
 * A calendar attendee may link only to a canonical Core contact page. The
 * native clients apply the same HTTPS, host, and path guard before opening it.
 */
export function coreContactURL(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const coreHost = new URL(CORE_API_ORIGIN).hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== coreHost || !url.pathname.startsWith('/contacts/')) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

// `ORG_NAME`: a workspace that sets no `WORKSPACE_NAME` is called this.

// `ORG_ICS_PRODUCT_ID`: the `PRODID` of a calendar file the built-in workspace
// hands out. Every other workspace names itself (`icsProductId`).

/** The `PRODID` of any other workspace's calendar file; `{name}` is the workspace's name. */
export const ICS_PRODUCT_ID_TEMPLATE = '-//Starlings//{name}//EN';

/**
 * The RFC 5545 `PRODID` for a calendar file a workspace's apps build:
 * Envisioning's fixed value on Envisioning, else the template with the
 * workspace's name. The name loses `/` and control characters, which would
 * break the field. Swift reads both values from `ContractConstants`
 * (`EnvisioningDeployment.calendarProductID`).
 */
export function icsProductId(workspaceName: string): string {
  if (workspaceName === ORG_NAME) return ORG_ICS_PRODUCT_ID;
  const name = workspaceName.replace(/[\u0000-\u001f\u007f/]/gu, '').trim();
  return ICS_PRODUCT_ID_TEMPLATE.replace('{name}', name || 'Starlings');
}

// `ORG_WEB_ORIGIN`: the organisation's public site, the marketing link, not a product host.
// `CONTACT_EMAIL`: where a product question from a guest lands. `PRIVACY_CONTACT_EMAIL`:
// where a privacy request lands (access, correction, deletion, objection), the
// address /privacy names for the LGPD encarregado and the GDPR contact.
