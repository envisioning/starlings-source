// Sharing with people who do not have an Envisioning account.
//
// A grant is a capability: holding the token is what gets you in. Stating an
// email is what gets you *named* in the audit trail — that is the bargain the
// current www/private/docs flow already makes, and it is preserved here so
// existing links keep behaving the way people expect.
//
// Signers are different. A signature is worthless if anyone with the link can
// produce one in someone else's name, so `require_verification` forces a
// mailed code before a signer session is minted, and it is set automatically
// for every signer grant.

import { claimSchema, grantCreateSchema, verifySchema, type GrantSummary, type GuestSession } from '@docs/contracts';
import { constantTimeEqual, numericCode, randomToken, sha256Hex, uuid } from './crypto';
import { AuthError, DocsError, NotFoundError } from './errors';
import { sendMail } from './email';

const MAX_VERIFICATION_ATTEMPTS = 5;
const VERIFICATION_TTL_MINUTES = 15;

export interface GrantRow {
  id: string;
  document_id: string | null;
  folder_id: string | null;
  token: string;
  email: string | null;
  role: 'viewer' | 'commenter' | 'signer';
  require_verification: number;
  label: string | null;
  created_by: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  use_count: number;
}

export async function createGrant(
  env: Env,
  target: { documentId?: string; folderId?: string },
  input: unknown,
  createdBy: string,
): Promise<GrantSummary> {
  const parsed = grantCreateSchema.parse(input);
  const id = uuid();
  const token = randomToken(24);
  // A signer must always prove the address, whatever the caller asked for.
  const requireVerification = parsed.role === 'signer' ? true : (parsed.require_verification ?? false);
  const expiresAt = parsed.expires_in_days
    ? new Date(Date.now() + parsed.expires_in_days * 86_400_000).toISOString()
    : null;

  await env.DB.prepare(
    `INSERT INTO grants
       (id, document_id, folder_id, token, email, role, require_verification, label, created_by, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      target.documentId ?? null,
      target.folderId ?? null,
      token,
      parsed.email?.toLowerCase() ?? null,
      parsed.role,
      requireVerification ? 1 : 0,
      parsed.label ?? null,
      createdBy,
      expiresAt,
    )
    .run();

  const row = await env.DB.prepare(`SELECT * FROM grants WHERE id = ?`).bind(id).first<GrantRow>();
  if (!row) throw new DocsError('Grant creation failed.', 500, 'internal');
  return toSummary(row, env);
}

export async function listGrants(env: Env, documentId: string): Promise<GrantSummary[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM grants WHERE document_id = ? ORDER BY created_at DESC`,
  )
    .bind(documentId)
    .all<GrantRow>();
  return results.map((row) => toSummary(row, env));
}

export async function revokeGrant(env: Env, id: string): Promise<void> {
  const result = await env.DB.prepare(
    `UPDATE grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`,
  )
    .bind(new Date().toISOString(), id)
    .run();
  if (!result.meta.changes) throw new NotFoundError('No such grant, or it is already revoked.');
}

export async function getGrantByToken(env: Env, token: string): Promise<GrantRow> {
  const row = await env.DB.prepare(`SELECT * FROM grants WHERE token = ?`).bind(token).first<GrantRow>();
  // Deliberately the same error for "no such token" and "revoked": a share
  // link is a secret, and distinguishing the two confirms one existed.
  if (!row) throw new NotFoundError('This link is not valid.');
  if (row.revoked_at) throw new DocsError('This link has been revoked.', 410, 'gone');
  if (row.expires_at && Date.parse(row.expires_at) < Date.now()) {
    throw new DocsError('This link has expired.', 410, 'gone');
  }
  return row;
}

/**
 * Step one of guest access: state an email.
 *
 * Returns either a ready-to-use guest session, or a signal that a code was
 * mailed and `POST /api/access/verify` is the next call.
 */
export async function claimGrant(
  env: Env,
  input: unknown,
): Promise<{ status: 'ready'; session: GuestSession } | { status: 'verify'; email: string }> {
  const parsed = claimSchema.parse(input);
  const grant = await getGrantByToken(env, parsed.token);
  const email = parsed.email.toLowerCase();

  // A grant addressed to one person is not a link anyone may use.
  if (grant.email && grant.email !== email) {
    throw new AuthError('This link was issued to a different email address.', 403, 'forbidden');
  }

  if (grant.require_verification) {
    await issueVerificationCode(env, grant, email);
    return { status: 'verify', email };
  }

  await touchGrant(env, grant.id);
  return { status: 'ready', session: sessionFor(grant, email, parsed.name, false) };
}

