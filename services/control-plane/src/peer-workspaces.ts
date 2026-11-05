// Peer organizations (docs/ACCESS.md slice 5, decided 2026-10-04).
//
// A peer is another company, as a row of the work model's own
// `organizations` table (migration 0073), never a CRM row. It holds one
// credential (`peer_credentials`, migration 0081): a token whose SHA-256 is
// stored, shown once. Each subject shared with it is a `subject_grants` row
// with `principal_kind = 'peer_workspace'` and the organization id, and what
// it reaches on that subject is the subject's guest thread, as a guest does.
//
// Tier 2 only (FEDERATION.md §4): the peer's own Claude, or any MCP client,
// uses the token at this workspace's `/mcp` (peer-mcp.ts). No second Meet,
// no proxy, no consent page.

import type { OwnerSession } from './contracts';
import type {
  PeerWorkspace,
  PeerWorkspacesResponse,
  PeerWorkspaceTokenResponse,
  SubjectGrantUpdate,
} from '@starlings/contracts/subject-access';
import { recordAdminAction } from './admin-audit';
import type { RoleSession } from './capabilities';
import { fetchCrmSubject, workModelEnabled } from './crm';
import { randomToken, sha256 } from './crypto';
import { ControlError } from './errors';
import { ensureGuestThread, liveOutsideGrants, type GuestSession } from './guests';
import { d1CreateOrganization } from './work-d1';

/** Every peer token starts so; `/mcp` tells a peer's call from a member's by it. */
export const PEER_TOKEN_PREFIX = 'stp_';

interface SubjectKey { kind: 'project' | 'lead' | 'organization' | 'event'; id: string }

export function peerMcpURL(env: Pick<Env, 'PUBLIC_API_ORIGIN'>): string {
  return `${env.PUBLIC_API_ORIGIN.replace(/\/$/u, '')}/mcp`;
}

async function mintPeerToken(): Promise<{ token: string; hash: string }> {
  const token = `${PEER_TOKEN_PREFIX}${randomToken(32)}`;
  return { token, hash: await sha256(token) };
}

/** The sender id a peer organization's lines carry. */
export function peerSub(organizationId: string): string {
  return `peer:${organizationId}`;
}

async function organizationFor(
  env: Env,
  actorEmail: string,
  peer: Extract<SubjectGrantUpdate, { principal_kind: 'peer_workspace' }>['peer'],
): Promise<{ id: string; name: string }> {
  if ('name' in peer) return d1CreateOrganization(env, actorEmail, peer.name);
  const row = await env.USAGE.prepare('SELECT id, name FROM organizations WHERE id = ?1')
    .bind(peer.organization_id)
    .first<{ id: string; name: string }>();
  if (!row) throw new ControlError('No organization has that id.', 404, 'invalid_request');
  return row;
}

/**
 * Share a subject with a peer organization. The organization's first grant
 * mints its token, returned here once with the `/mcp` address; later grants
 * reuse it. A revoked credential stays revoked: an admin issues a new token
 * (`rotatePeerToken`) before the organization reaches anything again.
 */
export async function writePeerGrant(
  env: Env,
  session: RoleSession,
  key: SubjectKey,
  update: Extract<SubjectGrantUpdate, { principal_kind: 'peer_workspace' }>,
): Promise<{ peer_token?: string; peer_mcp_url?: string }> {
  if (update.role === 'manage') {
    throw new ControlError('A peer organization can read or post, never manage who reaches a subject.', 400, 'invalid_request');
  }
  const subject = workModelEnabled(env) ? await fetchCrmSubject(env, key.kind, key.id) : null;
  if (!subject) throw new ControlError('No such subject.', 404, 'subject_not_found');
  const organization = await organizationFor(env, session.email, update.peer);

  const credential = await env.USAGE.prepare('SELECT revoked_at FROM peer_credentials WHERE organization_id = ?1')
    .bind(organization.id)
    .first<{ revoked_at: number | null }>();
  if (credential?.revoked_at != null) {
    throw new ControlError('This organization\'s access was revoked. An admin issues it a new token first.', 409, 'access_change_refused');
  }
  const now = Date.now();
  const minted = credential ? null : await mintPeerToken();
  await env.USAGE.batch([
    ...(minted
      ? [env.USAGE.prepare(
        `INSERT INTO peer_credentials (organization_id, token_hash, created_by, created_at)
         VALUES (?1, ?2, ?3, ?4)`,
      ).bind(organization.id, minted.hash, session.sub, now)]
      : []),
    env.USAGE.prepare(
      `UPDATE subject_grants SET role = ?4
       WHERE kind = ?1 AND subject_id = ?2 AND principal_kind = 'peer_workspace' AND principal_id = ?3 AND revoked_at IS NULL`,
    ).bind(key.kind, key.id, organization.id, update.role),
    env.USAGE.prepare(
      `INSERT INTO subject_grants (id, kind, subject_id, principal_kind, principal_id, role, granted_by, granted_at)
       VALUES (?1, ?2, ?3, 'peer_workspace', ?4, ?5, ?6, ?7)
       ON CONFLICT DO NOTHING`,
    ).bind(crypto.randomUUID(), key.kind, key.id, organization.id, update.role, session.sub, now),
  ]);
  await ensureGuestThread(env, key.kind, key.id, subject.title);
  await recordAdminAction(env, session, 'subject.grant', `${key.kind}:${key.id}`, `peer_workspace:${organization.name}:${update.role}`);
  return minted ? { peer_token: minted.token, peer_mcp_url: peerMcpURL(env) } : {};
}

