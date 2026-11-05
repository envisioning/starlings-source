// Guests (docs/ACCESS.md slice 4, decided 2026-10-04).
//
// A guest is somebody outside the workspace whom a `manage` holder granted
// on a subject. The grant is a `subject_grants` row with
// `principal_kind = 'guest'` and the guest's address as `principal_id`; its
// link is a random secret whose SHA-256 sits on that row (migration 0080).
//
// - **The link** is exchanged once per visit for a guest session: a JWT with
//   its own audience (`meet-guest`) in a host-only cookie. It never becomes
//   a member session, and no member route reads it.
// - **Every request re-reads the live grants.** The JWT says who the guest
//   is; the grant rows say what they reach, now. Revoking a grant closes it
//   on the guest's next request, whatever the JWT's lifetime.
// - **The guest thread** is one per subject (`kind = 'guest'`, parent
//   `<kind>:<id>`), shared by members and the subject's guests. The
//   subject's own channel stays members only.
// - **Read and post text.** No attachments, reactions, edits or withdrawals.
//
// Guests reach these functions only through `routes/guest.ts`, a path of its
// own: never through `threads.ts`'s member entry points.

import { SignJWT } from 'jose';
import type { GuestHomeResponse, GuestMessagesResponse, GuestSubject } from '@starlings/contracts/subject-access';
import { isSubjectKind, type SubjectKind } from '@starlings/contracts/subject-kinds';
import { fetchCrmSubject, idKind, workModelEnabled } from './crm';
import { randomToken, sha256 } from './crypto';
import { ControlError } from './errors';
import { cookie, expiredCookie, readCookie } from './http-cookies';
import { ACCEPTED_SESSION_ISSUERS, SESSION_ISSUER, signSessionJwt, verifySessionJwt } from './session-keys';
import { GUEST_THREAD_MACHINE_TURNS_PER_DAY } from '@starlings/contracts/limits';
import { appendInboundMessage, threadStub } from './threads';
import { workspaceDisplayName } from './workspace-profile';

export const GUEST_COOKIE = 'meet_guest';
/** How long one visit's session lasts. Revocation does not wait for it: every request re-reads the grants. */
const GUEST_SESSION_SECONDS = 30 * 24 * 60 * 60;
const GUEST_AUDIENCE = 'meet-guest';

/**
 * Somebody outside the workspace on a guest thread: a guest by their address
 * (slice 4), or a peer organization through its token (slice 5). `sub` and
 * `email` are what their lines carry; `name` is what members read.
 */
export interface GuestSession {
  sub: string;
  email: string;
  name: string;
  /** `kind:id` → the live grant and, for intake contacts, its private thread. */
  grants: Map<string, { role: 'read' | 'write'; threadId: string | null }>;
}

const keyOf = (kind: string, id: string) => `${kind}:${id}`;

/** The sender id a guest's lines carry. Deterministic, so a returning guest is the same sender. */
export function guestSub(email: string): string {
  return `guest:${email}`;
}

/** A new link secret and the hash the grant row keeps. */
export async function mintGuestLink(): Promise<{ token: string; hash: string }> {
  const token = randomToken(32);
  return { token, hash: await sha256(token) };
}

export function guestLinkURL(env: Pick<Env, 'WEB_ORIGIN'>, token: string): string {
  return `${env.WEB_ORIGIN.replace(/\/$/u, '')}/guest/${token}`;
}

/** A subject's guest thread id: derived, so there is one per subject. */
export async function guestThreadId(kind: SubjectKind, subjectId: string): Promise<string> {
  const digest = await sha256(`guest:${idKind(kind)}:${subjectId}`);
  return `gst_${digest.slice(0, 32)}`;
}

/**
 * The guest thread's Durable Object and index row, made to exist. Members
 * see it in their thread list under the subject's title; whether a member
 * may is the subject's visibility, in the thread SQL (`subjectHiddenSql`).
 */
export async function ensureGuestThread(env: Env, kind: SubjectKind, subjectId: string, subjectTitle: string): Promise<string> {
  const id = await guestThreadId(kind, subjectId);
  const parentId = keyOf(kind, subjectId);
  const title = `${subjectTitle} · guests`;
  await threadStub(env, id).ensureThread({ id, kind: 'guest', parentId, audience: 'everyone', members: [] });
  await env.USAGE.prepare(
    `INSERT INTO threads (id, kind, parent_id, created_at, title, audience)
     VALUES (?1, 'guest', ?2, ?3, ?4, 'everyone')
       ON CONFLICT(id) DO UPDATE SET title = ?4, removed_at = NULL, removed_by = NULL`,
  ).bind(id, parentId, Date.now(), title).run();
  return id;
}

