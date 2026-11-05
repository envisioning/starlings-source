// Invitations (docs/ONBOARDING.md §Invitations). An admin invites
// an address with a role from Admin › People; the address gets mail E4 with
// the sign-in link. Signing in with an open invitation writes the `people`
// row with the invited role and the person's room in one batch, and spends
// the invitation (decision 10). ENROLLMENT.md decision 3 holds: there is no
// registration, only an admin's invitation.
//
// Who is a member here, after this:
//
// - an address on the workspace's sign-in domains (`IDENTITY_DOMAINS`), unless
//   the workspace is "Only people I invite" (`WORKSPACE_MEMBERSHIP=invite`,
//  ), where the domain admits only a root admin, or
// - an address whose invitation was accepted, while its person is not
//   revoked (capabilities.ts reads it on every guarded request).
//
// A revoked or lapsed invitation admits nobody. Fail closed: a D1 error is a
// refusal. Logs never name an address.

import {
  INVITATION_TTL_MILLISECONDS,
  adminInvitationActionSchema,
  adminInviteRequestSchema,
  type AdminInvitation,
  type AdminInvitationActionResponse,
  type AdminInvitationsResponse,
  type AdminInviteResponse,
  type InvitationRefusal,
  type InvitationRole,
} from '@starlings/contracts/invitations';
import { recordAdminAction } from './admin-audit';
import type { OwnerSession } from './contracts';
import { randomToken } from './crypto';
import { ControlError } from './errors';
import { sendMail, withSenderName } from './mail';
import { planMemberRoom } from './member-rooms';
import { isDomainAdmitted, memberAddresses } from './workspace-identity';
import { workspaceName } from './workspace-profile';

interface InvitationRow {
  id: string;
  email: string;
  role: InvitationRole;
  invited_by: string;
  created_at: number;
  expires_at: number;
  mailed_at: number | null;
  accepted_at: number | null;
  revoked_at: number | null;
}

const COLUMNS = 'id, email, role, invited_by, created_at, expires_at, mailed_at, accepted_at, revoked_at';
/** Insert attempts when a concurrent write takes the room slug first. */
const MAX_ATTEMPTS = 3;

function toWire(row: InvitationRow, now: number): AdminInvitation {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    invited_by: row.invited_by,
    created_at: row.created_at,
    expires_at: row.expires_at,
    mailed_at: row.mailed_at,
    state: row.expires_at > now ? 'pending' : 'lapsed',
  };
}

function normalize(email: string): string {
  return email.trim().toLowerCase();
}

/** `GET /api/admin/invitations`: unspent invitations, pending and lapsed, newest first. */
export async function listInvitations(env: Env, now = Date.now()): Promise<AdminInvitationsResponse> {
  const { results } = await env.USAGE.prepare(
    `SELECT ${COLUMNS} FROM invitations WHERE accepted_at IS NULL AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 200`,
  ).all<InvitationRow>();
  return { invitations: results.map((row) => toWire(row, now)) };
}

/** Why this address cannot be invited, or null. Any of the person's addresses counts. */
async function refusalFor(env: Env, email: string): Promise<InvitationRefusal | null> {
  const addresses = memberAddresses(env, email);
  const row = await env.USAGE.prepare(
    `SELECT kind, revoked_at FROM people WHERE lower(email) IN (${addresses.map((_, index) => `?${index + 1}`).join(', ')}) LIMIT 1`,
  ).bind(...addresses).first<{ kind: string | null; revoked_at: number | null }>();
  if (!row) return null;
  if (row.kind === 'agent') return 'agent';
  if (row.revoked_at != null) return 'revoked';
  return 'member';
}