/** Step two, when the grant demands proof of the address. */
export async function verifyGrant(env: Env, input: unknown): Promise<GuestSession> {
  const parsed = verifySchema.parse(input);
  const grant = await getGrantByToken(env, parsed.token);
  const email = parsed.email.toLowerCase();

  const row = await env.DB.prepare(
    `SELECT * FROM verification_codes
      WHERE grant_id = ? AND email = ? AND consumed_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(grant.id, email)
    .first<{ id: string; code_hash: string; attempts: number; expires_at: string }>();

  if (!row) throw new AuthError('Request a new code.', 401, 'unauthorized');
  if (Date.parse(row.expires_at) < Date.now()) throw new AuthError('That code has expired.', 401, 'unauthorized');
  if (row.attempts >= MAX_VERIFICATION_ATTEMPTS) {
    throw new DocsError('Too many attempts — request a new code.', 429, 'rate_limited');
  }

  const matches = await constantTimeEqual(await sha256Hex(`${grant.id}:${email}:${parsed.code}`), row.code_hash);
  if (!matches) {
    await env.DB.prepare(`UPDATE verification_codes SET attempts = attempts + 1 WHERE id = ?`).bind(row.id).run();
    throw new AuthError('That code is not right.', 401, 'unauthorized');
  }

  await env.DB.batch([
    env.DB.prepare(`UPDATE verification_codes SET consumed_at = ? WHERE id = ?`).bind(new Date().toISOString(), row.id),
    env.DB.prepare(`UPDATE grants SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?`).bind(
      new Date().toISOString(),
      grant.id,
    ),
  ]);

  return sessionFor(grant, email, undefined, true);
}

async function issueVerificationCode(env: Env, grant: GrantRow, email: string): Promise<void> {
  const code = numericCode(6);
  await env.DB.prepare(
    `INSERT INTO verification_codes (id, grant_id, email, code_hash, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(
      uuid(),
      grant.id,
      email,
      await sha256Hex(`${grant.id}:${email}:${code}`),
      new Date(Date.now() + VERIFICATION_TTL_MINUTES * 60_000).toISOString(),
    )
    .run();

  await sendMail(env, {
    to: email,
    subject: `Your Envisioning Docs code: ${code}`,
    text:
      `Your verification code is ${code}.\n\n` +
      `It expires in ${VERIFICATION_TTL_MINUTES} minutes. If you did not request it, ignore this message.`,
  });
}

async function touchGrant(env: Env, id: string): Promise<void> {
  await env.DB.prepare(`UPDATE grants SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?`)
    .bind(new Date().toISOString(), id)
    .run();
}

function sessionFor(grant: GrantRow, email: string, name: string | undefined, verified: boolean): GuestSession {
  return {
    grantId: grant.id,
    email,
    ...(name ? { name } : {}),
    role: grant.role,
    documentId: grant.document_id,
    folderId: grant.folder_id,
    verified,
  };
}

export function shareURL(env: Env, token: string): string {
  return `${env.WEB_ORIGIN}/d/${token}`;
}

function toSummary(row: GrantRow, env: Env): GrantSummary {
  return {
    id: row.id,
    document_id: row.document_id,
    folder_id: row.folder_id,
    url: shareURL(env, row.token),
    email: row.email,
    role: row.role,
    label: row.label,
    require_verification: row.require_verification === 1,
    created_by: row.created_by,
    created_at: row.created_at,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    last_used_at: row.last_used_at,
    use_count: row.use_count,
  };
}

/** Does this guest session reach this document? */
export async function guestCanReach(env: Env, guest: GuestSession, documentId: string, documentPath: string): Promise<boolean> {
  if (guest.documentId === documentId) return true;
  if (!guest.folderId) return false;
  const folder = await env.DB.prepare(`SELECT path FROM folders WHERE id = ?`)
    .bind(guest.folderId)
    .first<{ path: string }>();
  if (!folder) return false;
  return documentPath.startsWith(`${folder.path}/`);
}