/** The subject a guest thread belongs to, from its index row; null for any other thread. */
export async function guestThreadSubject(env: Env, threadId: string): Promise<{ kind: SubjectKind; id: string } | null> {
  const row = await env.USAGE.prepare(`SELECT parent_id FROM threads WHERE id = ?1 AND kind = 'guest' AND removed_at IS NULL`)
    .bind(threadId)
    .first<{ parent_id: string | null }>();
  return parseGuestParent(row?.parent_id ?? null);
}

/** `<kind>:<id>` back into a subject key. */
export function parseGuestParent(parentId: string | null): { kind: SubjectKind; id: string } | null {
  if (!parentId) return null;
  const at = parentId.indexOf(':');
  const kind = parentId.slice(0, at);
  const id = parentId.slice(at + 1);
  return at > 0 && id && isSubjectKind(kind) ? { kind, id } : null;
}

/** The live grants of one outside principal, read now. A `manage` grant is never an outside one's. */
export async function liveOutsideGrants(env: Env, kind: 'guest' | 'peer_workspace', principalId: string): Promise<Map<string, { role: 'read' | 'write'; threadId: string | null }>> {
  let rows: Array<{ kind: string; subject_id: string; role: string; thread_id: string | null }>;
  try {
    ({ results: rows } = await env.USAGE.prepare(
      `SELECT kind, subject_id, role, thread_id FROM subject_grants
        WHERE principal_kind = ?1 AND principal_id = ?2 AND revoked_at IS NULL`,
    ).bind(kind, principalId).all<{ kind: string; subject_id: string; role: string; thread_id: string | null }>());
  } catch {
    throw new ControlError('The access store could not be read.', 503);
  }
  const grants = new Map<string, { role: 'read' | 'write'; threadId: string | null }>();
  for (const row of rows ?? []) {
    if (row.role === 'read' || row.role === 'write') {
      grants.set(keyOf(row.kind, row.subject_id), { role: row.role, threadId: row.thread_id });
    }
  }
  return grants;
}

/**
 * Spend a link: the live guest grant whose hash it is names the guest. The
 * same answer for an unknown, revoked or malformed link, so a link's state
 * is not something to probe.
 */
export async function exchangeGuestLink(env: Env, token: string): Promise<{ email: string; setCookie: string }> {
  const hash = await sha256(token.trim());
  const row = await env.USAGE.prepare(
    `SELECT principal_id FROM subject_grants
      WHERE link_hash = ?1 AND principal_kind = 'guest' AND revoked_at IS NULL`,
  ).bind(hash).first<{ principal_id: string }>();
  if (!row) throw new ControlError('This link no longer opens anything.', 404, 'link_expired');
  const jwt = await signSessionJwt(new SignJWT({ email: row.principal_id })
    .setIssuer(SESSION_ISSUER)
    .setAudience(GUEST_AUDIENCE)
    .setSubject(guestSub(row.principal_id))
    .setIssuedAt()
    .setExpirationTime(`${GUEST_SESSION_SECONDS}s`), env);
  return { email: row.principal_id, setCookie: cookie(GUEST_COOKIE, jwt, GUEST_SESSION_SECONDS) };
}

export function endGuestSessionCookie(): string {
  return expiredCookie(GUEST_COOKIE);
}

/** The guest behind this request, with what they reach now. 401 `link_expired` when there is none. */
export async function requireGuest(request: Request, env: Env): Promise<GuestSession> {
  const token = readCookie(request, GUEST_COOKIE);
  const refused = () => new ControlError('Open your link again.', 401, 'link_expired');
  if (!token) throw refused();
  let email: string;
  try {
    const { payload } = await verifySessionJwt(token, env, { issuer: ACCEPTED_SESSION_ISSUERS, audience: GUEST_AUDIENCE });
    if (typeof payload.email !== 'string' || payload.sub !== guestSub(payload.email)) throw refused();
    email = payload.email;
  } catch {
    throw refused();
  }
  const grants = await liveOutsideGrants(env, 'guest', email);
  if (grants.size === 0) throw refused();
  return { sub: guestSub(email), email, name: email, grants };
}

