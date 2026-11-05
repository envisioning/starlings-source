// Invitations (meet#873): an admin invites an address with a role; signing in
// with an open invitation writes the people row and the room in one write and
// spends the invitation; a revoked or lapsed invitation admits nobody; the
// session gate admits an outside address only through an accepted invitation.
import { env, exports } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { AUTH_HANDOFF_VERSION, CENTRAL_AUTH_COMPLETE_PATHS, type CentralAuthResult } from '@starlings/contracts/browser-auth';
import { INVITATION_TTL_MILLISECONDS } from '@starlings/contracts/invitations';
import { claimAttempt, finishAttempt } from '../src/auth-worker/attempts';
import type { AuthEnv } from '../src/auth-worker/env';
import { AuthService } from '../src/auth-worker/index';
import { completeCentralWebAuth, signOwnerSession } from '../src/auth';
import { beginCentralAuth } from '../src/central-auth';
import { resetRoleCache } from '../src/capabilities';
import {
  acceptOpenInvitation,
  inviteMembers,
  listInvitations,
  isWorkspaceMember,
  mayJoin,
  resendInvitation,
  revokeInvitation,
} from '../src/invitations';
import { checkMember } from '../src/member-service';
import { isPublicRoom } from '../src/member-rooms';

const hq = 'https://hq.starlings.example';
const auth = 'https://auth.starlings.example';
const authEnv: AuthEnv = {
  AUTH_DB: (env as unknown as { AUTH_DB: D1Database }).AUTH_DB,
  ENVIRONMENT: 'development',
  AUTH_ORIGIN: auth,
  RETURN_ORIGIN_ALIASES: '',
  GOOGLE_WEB_CLIENT_ID: 'test-web',
  GOOGLE_CONNECTOR_CLIENT_ID: 'test-connector',
  AUTH_SIGNING_SECRET: 'auth-test-signing-secret-with-at-least-32-characters',
  GOOGLE_WEB_CLIENT_SECRET: 'test-web-secret',
  MAIL_FROM: 'Starlings <hello@starlings.example>',
  OPS_ALERT_EMAIL: 'ops@example.net',
  SIGNUP_ORIGIN: 'https://site.example',
  OPS_ORIGIN: 'https://ops.starlings.example',
};
function binding() {
  const service = new AuthService({ props: { origin: hq } } as unknown as ExecutionContext, authEnv);
  return {
    begin: async (input: unknown) => structuredClone(await service.begin(structuredClone(input))),
    redeem: async (input: unknown) => structuredClone(await service.redeem(structuredClone(input))),
  };
}
const hqEnv = {
  ...env, GOOGLE_WEB_CLIENT_ID: 'test-web', AUTH_ORIGIN: auth, AUTH: binding(), WEB_ORIGIN: hq, PUBLIC_API_ORIGIN: hq,
  WORKSPACE_ORIGIN_ALIASES: '', WORKSPACE_NAME: 'HQ',
} as unknown as Env;
const workerEnv = env as Env;
const admin = { sub: 'google-sub-rosa', email: 'rosa@example.com', name: 'Rosa Ortiz' };
const outsider: Extract<CentralAuthResult, { kind: 'login' }> = { kind: 'login', sub: 'google-ana', email: 'ana@example.net', name: 'Ana Silva' };
const cookieHeader = (response: Response) => response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');

/** A finished central sign-in for `person`, ready to complete on hq. */
async function signIn(person: CentralAuthResult, workspace: Env = hqEnv): Promise<Response> {
  const started = await beginCentralAuth(new Request(`${hq}/start`), workspace, 'login', { returnTo: '/' });
  const ticket = new URL(started.headers.get('location')!).searchParams.get('ticket')!;
  expect(await claimAttempt(authEnv, ticket)).not.toBeNull();
  const code = await finishAttempt(authEnv, ticket, person);
  const complete = new URL(CENTRAL_AUTH_COMPLETE_PATHS.login, hq);
  complete.searchParams.set('ticket', ticket);
  complete.searchParams.set('code', code!);
  const ctx = createExecutionContext();
  try {
    return await completeCentralWebAuth(new Request(complete, { headers: { cookie: cookieHeader(started) } }), workspace, ctx);
  } finally {
    await waitOnExecutionContext(ctx);
  }
}

afterEach(async () => {
  resetRoleCache();
  await workerEnv.USAGE.batch([
    workerEnv.USAGE.prepare('DELETE FROM invitations'),
    workerEnv.USAGE.prepare('DELETE FROM rooms'),
    workerEnv.USAGE.prepare('DELETE FROM people'),
  ]);
});

