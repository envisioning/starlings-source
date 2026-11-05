// Who this deployment admits, and how they sign in. Per deployment, from
// `wrangler.jsonc` vars, never from the shared contract: Envisioning's Keep
// and each workspace's Keep admit different account domains.
//
//   IDENTITY_DOMAINS  comma-separated, compared lowercase. Unset means
//                     Envisioning's rule: `SIGN_IN_DOMAIN` only. Set but
//                     empty, or with one malformed entry, admits nobody.
//   WEB_SIGN_IN       `google` (unset means this) or `off`. Any other value
//                     is `off`. A workspace deployment is `off`: people reach
//                     it only through their workspace's Meet exchange.

import { SIGN_IN_DOMAIN } from '../../../../packages/contracts/src/deployment-values';
import { KeepError } from './errors';

/** Envisioning's top-level deployment, as it was before this was config. */
const DEFAULT_IDENTITY_DOMAINS = [SIGN_IN_DOMAIN] as const;
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;

export function identityDomains(env: Env): readonly string[] {
  const raw = env.IDENTITY_DOMAINS;
  if (raw === undefined) return DEFAULT_IDENTITY_DOMAINS;
  const domains = raw.split(',').map((domain) => domain.trim().toLowerCase());
  if (domains.length === 0 || domains.some((domain) => !DOMAIN.test(domain))) return [];
  return domains;
}

/** True when the address is in an admitted domain. Exact domain match, no subdomains. */
export function isAdmittedEmail(env: Env, email: string): boolean {
  const at = email.lastIndexOf('@');
  if (at <= 0) return false;
  return identityDomains(env).includes(email.slice(at + 1).toLowerCase());
}

/** The boundary check for an email that arrives in a request body. 400, like the schema refine it replaces. */
export function assertAdmittedEmail(env: Env, email: string, field: string): void {
  if (!isAdmittedEmail(env, email)) {
    throw new KeepError(`${field}: not an account this deployment admits.`, 400, 'invalid_request');
  }
}

/**
 * The web sign-in this deployment offers. Unset is `google`. `central` signs
 * in through the auth host as the workspace (central-auth.ts; the `AUTH` and
 * `MEET` bindings). `off` has none: only the Meet exchange mints a
 * credential. Any other value is `off`.
 */
export function webSignIn(env: Env): 'google' | 'central' | 'off' {
  const value = env.WEB_SIGN_IN ?? 'google';
  if (value === 'google' || value === 'central') return value;
  return 'off';
}

/** True when the Google routes serve this deployment. */
export function webSignInEnabled(env: Env): boolean {
  return webSignIn(env) === 'google';
}