export async function guestHome(env: Env, guest: GuestSession): Promise<GuestHomeResponse> {
  const subjects: GuestSubject[] = [];
  for (const [key, grant] of guest.grants) {
    const subject = parseGuestParent(key);
    if (!subject) continue;
    if (grant.threadId) {
      const row = await env.USAGE.prepare(
        `SELECT id, title FROM threads
          WHERE id = ?1 AND kind = 'guest' AND parent_id = ?2 AND removed_at IS NULL`,
      ).bind(grant.threadId, key).first<{ id: string; title: string | null }>();
      if (!row) continue;
      subjects.push({
        ...subject,
        title: (row.title ?? 'Contact').replace(/ · guests$/u, ''),
        thread_id: row.id,
        can_post: grant.role === 'write',
      });
      continue;
    }
    const found = workModelEnabled(env) ? await fetchCrmSubject(env, subject.kind, subject.id) : null;
    if (!found) continue;
    subjects.push({
      kind: subject.kind,
      id: subject.id,
      title: found.title,
      thread_id: await ensureGuestThread(env, subject.kind, subject.id, found.title),
      can_post: grant.role === 'write',
    });
  }
  return { email: guest.email, workspace: await workspaceDisplayName(env), subjects };
}

/** The subject a guest may reach through this thread, or a 404 that does not say why. */
export async function guestThreadAccess(env: Env, guest: GuestSession, threadId: string): Promise<'read' | 'write'> {
  const subject = await guestThreadSubject(env, threadId);
  const grant = subject ? guest.grants.get(keyOf(subject.kind, subject.id)) : undefined;
  if (!grant || (grant.threadId !== null && grant.threadId !== threadId)) {
    throw new ControlError('Conversation not found.', 404, 'room_not_found');
  }
  return grant.role;
}

export async function readGuestThread(
  env: Env,
  guest: GuestSession,
  threadId: string,
  before: string | undefined,
): Promise<GuestMessagesResponse> {
  await guestThreadAccess(env, guest, threadId);
  const page = await threadStub(env, threadId).messages(guest.sub, { before, limit: 50 });
  return {
    // Text lines only, by name: a guest never sees a member's address, and a
    // withdrawn line stays withdrawn.
    messages: page.messages
      .filter((message) => message.type === 'text' && message.deleted_at === undefined)
      .map((message) => ({
        id: message.id,
        sender_name: message.sender_name ?? message.sender_email.split('@')[0] ?? '',
        mine: message.sender_email === guest.email,
        text: message.text,
        sent_at: message.sent_at,
      })),
    older_cursor: page.olderCursor,
  };
}

export async function postGuestMessage(
  env: Env,
  guest: GuestSession,
  threadId: string,
  text: string,
  author?: string,
  replyToMessageId?: string,
): Promise<string> {
  const role = await guestThreadAccess(env, guest, threadId);
  if (role !== 'write') throw new ControlError('This conversation is read-only for you.', 403, 'subject_access_denied');
  // A peer organization writes through its Claude: a machine turn. A guest is a person.
  if (guest.sub.startsWith('peer:')) await takeMachineTurn(env, threadId);
  const messageId = `msg_${randomToken(16)}`;
  await appendInboundMessage(env, {
    threadId,
    messageId,
    // A peer organization may name the person who wrote (the support line,
    //): information only, the authority stays the organization's.
    sender: { sub: guest.sub, email: guest.email, name: author ? `${author} (${guest.name})` : guest.name },
    // Tagged where it is stored, so every reader (a member's client, our
    // agents through `/mcp`) knows the line came from outside.
    origin: { kind: guest.sub.startsWith('peer:') ? 'peer' : 'guest', ref: guest.sub },
    text,
    type: 'text',
    refs: [],
    ...(replyToMessageId ? { replyToMessageId } : {}),
  });
  return messageId;
}

/**
 * Spend one of a guest thread's machine turns for today (migration 0082):
 * a line a peer organization or one of our agents writes there. Past the
 * budget it is a 429, so two machines answering each other stop for the day.
 */
export async function takeMachineTurn(env: Env, threadId: string): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const taken = await env.USAGE.prepare(
    `INSERT INTO machine_turns (thread_id, day, count) VALUES (?1, ?2, 1)
     ON CONFLICT (thread_id, day) DO UPDATE SET count = count + 1 WHERE count < ?3`,
  ).bind(threadId, day, GUEST_THREAD_MACHINE_TURNS_PER_DAY).run();
  if ((taken.meta.changes ?? 0) === 0) {
    throw new ControlError('This thread has reached today\'s limit for messages from agents and organizations.', 429, 'rate_limited');
  }
}

/** True for a guest thread: the one place machine turns are counted. */
export async function isGuestThread(env: Env, threadId: string): Promise<boolean> {
  return (await guestThreadSubject(env, threadId)) !== null;
}