describe('inviting', () => {
  it('invites each address once with a role, renews a second invite, and audits it', async () => {
    const first = await inviteMembers(workerEnv, admin, { emails: ['Ana@Example.net', 'ana@example.net', 'joao@example.net'], role: 'admin' });
    expect(first.invitations.map((row) => [row.email, row.role, row.state])).toEqual([
      ['ana@example.net', 'admin', 'pending'], ['joao@example.net', 'admin', 'pending'],
    ]);
    const second = await inviteMembers(workerEnv, admin, { emails: ['ana@example.net'], role: 'member' });
    expect(second.invitations[0]?.id).toBe(first.invitations[0]?.id);
    expect(second.invitations[0]?.role).toBe('member');
    expect((await listInvitations(workerEnv)).invitations).toHaveLength(2);
    const audit = await workerEnv.USAGE.prepare(`SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'invitation.send' AND subject IN ('ana@example.net', 'joao@example.net')`).first<{ n: number }>();
    expect(audit?.n).toBe(3);
  });

  it('refuses a member, a revoked person and an agent by name', async () => {
    await workerEnv.USAGE.batch([
      workerEnv.USAGE.prepare(`INSERT INTO people (sub, email, name, first_seen_at, last_seen_at) VALUES ('a', 'in@example.com', 'In', 1, 1)`),
      workerEnv.USAGE.prepare(`INSERT INTO people (sub, email, name, first_seen_at, last_seen_at, revoked_at) VALUES ('b', 'out@example.net', 'Out', 1, 1, 5)`),
      workerEnv.USAGE.prepare(`INSERT INTO people (sub, email, name, first_seen_at, last_seen_at, kind) VALUES ('c', 'bot@example.com', 'Bot', 1, 1, 'agent')`),
    ]);
    const result = await inviteMembers(workerEnv, admin, { emails: ['in@example.org', 'out@example.net', 'bot@example.com'], role: 'member' });
    expect(result.invitations).toEqual([]);
    expect(result.refused).toEqual([
      { email: 'in@example.org', reason: 'member' },
      { email: 'out@example.net', reason: 'revoked' },
      { email: 'bot@example.com', reason: 'agent' },
    ]);
  });

  it('refuses a malformed address or role at the boundary', async () => {
    await expect(inviteMembers(workerEnv, admin, { emails: ['not an address'], role: 'member' })).rejects.toThrow();
    await expect(inviteMembers(workerEnv, admin, { emails: ['a@example.net'], role: 'community' })).rejects.toThrow();
    await expect(inviteMembers(workerEnv, admin, { emails: [], role: 'member' })).rejects.toThrow();
  });

  it('resends with a new 14 days, and revokes', async () => {
    const now = 1_800_000_000_000;
    const { invitations: [row] } = await inviteMembers(workerEnv, admin, { emails: ['ana@example.net'], role: 'member' }, now);
    const later = now + INVITATION_TTL_MILLISECONDS + 1;
    expect((await listInvitations(workerEnv, later)).invitations[0]?.state).toBe('lapsed');
    const resent = await resendInvitation(workerEnv, admin, { id: row!.id }, later);
    expect(resent.invitation.expires_at).toBe(later + INVITATION_TTL_MILLISECONDS);
    expect(resent.invitation.state).toBe('pending');
    await revokeInvitation(workerEnv, admin, { id: row!.id }, later);
    expect((await listInvitations(workerEnv, later)).invitations).toEqual([]);
    await expect(revokeInvitation(workerEnv, admin, { id: row!.id }, later)).rejects.toThrow('no longer open');
  });

  it('answers the admin routes to an admin only', async () => {
    const token = await signOwnerSession({ sub: 'google-sub-ada', email: 'ada@example.com', name: 'Ada' }, workerEnv, { lastClient: 'web' });
    const response = await exports.default.fetch(new Request('http://local/api/admin/invitations', { headers: { authorization: `Bearer ${token}` } }));
    expect(response.status).toBe(403);
  });
});

