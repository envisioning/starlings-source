// Who may do what, by `people.role` — the authorization model docs/ENROLLMENT.md
// asked for (steps 1–2).
//
// `requireEnvisioningMember` answered "is there a valid session" and nothing
// more. That was safe only while the domain check made "has a session" and
// "is a colleague" the same set of people; the moment one address from
// outside the domain is admitted, every call site behind it becomes public in
// the same commit. So every internal route now names the *capability* it
// protects, and this table says which roles hold it. Deny by default: a
// capability not listed for a role is refused, and a new route picks a
// capability or it does not ship.
//
// Today every `people` row is `member` or `admin`, so behaviour is
// byte-identical to before. The `community` column is what makes the table
// worth having early: the suite proves such a row is refused everywhere it
// must be, before one can exist (step 4/5 are the only steps that could
// create one, and they are not built).

import { AuthError, getOwnerSession } from './auth';
import { ControlError } from './errors';
import { type OwnerSession } from './contracts';
import { isDomainAdmitted, isRootAdminEmail } from './workspace-identity';
import { hasAcceptedInvitation } from './invitations';

export const PEOPLE_ROLES = ['admin', 'member', 'community'] as const;
export type PersonRole = (typeof PEOPLE_ROLES)[number];

/** A session with the role D1 currently grants it. */
export interface RoleSession extends OwnerSession {
  role: PersonRole;
  /** Set when an agent acts through `/mcp` as this person (auth.ts `SessionPrincipal`). */
  agentSub?: string;
}

/**
 * One row per thing a signed-in person can reach. Keep in step with the
 * table in docs/ENROLLMENT.md §Capabilities — that table is the contract.
 */
export const CAPABILITIES = {
  /** Own picture and language, own Home order, own signed-in devices: read faces you can already see, upload your own. */
  ownProfile: ['admin', 'member', 'community'],
  /** The Envisioning roster, presence, intent, unavailable, appear-offline. */
  roster: ['admin', 'member'],
  /** Wave / Call — reaches a colleague's device. */
  reachColleague: ['admin', 'member'],
  /** DMs, the Team channel, project and lead channels, attachments. */
  conversations: ['admin', 'member'],
  /** The work graph: board, feed, Mine, somebody's work, the sales inbox. */
  crmWork: ['admin', 'member'],
  /** Images attached to GitHub issues filed from Meet. */
  issueImages: ['admin', 'member'],
  /**
   * Admin: roster, usage, the meetings ledger, the workspace's settings
   * (MZ, 2026-10-18: admins only). Every Admin route takes the `admin` gate,
   * `requireOrgAdmin`, which also admits a root admin and a bootstrap room
   * owner whose row says `member`; this row is what the setup steps read.
   */
  adminOverview: ['admin'],
  /** Org-wide transcription vocabulary, loaded by every host session. */
  transcriptionVocabulary: ['admin', 'member'],
  /** Agent surfaces — cancel a hand-off. Invariant 21: never a community session. */
  agents: ['admin', 'member'],
  /** Website content (Core's CMS data space) read and written as the member, through `/api/cms/*`. */
  cmsContent: ['admin', 'member'],
  /** Send your own device's crash and hang reports. Reading them is an admin act. */
  diagnostics: ['admin', 'member'],
  /** Grant Meet read access to your own Gmail or Drive, and take it back. */
  googleGrant: ['admin', 'member'],
  /** Own a room, host a meeting, answer an offer to host, enter the internal room as a member (invariants 4 and 7). */
  hosting: ['admin', 'member'],
  /** The member's own Google calendars and `.ics` subscriptions, events, availability, booking links. */
  calendar: ['admin', 'member'],
  /** Docs documents and Keep notes, and the device tokens that reach them. */
  docs: ['admin', 'member'],
} as const satisfies Record<string, readonly PersonRole[]>;

export type Capability = keyof typeof CAPABILITIES;

export function roleAllows(role: PersonRole, capability: Capability): boolean {
  return (CAPABILITIES[capability] as readonly PersonRole[]).includes(role);
}

/**
 * What D1 says about `sub` right now: the role it grants and whether the
 * person has been revoked (`people.revoked_at`, written by `setPersonAccess`).
 * Read on every guarded request rather than trusted from the token, so a role
 * change or a revocation bites on the next request, not after a refresh
 * lifetime (ENROLLMENT.md step 3's reasoning, applied one layer earlier).
 *
 * **The window.** Cached per isolate for `ROLE_CACHE_MILLISECONDS` (60 s): a
 * roster poll every thirty seconds from every client must not be a D1 read
 * each. A revocation therefore refuses the person on every guarded route
 * within 60 seconds on every isolate, and at once on the isolate that took the
 * revoke (`setPersonAccess` clears this cache). Native devices are cut off
 * earlier still, because revoking deletes their device rows.
 *
 * A session with no row, or a role string the table does not name, reads as
 * `member` and not revoked. That is the honest answer today — `getOwnerSession`
 * already refused any address off the domain, so whoever holds this session is
 * a colleague — and it must be revisited in the same change that lets a
 * non-domain address hold one.
 *
 * An unreadable D1 is not an answer. It is a 503, and nothing is cached, so
 * the next request asks again: a store that is down for a minute must not
 * grant `member` for a minute to whoever asked first, nor let a
 * revoked person through for one.
 */
