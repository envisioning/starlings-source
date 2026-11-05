// Who counts as staff on this deployment, and whether it has a web sign-in.
//
// Envisioning's deployment and each workspace deployment run the same code.
// The difference is two vars. Every identity gate in the Worker reads them
// here, and nowhere else.

import { ENVISIONING_IDENTITY_DOMAINS, isHostedDomainIn, isIdentityEmailIn } from '@docs/contracts';

const DOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/**
 * The identity domains this deployment admits, lower case, in config order.
 *
 * `IDENTITY_DOMAINS` unset gives Envisioning's two domains, so the top-level
 * deployment behaves as before. A value that is empty, or that holds one entry
 * that is not a domain, gives an empty list: a typo admits nobody rather than
 * a partial list.
 */
export function identityDomains(env: Pick<Env, 'IDENTITY_DOMAINS'>): readonly string[] {
  const raw = env.IDENTITY_DOMAINS;
  if (raw === undefined) return ENVISIONING_IDENTITY_DOMAINS;
  const domains = raw.split(',').map((entry) => entry.trim().toLowerCase());
  if (domains.length === 0 || !domains.every((domain) => DOMAIN.test(domain))) return [];
  return domains;
}

/** True for an address on one of this deployment's identity domains. */
export function isIdentityEmail(env: Pick<Env, 'IDENTITY_DOMAINS'>, value: string | null | undefined): boolean {
  return isIdentityEmailIn(value, identityDomains(env));
}

/** True for a Google `hd` claim naming one of this deployment's identity domains. */
export function isIdentityHostedDomain(env: Pick<Env, 'IDENTITY_DOMAINS'>, value: string | null | undefined): boolean {
  return isHostedDomainIn(value, identityDomains(env));
}

/**
 * Google's `hd` authorization parameter: the first identity domain. It only
 * filters the account picker. The gate is `isIdentityHostedDomain` on the
 * returned ID token. Null when the list is empty.
 */
export function googleHostedDomain(env: Pick<Env, 'IDENTITY_DOMAINS'>): string | null {
  return identityDomains(env)[0] ?? null;
}

/**
 * The web sign-in this deployment offers. Unset is `google`, as before.
 * `central` signs in through the auth host as the workspace
 * (central-auth.ts; the `AUTH` and `MEET` bindings). `off` has no browser
 * sign-in: people reach it through their workspace's Meet Worker. Any other
 * value is `off`.
 */
export function webSignIn(env: Pick<Env, 'WEB_SIGN_IN'>): 'google' | 'central' | 'off' {
  const value = env.WEB_SIGN_IN;
  if (value === undefined || value === 'google') return 'google';
  if (value === 'central') return 'central';
  return 'off';
}