describe('accepting at sign-in', () => {
  it('admits an invited outside address with the invited role, its room, and spends the invitation', async () => {
    await inviteMembers(workerEnv, admin, { emails: [outsider.email], role: 'admin' });
    const response = await signIn(outsider);
    expect(response.headers.getSetCookie()[0]).toMatch(/^meet_session=/u);
    const person = await workerEnv.USAGE.prepare('SELECT role, room_slug FROM people WHERE sub = ?1').bind(outsider.sub).first();
    expect(person).toEqual({ role: 'admin', room_slug: 'ana-silva' });
    expect(await isPublicRoom(workerEnv, 'ana-silva')).toBe(true);
    const spent = await workerEnv.USAGE.prepare('SELECT accepted_at FROM invitations WHERE email = ?1').bind(outsider.email).first<{ accepted_at: number | null }>();
    expect(spent?.accepted_at).not.toBeNull();
    // The session works on a guarded route, and again after the invitation is spent.
    const cookie = cookieHeader(response);
    const me = await exports.default.fetch(new Request('http://local/api/admin/overview', { headers: { cookie } }));
    expect(me.status).toBe(200);
    expect(await signIn(outsider)).toBeInstanceOf(Response);
  });

  it('refuses an uninvited outside address', async () => {
    await expect(signIn(outsider)).rejects.toThrow('Only a verified Google account on this workspace');
    expect(await workerEnv.USAGE.prepare('SELECT 1 FROM people WHERE sub = ?1').bind(outsider.sub).first()).toBeNull();
  });

  it('admits nobody on a revoked or a lapsed invitation', async () => {
    const now = Date.now();
    const { invitations: [row] } = await inviteMembers(workerEnv, admin, { emails: [outsider.email], role: 'member' });
    await revokeInvitation(workerEnv, admin, { id: row!.id });
    await expect(signIn(outsider)).rejects.toThrow('Only a verified Google account on this workspace');
    await inviteMembers(workerEnv, admin, { emails: [outsider.email], role: 'member' }, now - INVITATION_TTL_MILLISECONDS - 1);
    expect(await mayJoin(workerEnv, outsider.email)).toBe(false);
    await expect(signIn(outsider)).rejects.toThrow('Only a verified Google account on this workspace');
    expect(await acceptOpenInvitation(workerEnv, outsider)).toBe(false);
    expect((await workerEnv.USAGE.prepare('SELECT COUNT(*) AS n FROM rooms').first<{ n: number }>())?.n).toBe(0);
  });

  it('cuts off an outside session whose person is revoked', async () => {
    await inviteMembers(workerEnv, admin, { emails: [outsider.email], role: 'member' });
    const cookie = cookieHeader(await signIn(outsider));
    await workerEnv.USAGE.prepare('UPDATE people SET revoked_at = 1 WHERE sub = ?1').bind(outsider.sub).run();
    resetRoleCache();
    const me = await exports.default.fetch(new Request('http://local/api/admin/overview', { headers: { cookie } }));
    expect(me.status).toBe(401);
  });

  it('refuses an outside session with no accepted invitation behind it', async () => {
    const token = await signOwnerSession({ sub: 'stray', email: 'stray@example.net', name: 'Stray' }, workerEnv, { lastClient: 'web' });
    const me = await exports.default.fetch(new Request('http://local/api/admin/overview', { headers: { authorization: `Bearer ${token}` } }));
    expect(me.status).toBe(401);
  });

  it('gives a domain member the invited role', async () => {
    await inviteMembers(workerEnv, admin, { emails: ['ada@example.com'], role: 'admin' });
    await signIn({ kind: 'login', sub: 'google-ada', email: 'ada@example.com', name: 'Ada Lovelace', hd: 'example.com' });
    const person = await workerEnv.USAGE.prepare('SELECT role, room_slug FROM people WHERE sub = ?1').bind('google-ada').first();
    expect(person).toEqual({ role: 'admin', room_slug: 'ada-lovelace' });
  });
});

// "Only people I invite" (meet#1148): the domain says who is one of us, and admits only a root admin.
describe('an invite-only workspace', () => {
  const inviteEnv = { ...hqEnv, WORKSPACE_MEMBERSHIP: 'invite', ROOT_ADMIN_EMAILS: admin.email } as unknown as Env;
  const inviteWorker = { ...workerEnv, WORKSPACE_MEMBERSHIP: 'invite', ROOT_ADMIN_EMAILS: admin.email } as unknown as Env;
  const colleague: CentralAuthResult = { kind: 'login', sub: 'google-ada', email: 'ada@example.com', name: 'Ada Lovelace', hd: 'example.com' };

  it('refuses an uninvited address at the domain, and admits the root admin', async () => {
    await expect(signIn(colleague, inviteEnv)).rejects.toThrow('Only a verified Google account on this workspace');
    expect(await isWorkspaceMember(inviteWorker, 'ada@example.com')).toBe(false);
    expect(await checkMember(inviteWorker, { v: AUTH_HANDOFF_VERSION, sub: 'google-ada', email: 'ada@example.com', hd: 'example.com' })).toEqual({ ok: false, reason: 'not_member' });
    const owner = await signIn({ kind: 'login', ...admin, hd: 'example.com' }, inviteEnv);
    expect(owner.headers.getSetCookie()[0]).toMatch(/^meet_session=/u);
    expect(await checkMember(inviteWorker, { v: AUTH_HANDOFF_VERSION, sub: admin.sub, email: admin.email, hd: 'example.com' })).toEqual({ ok: true });
  });

  it('admits an invited address at the domain and outside it', async () => {
    await inviteMembers(inviteWorker, admin, { emails: ['ada@example.com', outsider.email], role: 'member' });
    expect((await signIn(colleague, inviteEnv)).headers.getSetCookie()[0]).toMatch(/^meet_session=/u);
    expect((await signIn(outsider, inviteEnv)).headers.getSetCookie()[0]).toMatch(/^meet_session=/u);
    expect(await isWorkspaceMember(inviteWorker, 'ada@example.com')).toBe(true);
  });

  it('keeps admitting the whole domain on a domains workspace', async () => {
    const domainsEnv = { ...hqEnv, WORKSPACE_MEMBERSHIP: 'domains' } as unknown as Env;
    expect((await signIn(colleague, domainsEnv)).headers.getSetCookie()[0]).toMatch(/^meet_session=/u);
  });
});
