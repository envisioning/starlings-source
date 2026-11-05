// Who is a member of this workspace, by address (docs/ACCESS.md slice 3).
//
// Each deployment names its own identity domains in the `IDENTITY_DOMAINS`
// var, a comma list, and the one domain Google's account chooser is narrowed
// to in `SIGN_IN_DOMAIN`. Envisioning sets `the organisation's site,the organisation's site`;
// another workspace sets its own. Every server-side "is this one of us"
// question reads them here, never a compiled constant.
//
// Fail closed: a deployment that names no valid domain admits nobody by
// domain. The domain check decides which role a *new* `people` row gets
// (docs/ENROLLMENT.md decision 1); it never widens what a role holds.

import {
  identityAddresses,
  isIdentityEmail,
  isIdentityHostedDomain,
  isSameIdentityPerson,
  ownerRoomSlugFor,
  parseIdentityDomains,
} from './contracts';
import { AuthError } from './errors';
import { verifyGoogleIdentity, type GoogleIdentity } from './google-oauth';

const parsed = new Map<string, readonly string[]>();

/** This workspace's identity domains, parsed once per distinct var value. */
export function identityDomains(env: Pick<Env, 'IDENTITY_DOMAINS'>): readonly string[] {
  const raw = env.IDENTITY_DOMAINS ?? '';
  let domains = parsed.get(raw);
  if (!domains) {
    domains = Object.freeze(parseIdentityDomains(raw));
    parsed.set(raw, domains);
  }
  return domains;
}

/** True for an address on one of this workspace's identity domains. */
export function isMemberEmail(env: Pick<Env, 'IDENTITY_DOMAINS'>, value: string | null | undefined): boolean {
  return isIdentityEmail(identityDomains(env), value);
}

/** True for a Google `hd` claim naming one of this workspace's identity domains. */
export function isMemberHostedDomain(env: Pick<Env, 'IDENTITY_DOMAINS'>, value: string | null | undefined): boolean {
  return isIdentityHostedDomain(identityDomains(env), value);
}

/**
 * False on "Only people I invite" (`WORKSPACE_MEMBERSHIP=invite`).
 * There the identity domains still say who is one of us (attendees, mail,
 * roles), but they admit nobody: a member holds an invitation or is a root
 * admin.
 */
export function admitsByDomain(env: Pick<Env, 'WORKSPACE_MEMBERSHIP'>): boolean {
  return env.WORKSPACE_MEMBERSHIP?.trim() !== 'invite';
}

/** An address the domain alone admits here: on an identity domain, where the domain admits, or a root admin on one. */
export function isDomainAdmitted(env: Pick<Env, 'IDENTITY_DOMAINS' | 'WORKSPACE_MEMBERSHIP' | 'ROOT_ADMIN_EMAILS'>, value: string | null | undefined): boolean {
  if (!isMemberEmail(env, value)) return false;
  return admitsByDomain(env) || isRootAdminEmail(env, value);
}

/** Every address one member answers to on this workspace. */
export function memberAddresses(env: Pick<Env, 'IDENTITY_DOMAINS'>, email: string): string[] {
  return identityAddresses(identityDomains(env), email);
}

/** True when two addresses name the same member of this workspace. */
export function isSameMember(env: Pick<Env, 'IDENTITY_DOMAINS'>, a: string, b: string): boolean {
  return isSameIdentityPerson(identityDomains(env), a, b);
}

/**
 * The room `OWNER_ROOM_MAP` gives an address, whichever identity domain the
 * map keys it on. The map is a read fallback: "my room" is
 * `roomOfMember` in member-rooms.ts, which reads D1 first. This one alone
 * answers the admin bootstrap, which stays configuration.
 */
export function mappedRoomFor(env: Pick<Env, 'IDENTITY_DOMAINS' | 'OWNER_ROOM_MAP'>, email: string): string | null {
  return ownerRoomSlugFor(env.OWNER_ROOM_MAP, email, identityDomains(env));
}

/**
 * The domain sent as Google's `hd` at sign-in: `SIGN_IN_DOMAIN` when it is
 * one of the identity domains, else the first identity domain, else none.
 * None on "Only people I invite": there the domain admits only root admins,
 * and `hd` would hide the invited addresses (a personal Google account has
 * no hosted domain) from the account chooser. The gate is the invitation.
 */
export function signInDomain(env: Pick<Env, 'IDENTITY_DOMAINS' | 'SIGN_IN_DOMAIN' | 'WORKSPACE_MEMBERSHIP'>): string | null {
  if (!admitsByDomain(env)) return null;
  const domains = identityDomains(env);
  const named = env.SIGN_IN_DOMAIN?.trim().toLowerCase();
  if (named && domains.includes(named)) return named;
  return domains[0] ?? null;
}

/**
 * Verify a Google ID token and require a verified identity on one of this
 * workspace's domains (`IDENTITY_DOMAINS`), with the expected nonce. Callers add their own extra checks (name presence, owner
 * match) and their own error copy via `failureMessage`.
 */
export async function verifyMemberIdentity(env: Pick<Env, 'IDENTITY_DOMAINS'>, idToken: string, options: {
  audience: string;
  /** `verifyGoogleIdentity`'s rule: `null` only for a token-endpoint ID token. */
  nonce: string | null;
  failureMessage: string;
}): Promise<GoogleIdentity> {
  const identity = await verifyGoogleIdentity(idToken, options);
  if (!isMemberHostedDomain(env, identity.hd) || !isMemberEmail(env, identity.email)) {
    throw new AuthError(options.failureMessage, 403, 'oauth_failed');
  }
  return identity;
}

/**
 * The accounts that are admins of this workspace unconditionally, and can
 * never stop being: `ROOT_ADMIN_EMAILS`, a comma list.
 *
 * Every other route to admin can be taken away by something that is not a
 * person deciding to: `people.role` is a database column a stale restore or a
 * stray statement removes; `OWNER_ROOM_MAP` is a read fallback for rooms; and
 * `people.revoked_at` locks an account out of renewal entirely. Any of those
 * going wrong locks everybody out of the only surface that could put it right.
 *
 * So this list does not live in the database. It is a wrangler var: in
 * source, behind code review and a deploy, read without `await`, so an
 * unreachable D1 does not change the answer. It beats every refusal in
 * `admin.ts`: a root admin cannot be demoted, cannot be revoked, and does not
 * need a room. Each workspace names its own; none inherits Envisioning's.
 * `scripts/check-production-config.mjs` refuses a deployed config without one.
 *
 * Keep it to the people who would have to fix the workspace if everything
 * else failed. It is a recovery guarantee, not a seniority list.
 */
export function rootAdminEmails(env: Pick<Env, 'ROOT_ADMIN_EMAILS'>): readonly string[] {
  return (env.ROOT_ADMIN_EMAILS ?? '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.includes('@'));
}

/** True for one of this workspace's root admins. */
export function isRootAdminEmail(env: Pick<Env, 'ROOT_ADMIN_EMAILS'>, value: string | null | undefined): boolean {
  if (!value) return false;
  return rootAdminEmails(env).includes(value.trim().toLowerCase());
}