/** The sign-in link and expiry, from the inviting admin (E4). Plain text. */
async function mailInvitation(env: Env, row: InvitationRow, inviter: string, now: number): Promise<number | null> {
  try {
    const name = (await workspaceName(env).catch(() => null)) ?? new URL(env.WEB_ORIGIN).hostname;
    const until = new Date(row.expires_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
    const sent = await sendMail(env, {
      to: row.email,
      from: withSenderName(env.MAIL_FROM, name),
      subject: `${inviter} invited you to ${name}`,
      text: [
        `${inviter} invited you to ${name} on Starlings.`,
        '',
        `Sign in as ${row.email}:`,
        `${env.WEB_ORIGIN}/`,
        '',
        `The invitation is open until ${until}.`,
      ].join('\n'),
    });
    if (!sent) return null;
    await env.USAGE.prepare('UPDATE invitations SET mailed_at = ?2 WHERE id = ?1').bind(row.id, now).run();
    return now;
  } catch (error) {
    // The kind only; never the address.
    console.error(JSON.stringify({ level: 'error', message: 'invitation.mail_failed', error: error instanceof Error ? error.name : 'unknown' }));
    return null;
  }
}

/**
 * `POST /api/admin/invitations`: invite each address with one role. An
 * address that already has an unspent invitation gets it renewed with this
 * role. A member, a revoked person and an agent are refused by name.
 */
export async function inviteMembers(env: Env, owner: OwnerSession, raw: unknown, now = Date.now()): Promise<AdminInviteResponse> {
  const input = adminInviteRequestSchema.parse(raw);
  const invitations: AdminInvitation[] = [];
  const refused: AdminInviteResponse['refused'] = [];
  const inviter = owner.name?.trim() || owner.email;
  for (const email of [...new Set(input.emails.map(normalize))]) {
    const reason = await refusalFor(env, email);
    if (reason) {
      refused.push({ email, reason });
      continue;
    }
    const expires = now + INVITATION_TTL_MILLISECONDS;
    const row = await env.USAGE.prepare(
      `INSERT INTO invitations (id, email, role, invited_by, created_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (email) WHERE accepted_at IS NULL AND revoked_at IS NULL
       DO UPDATE SET role = excluded.role, invited_by = excluded.invited_by, expires_at = excluded.expires_at
       RETURNING ${COLUMNS}`,
    ).bind(`inv_${randomToken(18)}`, email, input.role, normalize(owner.email), now, expires).first<InvitationRow>();
    if (!row) throw new ControlError('The invitation could not be saved.', 503);
    row.mailed_at = await mailInvitation(env, row, inviter, now);
    await recordAdminAction(env, owner, 'invitation.send', email, input.role);
    invitations.push(toWire(row, now));
  }
  return { invitations, refused };
}

/** `POST /api/admin/invitations/resend`: mail it again, open for a new 14 days. */
export async function resendInvitation(env: Env, owner: OwnerSession, raw: unknown, now = Date.now()): Promise<AdminInvitationActionResponse> {
  const { id } = adminInvitationActionSchema.parse(raw);
  const row = await env.USAGE.prepare(
    `UPDATE invitations SET expires_at = ?2, invited_by = ?3
      WHERE id = ?1 AND accepted_at IS NULL AND revoked_at IS NULL
      RETURNING ${COLUMNS}`,
  ).bind(id, now + INVITATION_TTL_MILLISECONDS, normalize(owner.email)).first<InvitationRow>();
  if (!row) throw new ControlError('That invitation is no longer open.', 404, 'request_not_found');
  row.mailed_at = await mailInvitation(env, row, owner.name?.trim() || owner.email, now);
  await recordAdminAction(env, owner, 'invitation.resend', row.email, null);
  return { invitation: toWire(row, now) };
}

/** `POST /api/admin/invitations/revoke`: the invitation admits nobody from now on. */
export async function revokeInvitation(env: Env, owner: OwnerSession, raw: unknown, now = Date.now()): Promise<AdminInvitationActionResponse> {
  const { id } = adminInvitationActionSchema.parse(raw);
  const row = await env.USAGE.prepare(
    `UPDATE invitations SET revoked_at = ?2
      WHERE id = ?1 AND accepted_at IS NULL AND revoked_at IS NULL
      RETURNING ${COLUMNS}`,
  ).bind(id, now).first<InvitationRow>();
  if (!row) throw new ControlError('That invitation is no longer open.', 404, 'request_not_found');
  await recordAdminAction(env, owner, 'invitation.revoke', row.email, null);
  return { invitation: toWire(row, now) };
}

/** The open invitation for this address: not spent, not revoked, not lapsed. */
async function openInvitationFor(env: Env, email: string, now: number): Promise<InvitationRow | null> {
  return env.USAGE.prepare(
    `SELECT ${COLUMNS} FROM invitations
      WHERE email = ?1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?2 LIMIT 1`,
  ).bind(normalize(email), now).first<InvitationRow>();
}

/** True when this address accepted an invitation here. */
export async function hasAcceptedInvitation(env: Env, email: string): Promise<boolean> {
  const row = await env.USAGE.prepare('SELECT 1 AS found FROM invitations WHERE email = ?1 AND accepted_at IS NOT NULL LIMIT 1')
    .bind(normalize(email)).first();
  return row !== null;
}

/**
 * Is this address a member here: on a sign-in domain, or holding an
 * accepted invitation. Revocation is the people row's, read by the caller.
 */
export async function isWorkspaceMember(env: Env, email: string): Promise<boolean> {
  if (isDomainAdmitted(env, email)) return true;
  return hasAcceptedInvitation(env, email);
}

/** May this address sign in: a member, or an address with an open invitation. */
export async function mayJoin(env: Env, email: string, now = Date.now()): Promise<boolean> {
  if (await isWorkspaceMember(env, email)) return true;
  return (await openInvitationFor(env, email, now)) !== null;
}

/**
 * Spend this address's open invitation at sign-in: the `people` row with the
 * invited role, the person's room, and `accepted_at`, in one batch. Every
 * statement is guarded by the invitation being open, so a revoke or a lapse
 * between the read and the write leaves nothing behind. An existing row
 * keeps its role. True when this call spent it.
 */
export async function acceptOpenInvitation(
  env: Env,
  person: { sub: string; email: string; name: string },
  now = Date.now(),
): Promise<boolean> {
  const email = normalize(person.email);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const invitation = await openInvitationFor(env, email, now);
    if (!invitation) return false;
    const room = await planMemberRoom(env, { name: person.name, email });
    const open = 'EXISTS (SELECT 1 FROM invitations WHERE id = ?1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?2)';
    const statements: D1PreparedStatement[] = [
      env.USAGE.prepare(
        `INSERT INTO people (sub, email, name, first_seen_at, last_seen_at, role, room_slug)
         SELECT ?3, ?4, ?5, ?2, ?2, ?6, ?7 WHERE ${open}
         ON CONFLICT DO NOTHING`,
      ).bind(invitation.id, now, person.sub, email, person.name, invitation.role, room.slug),
    ];
    if (room.kind === 'create') {
      statements.push(env.USAGE.prepare(
        `INSERT INTO rooms (slug, owner_email, created_at, created_by) SELECT ?3, ?4, ?2, ?5 WHERE ${open}`,
      ).bind(invitation.id, now, room.slug, email, person.sub));
    } else if (room.kind === 'restore') {
      statements.push(env.USAGE.prepare(
        `UPDATE rooms SET retired_at = NULL WHERE slug = ?3 AND retired_at IS NOT NULL AND ${open}`,
      ).bind(invitation.id, now, room.slug));
    }
    statements.push(env.USAGE.prepare(
      'UPDATE invitations SET accepted_at = ?2 WHERE id = ?1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?2',
    ).bind(invitation.id, now));
    try {
      const results = await env.USAGE.batch(statements);
      return (results[results.length - 1]?.meta?.changes ?? 0) > 0;
    } catch (error) {
      // A unique-key conflict on the room: another write took the slug first.
      if (attempt === MAX_ATTEMPTS) throw error;
    }
  }
  return false;
}