async function standingOf(env: Env, sub: string): Promise<Standing> {
  const cached = standingCache.get(sub);
  const now = Date.now();
  if (cached && cached.expires > now) return cached;
  let row: { role: string | null; revoked_at: number | null } | null;
  try {
    row = await env.USAGE.prepare('SELECT role, revoked_at FROM people WHERE sub = ?1')
      .bind(sub)
      .first<{ role: string | null; revoked_at: number | null }>();
  } catch (error) {
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'capabilities.role.query.failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
    throw new ControlError('The role store could not be read.', 503);
  }
  const standing: Standing = {
    role: PEOPLE_ROLES.find((candidate) => candidate === row?.role) ?? 'member',
    revoked: row?.revoked_at != null,
    expires: now + ROLE_CACHE_MILLISECONDS,
  };
  standingCache.set(sub, standing);
  return standing;
}

/** The role D1 grants `sub` right now (cached; see `standingOf`). */
export async function roleOf(env: Env, sub: string): Promise<PersonRole> {
  return (await standingOf(env, sub)).role;
}

const ROLE_CACHE_MILLISECONDS = 60_000;
interface Standing { role: PersonRole; revoked: boolean; expires: number }
const standingCache = new Map<string, Standing>();

/** Tests, the admin role write and the admin revoke call this so a change is seen at once. */
export function resetRoleCache(): void {
  standingCache.clear();
  invitedCache.clear();
}

const invitedCache = new Map<string, { invited: boolean; expires: number }>();

/**
 * Is this session's address a member here: on a sign-in domain,
 * or holding an accepted invitation. An address outside the domains with no
 * accepted invitation is treated as revoked: its session admits nothing.
 * Cached like the standing; a D1 error refuses (503), never admits.
 */
async function isAdmittedAddress(env: Env, email: string): Promise<boolean> {
  if (isDomainAdmitted(env, email)) return true;
  const key = email.trim().toLowerCase();
  const now = Date.now();
  const cached = invitedCache.get(key);
  if (cached && cached.expires > now) return cached.invited;
  let invited: boolean;
  try {
    invited = await hasAcceptedInvitation(env, key);
  } catch (error) {
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'capabilities.invitation.query.failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
    throw new ControlError('The role store could not be read.', 503);
  }
  invitedCache.set(key, { invited, expires: now + ROLE_CACHE_MILLISECONDS });
  return invited;
}

/**
 * Is this address a member here, by the gate `requireCapability` uses: a
 * root admin, an address the domain admits, or one holding an accepted
 * invitation. `/mcp` asks this, so a person who joined by
 * invitation reaches it like a domain member. Revocation is the `people`
 * row's, read by the caller.
 */
export async function isAdmittedMember(env: Env, email: string): Promise<boolean> {
  return isRootAdminEmail(env, email) || await isAdmittedAddress(env, email);
}

/**
 * The guard on every internal route: a valid session, a person who has not
 * been revoked, **and** a role that holds `capability`. No session is the
 * same 401 `owner_auth_required` that every gate answers — one status, one
 * code, so a client renews on it from any route instead of only the ones that
 * happened to say 401. A revoked person gets that same 401: the native client
 * renews, the renewal is refused (`redeemOwnerRefreshToken` reads the same
 * column), and it signs itself out, which is the answer a revocation wants.
 * A root admin is never refused for `revoked_at`, as on renewal: that column
 * must not lock out the account that would undo it. A distinct code for a
 * session whose role does not reach this far, so a client can say "not for
 * your account" rather than "sign in again".
 */
export async function requireCapability(request: Request, env: Env, capability: Capability): Promise<RoleSession> {
  const owner = await getOwnerSession(request, env);
  if (!owner) throw new AuthError('Not authenticated.', 401, 'owner_auth_required');
  const standing = await standingOf(env, owner.sub);
  const admitted = isRootAdminEmail(env, owner.email) || await isAdmittedAddress(env, owner.email);
  if ((standing.revoked && !isRootAdminEmail(env, owner.email)) || !admitted) {
    throw new AuthError('This account can no longer sign in to Starlings.', 401, 'owner_auth_required');
  }
  if (!roleAllows(standing.role, capability)) {
    throw new AuthError('This is not available to your account.', 403, 'capability_denied');
  }
  return { ...owner, role: standing.role };
}

/**
 * The session behind a route that answers anyone but recognises a member when
 * there is one: the public room page ("you" is filled in), the lobby socket,
 * the internal room's knock. A revoked person, or a role that does not hold
 * `capability`, is **no session** here — treated as the stranger they now
 * are, never as a member. Use `requireCapability` wherever a route refuses
 * strangers outright.
 */
export async function optionalSession(request: Request, env: Env, capability: Capability): Promise<RoleSession | null> {
  const owner = await getOwnerSession(request, env);
  if (!owner) return null;
  const standing = await standingOf(env, owner.sub);
  if (standing.revoked && !isRootAdminEmail(env, owner.email)) return null;
  if (!isRootAdminEmail(env, owner.email) && !(await isAdmittedAddress(env, owner.email))) return null;
  if (!roleAllows(standing.role, capability)) return null;
  return { ...owner, role: standing.role };
}