interface PeerRow {
  organization_id: string;
  name: string;
  created_at: number;
  revoked_at: number | null;
  subjects: number;
}

const PEER_SELECT = `
  SELECT c.organization_id, o.name, c.created_at, c.revoked_at,
         (SELECT COUNT(*) FROM subject_grants g
           WHERE g.principal_kind = 'peer_workspace' AND g.principal_id = c.organization_id AND g.revoked_at IS NULL) AS subjects
    FROM peer_credentials c JOIN organizations o ON o.id = c.organization_id`;

function toPeer(row: PeerRow): PeerWorkspace {
  return { organization_id: row.organization_id, name: row.name, created_at: row.created_at, revoked_at: row.revoked_at, subjects: row.subjects };
}

/** `GET /api/peer-workspaces`: every peer organization and how many subjects it holds. */
export async function listPeerWorkspaces(env: Env): Promise<PeerWorkspacesResponse> {
  const { results } = await env.USAGE.prepare(`${PEER_SELECT} ORDER BY o.name COLLATE NOCASE`).all<PeerRow>();
  return { peers: (results ?? []).map(toPeer) };
}

async function peerRow(env: Env, organizationId: string): Promise<PeerWorkspace> {
  const row = await env.USAGE.prepare(`${PEER_SELECT} WHERE c.organization_id = ?1`).bind(organizationId).first<PeerRow>();
  if (!row) throw new ControlError('No peer organization has that id.', 404, 'invalid_request');
  return toPeer(row);
}

/** An admin closes everything an organization reaches, at once. Its grants stay, inert, for the record. */
export async function revokePeerCredential(env: Env, admin: OwnerSession, organizationId: string): Promise<PeerWorkspace> {
  const peer = await peerRow(env, organizationId);
  await env.USAGE.prepare('UPDATE peer_credentials SET revoked_at = ?2, token_hash = NULL WHERE organization_id = ?1 AND revoked_at IS NULL')
    .bind(organizationId, Date.now())
    .run();
  await recordAdminAction(env, admin, 'peer.revoke', organizationId, peer.name);
  return peerRow(env, organizationId);
}

/** An admin issues a new token, shown once. The old one stops at once; a revoked organization is live again. */
export async function rotatePeerToken(env: Env, admin: OwnerSession, organizationId: string): Promise<PeerWorkspaceTokenResponse> {
  await peerRow(env, organizationId);
  const minted = await mintPeerToken();
  await env.USAGE.prepare('UPDATE peer_credentials SET token_hash = ?2, revoked_at = NULL WHERE organization_id = ?1')
    .bind(organizationId, minted.hash)
    .run();
  const peer = await peerRow(env, organizationId);
  await recordAdminAction(env, admin, 'peer.token', organizationId, peer.name);
  return { peer, peer_token: minted.token, peer_mcp_url: peerMcpURL(env) };
}

/**
 * The peer behind a token, as the outside session the guest-thread code
 * reads: its live grants now. Null for an unknown or revoked token.
 */
export async function peerSessionForToken(env: Env, token: string): Promise<GuestSession | null> {
  const row = await env.USAGE.prepare(
    `SELECT c.organization_id, o.name FROM peer_credentials c JOIN organizations o ON o.id = c.organization_id
      WHERE c.token_hash = ?1 AND c.revoked_at IS NULL`,
  ).bind(await sha256(token)).first<{ organization_id: string; name: string }>();
  if (!row) return null;
  const sub = peerSub(row.organization_id);
  return { sub, email: sub, name: row.name, grants: await liveOutsideGrants(env, 'peer_workspace', row.organization_id) };
}
