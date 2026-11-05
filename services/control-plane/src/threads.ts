// Direct messages between Envisioning members. Envisioning-only, like presence:
// a thread is never reachable with a lobby token, a booking token, or an
// artifact principal, and a guest has no way to address one.
//
// The Worker resolves and authorizes; the Durable Object stores. D1 keeps the
// index that answers "what conversations am I in" without fanning out.

import { isMemberEmail } from './workspace-identity';
import { usesCore } from './work-store';
import { senderAddress } from './event-invite';
import { workspacePublicOrigin } from './workspace-origins';
import { queueAppIntakeReply } from './app-intake';
import { agentByEmail, answerWatchdogRetry, ensureAgentPeople, notifyAgentQuestionAnswer, notifyAgentReaction, notifyAgentRelease, notifyThreadAgents } from './agents';
import type { RoleSession } from './capabilities';
import { parseMcpChangeCursor } from '@starlings/contracts/mcp';
import { fetchCrmProjectRepos, fetchCrmSubject, idKind, workModelEnabled } from './crm';
import {
  ATTACHMENT_INLINE_CONTENT_TYPES,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_NAME_MAX_CHARS,
  type AttachmentCreateInput,
  type CalendarEventSubject,
  type CrmSubject,
  MESSAGE_PREVIEW_MAX_CHARS,
  type MessageEditResponse,
  type MessageWithdrawResponse,
  type OwnerSession,
  type SentMessageResponse,
  TEAM_THREAD_ID,
  TEAM_THREAD_TITLE,
  THREAD_EVENT_SENDER,
  THREAD_GROUP_MAX_MEMBERS,
  type ThreadArchiveResponse,
  type ThreadAudience,
  type ThreadKind,
  type ThreadMessageAttachment,
  type ThreadMessageReaction,
  type ThreadQuestion,
  type ThreadQuestionAnswerResponse,
  type ThreadReleaseRequest,
  type ThreadReleaseUpdateRequest,
  type ThreadReleaseUpdateResponse,
  type ThreadMessage,
  type ThreadMessageRef,
  type ThreadHandoff,
  type ThreadMessagesResponse,
  type ThreadMessagesSinceResponse,
  type ThreadChangesResponse,
  type ThreadMessageType,
  type ThreadMuteResponse,
  type ThreadPeer,
  type ThreadReadResponse,
  type ThreadsResponse,
  type ThreadSummary,
} from './contracts';
import { randomToken, sha256 } from './crypto';
import { idLocalPart, channelMailbox, inboundAddress, slugCandidate, slugLocalPart } from './inbound-address';
import { ControlError, ThreadError } from './errors';
import type { ReleaseCardUpdate, ThreadCoordinator } from './thread-coordinator';
import { keepEnabled, readKeepRelease } from './keep';
import { subjectOfCategory } from './meeting-category';
import { parseGuestParent, takeMachineTurn } from './guests';
import { agentsReachingThread, sessionAgentBind, subjectAccessFor, subjectHiddenSql } from './subject-access';
import { conversationVisibleSql } from './agent-boundary';
import { isSubjectKind } from '@starlings/contracts/subject-kinds';

export { subjectOfCategory } from './meeting-category';
import type { AttachmentUploadedResponse } from './contracts';
import { jurisdictionStub, threadRegion } from './do-jurisdiction';
import { recordSubjectActivity } from './subject-activity';

interface ThreadRow {
  id: string;
  kind: string;
  parent_id: string | null;
  title: string | null;
  audience: string;
  /** The channel's inbound email local part; null on a DM, or before it is minted. */
  inbound_local: string | null;
  last_message_at: number | null;
  last_message_preview: string | null;
  last_sender_email: string | null;
  last_read_at: number;
  muted_until: number | null;
  has_mention: number;
  archived_at: number | null;
}

/**
 * Every read of a conversation selects these, and the `LEFT JOIN` is the whole
 * of the audience rule: a DM needs the membership row, a channel does not, and
 * an unopened channel reads as never read rather than as missing.
 */
const THREAD_COLUMNS = `t.id, t.kind, t.parent_id, t.title, t.audience, t.inbound_local,
            t.last_message_at, t.last_message_preview, t.last_sender_email,
            COALESCE(m.last_read_at, 0) AS last_read_at,
            m.muted_until AS muted_until,
            COALESCE(m.has_mention, 0) AS has_mention,
            m.archived_at AS archived_at`;

/**
 * Deterministic, opaque thread id for a private conversation. Sorted so every
 * member derives the same one, hashed so an address never carries somebody's
 * email — a thread id travels in URLs and logs, and an email in a path is
 * personal data in a place nobody controls.
 *
 * Takes the subjects as given rather than as a set, which is what makes a group
 * and a pair one derivation: `[owner, peer]` for two people produces exactly
 * the id it always produced, and a note to self keeps its doubled subject
 * rather than collapsing into a different conversation. So groups needed no
 * migration and cannot collide with a DM that already exists.
 */
export async function directThreadId(...subs: string[]): Promise<string> {
  const digest = await sha256(`dm:${[...subs].sort().join(':')}`);
  return `dm_${digest.slice(0, 32)}`;
}

/**
 * A channel's id is derived from its subject, so opening the same project twice
 * is the same conversation and there is no way to end up with two. Hashed for
 * the same reason a DM id is: an id travels in URLs and logs, and a raw CRM key
 * in a path is company data in a place nobody controls.
 */
async function subjectThreadId(kind: 'project' | 'lead' | 'organization' | 'event', subjectId: string): Promise<string> {
  const digest = await sha256(`${idKind(kind)}:${subjectId}`);
  const prefix = kind === 'project' ? 'prj' : kind === 'lead' ? 'led' : kind === 'organization' ? 'ptn' : 'evt';
  return `${prefix}_${digest.slice(0, 32)}`;
}

/**
 * Threads are pinned to the workspace's **data region** (`threadRegion`): the
 * EU, or the US for a US workspace. A Durable Object addressed by
 * name alone lands wherever it is first touched, which is acceptable for a room
 * everybody knew they were joining and wrong for private person-to-person
 * messages between people employed in the EU.
 *
 * This has to be right before the first production thread exists: a Durable
 * Object cannot be moved between jurisdictions afterwards, so the alternative
 * to deciding now is migrating live conversations later. See docs/PRIVACY.md.
 */
/**
 * Who an event line says it is from. Envisioning, the one
 * workspace on Core, keeps `THREAD_EVENT_SENDER`, so its lines read as
 * before. Every other workspace's lines come from its own `MAIL_FROM`
 * address, else from `starlings@<its public host>`; never Envisioning's.
 */
export function threadEventSender(env: Pick<Env, 'WORK_STORE' | 'MAIL_FROM' | 'PUBLIC_WEB_ORIGIN' | 'WEB_ORIGIN'>): { sub: string; email: string; name: string } {
  if (usesCore(env)) return { ...THREAD_EVENT_SENDER };
  const configured = env.MAIL_FROM?.trim() ? senderAddress(env.MAIL_FROM).toLowerCase() : '';
  const email = configured.includes('@') ? configured : `starlings@${new URL(workspacePublicOrigin(env)).hostname}`;
  return { sub: THREAD_EVENT_SENDER.sub, email, name: THREAD_EVENT_SENDER.name };
}

export function threadStub(env: Env, threadId: string): DurableObjectStub<ThreadCoordinator> {
  return jurisdictionStub(env.THREADS, threadId, threadRegion(env), env) as DurableObjectStub<ThreadCoordinator>;
}

export async function listThreads(owner: RoleSession, env: Env): Promise<ThreadsResponse> {
  return listThreadsFor(env, owner);
}

/**
 * The same list for a session already checked — INBOX (inbox.ts) reads it
 * behind `crmWork`, which today names the same roles as `conversations`; if
 * that ever stops being true, the inbox route is what has to gain a check,
 * not this function lose one.
 */
export async function listThreadsFor(env: Env, owner: OwnerSession): Promise<ThreadsResponse> {
  // Your conversations *plus* every open channel, whether or not you have ever
  // opened one: a channel nobody has read yet still has to appear in the list,
  // which is exactly what a membership-only query cannot express.
  // An archived row stays out until something newer than the archive arrives.
  // That comparison *is* the unarchive — see
  // `migrations/0025_thread_archive.sql`. A removed channel (`removed_at`,
  //) stays out for everybody until its subject is back; this one
  // query feeds the thread list, search, INBOX, favorites, the Work rail's
  // activity and the MCP, so the filter lives here and nowhere else.
  const { results } = await env.USAGE.prepare(
    `SELECT ${THREAD_COLUMNS}
       FROM threads t
       LEFT JOIN thread_members m ON m.thread_id = t.id AND m.member_sub = ?1
      WHERE ${conversationVisibleSql('t', 'm', '?2')}
        AND (m.archived_at IS NULL OR t.last_message_at > m.archived_at)
        AND t.removed_at IS NULL
        AND NOT ${subjectHiddenSql('t.kind', 't.parent_id', '?1', '?2')}
      ORDER BY COALESCE(t.last_message_at, t.created_at) DESC
      LIMIT 200`,
  ).bind(owner.sub, sessionAgentBind(owner)).all<ThreadRow>();

  const threads = await Promise.all(results.map((row) => summarize(env, row, owner)));
  // A one-to-one nobody has spoken in is not a conversation, it is somebody
  // you clicked: opening a person's row creates the thread before the first
  // message, so without this every name you ever tapped would earn a permanent
  // row saying nothing. Filtered here rather than in SQL because "is this a
  // pair" is a question about the members, which `summarize` has already
  // answered. A group is exempt even when empty — somebody made it on purpose,
  // and unlike a pair it has no roster row to be reopened from. So is a
  // channel, which has to be joinable before anybody has spoken.
  return {
    threads: threads.filter((thread) => thread.kind !== 'dm'
      || thread.last_message_at !== null
      || (thread.peers?.length ?? 0) > 1),
  };
}

/**
 * The one company-wide channel. Find-or-create like a DM, and for the same
 * reason: there is exactly one of it, so opening it twice must be opening the
 * same conversation. It carries no CRM subject, which is what makes it the only
 * channel anybody may create without naming something it is about.
 */
export async function openTeamThread(owner: RoleSession, env: Env): Promise<ThreadSummary> {
  await ensureTeamThread(env);
  const row = await threadRow(env, TEAM_THREAD_ID, owner);
  return summarize(env, row, owner);
}

/**
 * Team's two halves made to exist. Shared by a person opening it and by an
 * import writing into it (docs/SLACK_IMPORT.md), so history can land before
 * anybody has opened the channel on this deployment.
 */
export async function ensureTeamThread(env: Env): Promise<{ id: string }> {
  const thread = threadStub(env, TEAM_THREAD_ID);
  await thread.ensureThread({ // team is seeded once.
    id: TEAM_THREAD_ID,
    kind: 'team',
    parentId: null,
    audience: 'everyone',
    // No members. Membership rows on a channel are read state, written when
    // somebody reads it, not a roster to keep in step with the company.
    members: [],
  });

  await env.USAGE.prepare(
    `INSERT INTO threads (id, kind, parent_id, created_at, title, audience)
     VALUES (?1, 'team', NULL, ?2, ?3, 'everyone')
       ON CONFLICT(id) DO NOTHING`,
  ).bind(TEAM_THREAD_ID, Date.now(), TEAM_THREAD_TITLE).run();
  return { id: TEAM_THREAD_ID };
}

/**
 * Find-or-create the private conversation with these people.
 *
 * Idempotent by construction — the id is derived from the members' subjects,
 * so naming the same people twice opens the same conversation and there is no
 * way to end up with two. That holds across sizes: two addresses derive
 * exactly the id one address always derived, so a group is not a new kind of
 * thing, it is the same conversation with more people in it.
 *
 * It is deliberately **not** a channel. It has no name and nothing to browse,
 * and its membership row is its authorization — which is why several people in
 * one private conversation costs nothing against the no-user-created-channels
 * invariant in docs/CHANNELS.md.
 */
export async function openDirectThread(
  owner: RoleSession,
  env: Env,
  peerEmails: string[],
): Promise<ThreadSummary> {
  // "Inside Envisioning" is both identity domains, not a suffix match against
  // the caller: `rosa@example.com` and `accounts@example.org` are one
  // team, and a literal comparison would have refused them each other.
  if (!isMemberEmail(env, owner.email)) {
    throw new ThreadError('Messages stay inside this workspace.', 403, 'not_room_owner');
  }

  const peers = [];
  for (const email of peerEmails) {
    const peer = await memberByEmail(env, email);
    if (!peer) throw new ThreadError('That person is not on your team.', 404, 'room_not_found');
    // An agent on the roster is on the team whatever its domain: `kind`
    // authorizes, not the suffix (agents.ts). An enrolled agent's address is
    // `<name>@agents.<workspace host>`, never a sign-in domain.
    if (!isMemberEmail(env, peer.email) && !(await agentByEmail(env, peer.email))) {
      throw new ThreadError('Messages stay inside this workspace.', 403, 'not_room_owner');
    }
    peers.push(peer);
  }

  // A note to self is a real conversation with one member — the same shape,
  // not a special case. It is also the only way to exercise messaging with a
  // single account, which is what testing on two devices needs.
  //
  // The subjects go into the id exactly as named, doubled self included, so a
  // pair derives the id it always derived. The *members* are deduped, because
  // a row per person is the point.
  const subs = [owner.sub, ...peers.map((peer) => peer.sub)];
  const members = [{ sub: owner.sub, email: owner.email }, ...peers]
    .filter((member, index, all) => all.findIndex((one) => one.sub === member.sub) === index);
  if (members.length > THREAD_GROUP_MAX_MEMBERS) {
    throw new ThreadError(
      `A private conversation holds up to ${THREAD_GROUP_MAX_MEMBERS} people. Past that, use Everyone.`,
      400,
      'invalid_request',
    );
  }

  const id = await directThreadId(...subs);
  const now = Date.now();

  const thread = threadStub(env, id);
  // A DM's unread already runs on the per-member `last_read_at` mechanism,
  // which needs no first-message signal.
  await thread.ensureThread({ id, kind: 'dm', parentId: null, audience: 'members', members });

  await env.USAGE.prepare(
    `INSERT INTO threads (id, kind, parent_id, created_at) VALUES (?1, 'dm', NULL, ?2)
       ON CONFLICT(id) DO NOTHING`,
  ).bind(id, now).run();
  await env.USAGE.batch(members.map((member) => env.USAGE.prepare(
    `INSERT INTO thread_members (thread_id, member_sub, member_email, last_read_at)
     VALUES (?1, ?2, ?3, 0) ON CONFLICT(thread_id, member_sub) DO NOTHING`,
  ).bind(id, member.sub, member.email)));

  const row = await threadRow(env, id, owner);
  return summarize(env, row, owner);
}

/**
 * The channel on one CRM project or lead. Find-or-create, like a DM.
 *
 * Core decides whether the subject exists and what it is called — the client
 * sends an id and nothing else, so a channel can never be minted for a project
 * nobody has, and a title can never be spoofed into somebody's conversation
 * list. The title is refreshed on every open, which is what keeps a renamed
 * project from reading under its old name forever.
 */
/**
 * `last_activity_at` on subject rows ( slice 3c): the later of what
 * Core said and the subject channel's last message, which lives here and
 * Core cannot see. Read once for the whole page — the same thread list
 * INBOX reads — so a page of twenty subjects costs one D1 query, not
 * twenty. A subject with neither keeps null; the client falls back to its
 * busiest order for those rows.
 */
export async function withLastActivity(env: Env, owner: OwnerSession, subjects: CrmSubject[]): Promise<CrmSubject[]> {
  if (subjects.length === 0) return subjects;
  let threads: ThreadSummary[] = [];
  try {
    threads = (await listThreadsFor(env, owner)).threads;
  } catch {
    // A thread list that will not read must not fail the subject list.
    return subjects;
  }
  const lastMessageAt = new Map<string, number>();
  for (const thread of threads) {
    if (thread.parent_id && thread.last_message_at) {
      lastMessageAt.set(`${thread.kind}:${thread.parent_id}`, thread.last_message_at);
    }
  }
  return subjects.map((subject) => {
    const fromCore = subject.last_activity_at ? Date.parse(subject.last_activity_at) : Number.NaN;
    const fromTalk = lastMessageAt.get(`${subject.kind}:${subject.id}`) ?? Number.NaN;
    const latest = Math.max(Number.isNaN(fromCore) ? -Infinity : fromCore, Number.isNaN(fromTalk) ? -Infinity : fromTalk);
    if (!Number.isFinite(latest)) return subject;
    return { ...subject, last_activity_at: new Date(latest).toISOString() };
  });
}

export async function openSubjectThread(
  owner: RoleSession,
  env: Env,
  kind: 'project' | 'lead' | 'organization' | 'event',
  subjectId: string,
): Promise<ThreadSummary> {
  if (!workModelEnabled(env)) {
    throw new ThreadError('CRM channels are not configured.', 503, 'not_configured');
  }
  const subject = await fetchCrmSubject(env, kind, subjectId);
  // Same 404 a missing thread gets: which projects exist is not something to
  // enumerate through this route.
  if (!subject) throw new ThreadError('Conversation not found.', 404, 'room_not_found');

  const { id } = await ensureSubjectThread(env, kind, subjectId, subject.title);
  const row = await threadRow(env, id, owner);
  return summarize(env, row, owner);
}

/**
 * The subject's channel, for something outside Meet writing into it.
 *
 * Same two checks a person opening it gets: the bridge must be on, and Core
 * must know the subject — a runtime that names a project nobody has cannot
 * mint a channel for it. The 404 is the one a missing thread gets, on purpose.
 *
 * Find-or-create only. Whether an event landing here should count as unread
 * is a question for the index write itself (`markThreadIndexedIfUnindexed`),
 * not for this resolution step — a second call in the same request (as
 * `internal.ts` makes, just to compare thread ids) is exactly as safe as the
 * first, because there is no one-shot signal here left to spend.
 */
export async function resolveSubjectThread(
  env: Env,
  subject: { kind: 'project' | 'lead' | 'organization' | 'event'; id: string },
): Promise<{ id: string }> {
  if (!workModelEnabled(env)) {
    throw new ThreadError('CRM channels are not configured.', 503, 'not_configured');
  }
  const resolved = await fetchCrmSubject(env, subject.kind, subject.id);
  if (!resolved) throw new ThreadError('Conversation not found.', 404, 'room_not_found');
  return ensureSubjectThread(env, subject.kind, subject.id, resolved.title);
}

/**
 * The channel's two halves — the Durable Object and the D1 index row — made
 * to exist, with Core's title. Shared by a person opening the channel, by the
 * work graph writing into it, and by `/mcp`'s `open` on a subject door, so an
 * event can land on a project nobody has opened yet without a second creation
 * path.
 *
 * Every caller has just had Core say the subject exists, so this is also what
 * brings a removed channel back: the subject is there again.
 */
export async function ensureSubjectThread(
  env: Env,
  kind: 'project' | 'lead' | 'organization' | 'event',
  subjectId: string,
  title: string,
): Promise<{ id: string }> {
  const id = await subjectThreadId(kind, subjectId);
  const thread = threadStub(env, id);
  await thread.ensureThread({ id, kind, parentId: subjectId, audience: 'everyone', members: [] });
  await env.USAGE.prepare(
    `INSERT INTO threads (id, kind, parent_id, created_at, title, audience)
     VALUES (?1, ?2, ?3, ?4, ?5, 'everyone')
       ON CONFLICT(id) DO UPDATE SET title = ?5, removed_at = NULL, removed_by = NULL`,
  ).bind(id, kind, subjectId, Date.now(), title).run();
  if (channelMailbox(env)) await mintInboundLocal(env, id, title);
  return { id };
}

/**
 * The channel's inbound email local part, from its title, once.
 * A row that has one keeps it: the address is on people's clipboards and in
 * their mail clients, and a renamed project must not silently retire it.
 * Collisions take a numeric suffix; a title with nothing readable in it gets
 * no slug, and the id spelling (`inbound-address.ts`) is that channel's
 * address instead.
 */
async function mintInboundLocal(env: Env, threadId: string, title: string): Promise<void> {
  const existing = await env.USAGE.prepare('SELECT inbound_local FROM threads WHERE id = ?1')
    .bind(threadId).first<{ inbound_local: string | null }>();
  if (!existing || existing.inbound_local) return;
  const base = slugLocalPart(title);
  if (!base) return;
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const candidate = slugCandidate(base, attempt);
    try {
      // `IS NULL` makes a parallel open a no-op rather than a second slug.
      await env.USAGE.prepare(
        'UPDATE threads SET inbound_local = ?2 WHERE id = ?1 AND inbound_local IS NULL',
      ).bind(threadId, candidate).run();
      return;
    } catch (error) {
      // The unique index is the collision check; anything else is a real failure.
      if (!(error instanceof Error && /UNIQUE/iu.test(error.message))) throw error;
    }
  }
}

/** The channel whose inbound local part this is, or null. */
export async function subjectOfInboundLocal(
  env: Env,
  local: string,
): Promise<{ kind: 'project' | 'lead' | 'organization' | 'event'; id: string } | null> {
  const row = await env.USAGE.prepare(
    'SELECT kind, parent_id FROM threads WHERE inbound_local = ?1 AND removed_at IS NULL',
  ).bind(local).first<{ kind: string; parent_id: string | null }>();
  if (!row || !row.parent_id) return null;
  if (row.kind !== 'project' && row.kind !== 'lead' && row.kind !== 'organization' && row.kind !== 'event') return null;
  return { kind: row.kind, id: row.parent_id };
}

/**
 * The write that makes a thread badge and reorder the conversation list —
 * the same `UPDATE` a real `text` message makes. Shared by
 * `appendInboundMessage`'s own `text` writes (an agent answering) and by the
 * `event` branch below once it has decided a line is index-worthy.
 *
 * Guarded against moving `last_message_at` **backwards**: every other index
 * write in this file already guards this column (`editMessage` on
 * `last_message_at` itself, `withdrawMessage` on `last_sender_email` plus
 * `last_message_at`), and this one wasn't — new exposure since before this
 * PR an `event` never reached the index at all. Without the guard, a
 * deferred or redelivered older write could overwrite a newer human message
 * and re-mark a thread unread for people who already read it.
 *
 * **Not** shared by `sendMessage`'s inline copy of this same `UPDATE`,
 * deliberately: that path mints a fresh id and timestamp per call with
 * nothing to retry or redeliver, so it has nothing to guard against, and two
 * human messages landing in the same millisecond must still both index — a
 * monotonic guard would silently drop the second one's preview on a tie.
 */
async function markThreadIndexed(
  env: Env,
  threadId: string,
  at: number,
  text: string,
  senderEmail: string,
  origin: 'slack' | 'guest' | 'peer' | 'app' | null = null,
): Promise<void> {
  // `last_origin` marks a line from outside; a guest thread whose last line
  // is from outside is unanswered (docs/SUPPORT.md).
  await env.USAGE.prepare(
    `UPDATE threads SET last_message_at = ?2, last_message_preview = ?3, last_sender_email = ?4, last_origin = ?5
      WHERE id = ?1 AND (last_message_at IS NULL OR last_message_at < ?2)`,
  ).bind(threadId, at, preview(text), senderEmail, origin).run();
}

/**
 * The first-event exception's entire mechanism, replacing the
 * `created`/`firstEventForSubject` signal that used to be threaded down from
 * `ensureThread`. One atomic, guarded `UPDATE` keyed
 * directly on the facts that matter — `last_message_at IS NULL`, i.e. this
 * thread has never carried a message or event, and `kind IN ('project',
 * 'lead')`, i.e. it is a CRM subject's channel — rather than on a proxy
 * computed once, earlier, and possibly discarded by a second unrelated
 * resolution of the same channel later in the same request.
 *
 * The `kind` half of the guard is what keeps the exception scoped to a CRM
 * subject: the team channel and every DM also start with `last_message_at
 * IS NULL` before their first real message, and an event landing there —
 * the GitHub webhook posting straight to `team`, an agent narrating in a
 * DM — must stay silent exactly as it always has, since neither is "a
 * subject born purely from a CRM event" with nobody yet to reply to it.
 *
 * Atomic, so two events racing to be first on the same not-yet-existing
 * subject cannot both "win": only the `UPDATE` that still finds the guard
 * true changes a row. Retry-safe, so a redelivered request re-checks the
 * real columns rather than a one-shot boolean that a failure between thread
 * creation and this write would have already lost. And correct in the
 * direction the old proxy was not: a subject channel opened by a person but
 * never spoken in has `last_message_at IS NULL` exactly like one that never
 * existed at all, so its real first event still counts.
 *
 * Returns whether this call is the one that actually flipped the row — the
 * signal `postSubjectEvent` needs to decide whether to record the acting
 * human as having read their own line.
 */
async function markThreadIndexedIfUnindexed(
  env: Env,
  threadId: string,
  at: number,
  text: string,
  senderEmail: string,
): Promise<boolean> {
  const result = await env.USAGE.prepare(
    `UPDATE threads SET last_message_at = ?2, last_message_preview = ?3, last_sender_email = ?4
      WHERE id = ?1 AND last_message_at IS NULL AND kind IN ('project', 'lead')`,
  ).bind(threadId, at, preview(text), senderEmail).run();
  return (result.meta?.changes ?? 0) > 0;
}

/**
 * The work graph reporting itself into a subject's channel: a meeting filed
 * here, a meeting ended, notes filed, a task the meeting produced. One quiet
 * line in the same transcript as the talk — a channel where the automatic
 * half lives somewhere else is two channels. See docs/CHANNELS.md.
 *
 * **Not** an index write, with one deliberate exception.
 * An event never counts as unread and never reorders the conversation list —
 * a channel full of system lines must not badge anybody, and the preview
 * stays the last thing a person said — *except* when this event is the very
 * first thing this subject's channel has ever carried: nothing else will
 * ever tell anybody to look at a subject born purely from a CRM event (a
 * lead nobody has replied to yet), so that one line has to count as new.
 * `markThreadIndexedIfUnindexed` decides this directly off
 * `threads.last_message_at IS NULL` at the moment of the write — the moment
 * a person replies, that column is no longer null, the ordinary per-member
 * `last_read_at` mechanism takes over, and this exception never fires again
 * for this subject.
 *
 * `options.actor` is that exception's own exception: most events reported
 * here have a human actor — someone filed a meeting, ended one, or made a
 * task — and the sender-exclusion `sendMessage` gives a real message via
 * `recordRead` applies just as much to them. Pass their identity and, on the
 * one write that would otherwise badge them for their own action, they are
 * marked as having read it in the same beat. Leave it unset for an event
 * with no human actor — `lead.created` and friends — which is the case this
 * exception exists for, and where the current behavior is exactly right.
 *
 * Best effort by construction, like every CRM write: nothing here may break
 * a meeting, a category save, or a task. A Core outage or an unknown subject
 * logs and returns; the title is Core's, never the caller's.
 */
export async function postSubjectEvent(
  env: Env,
  subject: { kind: 'project' | 'lead' | 'organization' | 'event'; id: string },
  text: string,
  refs: ThreadMessageRef[] = [],
  options: { dedupeKey?: string; actor?: Pick<OwnerSession, 'sub' | 'email'> } = {},
): Promise<void> {
  if (!workModelEnabled(env)) return;
  try {
    const resolved = await fetchCrmSubject(env, subject.kind, subject.id);
    if (!resolved) return;
    const { id: threadId } = await ensureSubjectThread(env, subject.kind, subject.id, resolved.title);
    const thread = threadStub(env, threadId);
    // A key makes the line say itself once however many times it is reported.
    // The derivation is the inbound door's, deliberately: an event Meet writes
    // for a change it made and the same event arriving later through Core's
    // GitHub webhook are one line, not two, as long as both name the same key.
    const id = options.dedupeKey
      ? await inboundMessageId(threadId, options.dedupeKey)
      : `evt_${randomToken(12)}`;
    const at = Date.now();
    const sender = threadEventSender(env);
    const appended = await thread.append(sender, text, id, at, 'event', refs);
    const indexed = appended.inserted ? { id, text, sent_at: at } : await thread.activityEntry(id).catch(() => null);
    if (indexed) await recordSubjectActivity(env, { thread_id: threadId, message_id: indexed.id, text: indexed.text, at: indexed.sent_at });
    if (!appended.inserted) return;
    // Guarded, atomic, and re-checked on every call — see
    // `markThreadIndexedIfUnindexed` for why this replaces the old
    // `created` signal.
    const firstEver = await markThreadIndexedIfUnindexed(env, threadId, at, text, sender.email);
    if (firstEver && options.actor) {
      // The actor just did the thing this line announces — never let it come
      // back to them as unread, the same guarantee `sendMessage` gives a real
      // message.
      await recordRead(env, threadId, options.actor, at);
    }
    await recordCardTrace(env, { threadId, messageId: id, text, at, refs });
    await recordCardLines(env, { threadId, messageId: id, at, refs });
  } catch (error) {
    // Kind only — never the text, which can carry a meeting title.
    console.error(JSON.stringify({
      level: 'error',
      message: 'threads.event.failed',
      kind: subject.kind,
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
  }
}

/**
 * A GitHub issue reporting itself into the project's channel.
 *
 * The channel already draws a project's issues beside its tasks; what it did
 * not have was the moment one changed. A project channel that goes quiet while
 * the work moves on GitHub is a channel people stop reading — so an issue
 * filed, closed or reopened from Meet leaves the same kind of quiet line a
 * meeting does, carrying an `issue` ref, which every client already turns into
 * a chip that opens the issue.
 *
 * **Only the states, and only the ones Meet made.** A label edit is not news,
 * and an issue changed on github.com is Core's webhook to report — the two
 * agree because both derive the message id from `githubIssueEventKey`, so
 * whichever arrives second writes nothing. See docs/CHANNELS.md §Webhook.
 *
 * `projectID` is asserted by the client on a change (the update body has no
 * project — GitHub's issue does not know about ours), so the link is checked
 * against Core before anything is written. A line naming the wrong project
 * would be worse than no line at all.
 *
 * Best effort, like every event: nothing here may fail the write it reports.
 */
export async function postIssueEvent(
  env: Env,
  input: {
    projectID: string;
    actor: string;
    owner: string;
    repo: string;
    number: number;
    title: string;
    verb: GithubIssueVerb;
  },
): Promise<void> {
  if (!workModelEnabled(env)) return;
  try {
    const linked = await fetchCrmProjectRepos(env, input.projectID);
    const onThisProject = linked.some(
      (link) => link.owner === input.owner && link.repo === input.repo,
    );
    if (!onThisProject) return;

    const ref = `${input.owner}/${input.repo}#${input.number}`;
    await postSubjectEvent(
      env,
      { kind: 'project', id: input.projectID },
      githubIssueLine({ actor: input.actor, number: input.number, title: input.title, verb: input.verb }),
      [{ kind: 'issue', id: ref }],
      { dedupeKey: githubIssueEventKey(ref, input.verb) },
    );
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      message: 'threads.issueEvent.failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
  }
}

/**
 * A calendar event reporting its own filing into the subject's channel —
 * Phase 2 of docs/TIMELINE.md, the second producer added to the same pipe
 * step 3b built.
 *
 * There is no dedicated "file this event" route (`event_subjects` is one
 * field in the whole-blob `PUT /api/calendar/preferences`, docs/WORK.md step
 * 5), so a filing is detected the only way it can be here: diffing the map
 * that was stored before this write against the one just written. A key
 * that is new, or now names a different subject, just got filed; anything
 * unchanged is the client re-sending state it already had, which happens on
 * most calls to this route and must announce nothing.
 *
 * Unfiling is deliberately silent — the work graph reports things that
 * happened, not things that stopped being true, the same asymmetry
 * `postSubjectEvent`'s callers already keep (a task's suggestion becoming a
 * real task is announced; nothing announces a task being deleted).
 *
 * Capped, because `calendarPreferencesSchema` allows up to 1000
 * `event_subjects` entries in one request and this must never turn one PUT
 * into a thousand channel writes — a bulk change still updates every
 * preference; it just stops narrating past the cap.
 */
const CALENDAR_FILING_ANNOUNCE_CAP = 20;

export async function announceCalendarFilings(
  env: Env,
  owner: OwnerSession,
  before: Record<string, CalendarEventSubject>,
  after: Record<string, CalendarEventSubject>,
): Promise<void> {
  if (!workModelEnabled(env)) return;
  const newlyFiled = Object.entries(after)
    .filter(([key, subject]) => {
      const previous = before[key];
      return !previous || previous.kind !== subject.kind || previous.id !== subject.id;
    })
    .map(([, subject]) => subject);
  const toAnnounce = newlyFiled.slice(0, CALENDAR_FILING_ANNOUNCE_CAP);
  for (const subject of toAnnounce) {
    await postSubjectEvent(
      env,
      { kind: subject.kind, id: subject.id },
      `${owner.name || owner.email} filed a calendar event here`,
      [],
      { actor: { sub: owner.sub, email: owner.email } },
    );
  }
}

/** What happened to an issue, in the only three flavours worth a line. */
export type GithubIssueVerb = 'filed' | 'closed' | 'closed_not_planned' | 'reopened';

const VERB_PROSE: Record<GithubIssueVerb, string> = {
  filed: 'filed',
  closed: 'closed',
  closed_not_planned: 'closed, not planned,',
  reopened: 'reopened',
};

/** The same verbs with no actor in front of them. See `githubIssueLine`. */
const VERB_PASSIVE: Record<GithubIssueVerb, string> = {
  filed: 'filed',
  closed: 'closed',
  closed_not_planned: 'closed, not planned',
  reopened: 'reopened',
};

/**
 * The line a GitHub issue change puts in its subject's channel, written once
 * here because two reporters produce it: the webhook edge through
 * `postIssueEvent`, and the connector sync when that edge is down
 * (docs/GITHUB_CONNECTOR.md §The issues phase).
 *
 * An unknown actor drops the name rather than guessing one. GitHub's issue
 * list does not always say who closed an issue, and a line naming the wrong
 * colleague is worse than a line naming nobody.
 */
export function githubIssueLine(input: {
  actor: string | null;
  number: number;
  title: string;
  verb: GithubIssueVerb;
}): string {
  return input.actor
    ? `${input.actor} ${VERB_PROSE[input.verb]} #${input.number} · ${input.title}`
    : `#${input.number} ${VERB_PASSIVE[input.verb]} · ${input.title}`;
}

/**
 * The key both reporters of one GitHub change agree on.
 *
 * Core's webhook has the issue and the action and nothing else in common with
 * this Worker's request, so the key is built from exactly that. `closed` and
 * `closed_not_planned` collapse to one key on purpose: they are the same
 * event, and a reason Meet knew and the webhook rephrased must not become a
 * second line.
 */
export function githubIssueEventKey(ref: string, verb: GithubIssueVerb): string {
  const action = verb === 'closed_not_planned' ? 'closed' : verb === 'filed' ? 'opened' : verb;
  return `github:${ref}:${action}`;
}

/**
 * The id a message derived from an idempotency key gets, rather than a minted
 * one. Hashed for the same reason a thread id is — an id travels in logs — and
 * scoped to the thread so two callers cannot collide on a common key like an
 * issue number.
 *
 * Shared by the inbound door and by `postSubjectEvent`, because the two report
 * the same GitHub change from different directions and one of them has to lose.
 */
export async function inboundMessageId(threadId: string, idempotencyKey: string): Promise<string> {
  const digest = await sha256(`inbound:${threadId}:${idempotencyKey}`);
  return `msg_${digest.slice(0, 32)}`;
}

/**
 * A message written by something that is not a signed-in person: Core's
 * webhook reporting an issue, or an agent answering. The one write path behind
 * `POST /api/internal/channel-events`, and deliberately the only one — every
 * other caller goes through `sendMessage` with a session.
 *
 * Three things differ from `sendMessage`, and each is the point:
 *
 * 1. **The id is given, not minted.** It is derived from the caller's
 *    idempotency key, so a sandbox that retries after a timeout re-writes the
 *    same row instead of saying everything twice.
 * 2. **Authorization is the Durable Object's**, unchanged: a channel takes any
 *    sender, a DM takes a member. An agent in a DM is a member of it; the
 *    system sender is not a member of anything, which is exactly why an event
 *    can only ever land in a channel.
 * 3. **The index write follows the type**, with one exception. An agent's
 *    `text` is somebody talking to you, so it badges and reorders the list
 *    like any message. An `event` stays silent, as it has since 1.4.1 — a
 *    channel full of system lines must not badge anybody — *unless* it is
 *    the very first message this CRM subject's channel has ever carried,
 *    which nothing else will tell anybody to look at.
 *    That is decided here, per event, by `markThreadIndexedIfUnindexed`
 *    against the real `threads.last_message_at` and `kind` columns — never
 *    by a signal passed in, so a second `resolveSubjectThread` earlier in
 *    the same request (as `internal.ts` makes to compare thread ids) cannot
 *    make this read stale, and an event landing in `team` or a DM by
 *    `thread_id` — which also starts with `last_message_at IS NULL` — stays
 *    silent exactly as before.
 */
export async function appendInboundMessage(
  env: Env,
  input: {
    threadId: string;
    messageId: string;
    sender: { sub: string; email: string; name: string };
    text: string;
    type: ThreadMessageType;
    refs: ThreadMessageRef[];
    /** Files staged on this thread by `sender`, bound to the message on first insert. */
    attachmentIds?: string[];
    /** Still streaming: this row will be posted again under the same id. */
    partial?: boolean;
    /**
     * History from somewhere else (docs/SLACK_IMPORT.md): when it was said
     * there, and where. The row keeps that time, so a channel's history reads
     * in order; the index write's own `last_message_at < at` guard means an
     * old row never moves the list or badges anybody, and a new one does.
     */
    sentAt?: number;
    origin?: { kind: 'slack' | 'guest' | 'peer' | 'app'; ref: string };
    question?: ThreadQuestion;
    questionRecipientEmail?: string;
    /** An agent's request for one Keep item. */
    releaseRequest?: ThreadReleaseRequest;
    /** A parent text line in the same thread: a support conversation's reply. */
    replyToMessageId?: string | null;
  },
): Promise<{ messageId: string; duplicate: boolean; partial: boolean }> {
  // Existence is checked here so an unknown thread is a clean 404 rather than
  // a Durable Object quietly created by being addressed.
  const row = await env.USAGE.prepare('SELECT id, kind, parent_id, title FROM threads WHERE id = ?1')
    .bind(input.threadId).first<{ id: string; kind: string; parent_id: string | null; title: string | null }>();
  if (!row) throw new ThreadError('Conversation not found.', 404, 'room_not_found');

  const sentAt = input.sentAt ?? Date.now();
  const thread = threadStub(env, input.threadId);
  let questionRecipient = input.questionRecipientEmail;
  if (input.question) {
    questionRecipient = await questionRecipientFor(env, input.threadId, input.sender, questionRecipient);
    if (!questionRecipient && !(await thread.message(input.sender.sub, input.messageId))) {
      throw new ThreadError('A shared-chat question must name question_recipient_email.', 400, 'invalid_question_recipient');
    }
  }
  const appended = await thread.append(
    input.sender,
    input.text,
    input.messageId,
    sentAt,
    input.type,
    input.refs,
    {
      attachmentIds: input.attachmentIds ?? [],
      partial: input.partial === true,
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
      ...(input.question ? { question: input.question } : {}),
      ...(input.releaseRequest ? { releaseRequest: input.releaseRequest } : {}),
      ...(questionRecipient ? { questionRecipientEmail: questionRecipient, questionContext: {
        title: row.title,
        subject: isSubjectKind(row.kind) && row.parent_id ? { kind: row.kind, id: row.parent_id, title: row.title } : null,
      } } : {}),
    },
  );
  if (input.type === 'event' && isSubjectKind(row.kind) && !appended.partial) {
    const indexed = appended.inserted ? { id: appended.id, text: input.text, sent_at: sentAt } : await thread.activityEntry(appended.id).catch(() => null);
    if (indexed) await recordSubjectActivity(env, { thread_id: input.threadId, message_id: indexed.id, text: indexed.text, at: indexed.sent_at });
  }
  if (!appended.partial && !questionRecipient) await registerDirectQuestion(env, input.threadId, input.sender, appended.id);
  if (!appended.partial) await recordCardLines(env, { threadId: input.threadId, messageId: appended.id, at: sentAt, refs: input.refs });
  if (!appended.inserted && !appended.rewritten) return { messageId: appended.id, duplicate: true, partial: false };
  // Something arrived for a channel an admin removed: the subject
  // is evidently live again, so the channel is too. A redelivery changes
  // nothing and is returned above, so a restore is not undone by a retry.
  await env.USAGE.prepare(
    'UPDATE threads SET removed_at = NULL, removed_by = NULL WHERE id = ?1 AND removed_at IS NOT NULL',
  ).bind(input.threadId).run();

  // The list's preview is written on the first post and on the final one; the
  // rewrites between them are for the pane that is watching, not for a list
  // that would otherwise redraw its row on every second of a streaming answer.
  const settled = appended.inserted || !appended.partial;
  if (input.type === 'text') {
    if (settled) await markThreadIndexed(env, input.threadId, sentAt, input.text, input.sender.email, input.origin?.kind ?? null);
  } else if (appended.inserted) {
    await recordCardTrace(env, {
      threadId: input.threadId,
      messageId: appended.id,
      text: input.text,
      at: sentAt,
      refs: input.refs,
    });
    if (input.type === 'event') {
      await markThreadIndexedIfUnindexed(env, input.threadId, sentAt, input.text, input.sender.email);
    }
  }
  return { messageId: appended.id, duplicate: false, partial: appended.partial };
}

/** The named recipient must be an eligible human with write access to this chat. */
async function questionRecipientFor(env: Env, threadId: string, sender: { sub: string; email: string }, named?: string): Promise<string | undefined> {
  const { results } = await env.USAGE.prepare(`SELECT m.member_sub, m.member_email, p.kind
    FROM thread_members m JOIN threads t ON t.id = m.thread_id
    LEFT JOIN people p ON p.email = m.member_email WHERE m.thread_id = ?1 AND t.kind = 'dm'`)
    .bind(threadId).all<{ member_sub: string; member_email: string; kind: string | null }>();
  const implicit = results.length === 2 && results.find((member) => member.member_sub === sender.sub)?.kind === 'agent'
    ? results.find((member) => member.kind === 'human')?.member_email : undefined;
  const email = (named ?? implicit)?.trim().toLowerCase();
  if (!email) return undefined;
  const person = await env.USAGE.prepare(`SELECT sub, email, name, role FROM people
    WHERE lower(email) = ?1 AND kind = 'human' AND revoked_at IS NULL AND role IN ('member', 'admin')`)
    .bind(email).first<{ sub: string; email: string; name: string; role: 'member' | 'admin' }>();
  if (!person) throw new ThreadError('Choose an eligible member for this question.', 400, 'invalid_question_recipient');
  try { await assertAttentionThreadAccess(env, person, threadId, true); }
  catch (error) {
    if (error instanceof ThreadError || error instanceof ControlError) {
      if (error.status === 403 || error.status === 404) throw new ThreadError('The recipient cannot answer in this chat.', 400, 'invalid_question_recipient');
    }
    throw error;
  }
  return email;
}

/** Shared request projections use exactly the conversation's existing access rules. */
export async function assertAttentionThreadAccess(env: Env, owner: RoleSession, threadId: string, write = false): Promise<void> {
  const row = await threadRow(env, threadId, owner);
  if (write) await requireThreadWrite(env, owner, row);
  // The DO carries the second membership lock for private conversations.
  await threadStub(env, threadId).messages(owner.sub, { limit: 1 });
}

/** Only a two-member agent/human DM has an implicit question recipient. */
async function registerDirectQuestion(env: Env, threadId: string, sender: { sub: string; email: string }, messageId: string): Promise<void> {
  const { results } = await env.USAGE.prepare(`SELECT m.member_sub, m.member_email, p.kind
    FROM thread_members m JOIN threads t ON t.id = m.thread_id
    LEFT JOIN people p ON p.email = m.member_email
    WHERE m.thread_id = ?1 AND t.kind = 'dm'`).bind(threadId)
    .all<{ member_sub: string; member_email: string; kind: string | null }>();
  const author = results.find((member) => member.member_sub === sender.sub);
  const recipient = results.find((member) => member.kind === 'human');
  if (results.length !== 2 || author?.kind !== 'agent' || !recipient) return;
  await threadStub(env, threadId).registerQuestion(sender.sub, messageId, recipient.member_email);
}

/**
 * Who sent one message, for the inbound door to attribute a card move to.
 *
 * Read as the agent that is asking: the Durable Object applies its own reader
 * lock, so an agent can only point at a message in a conversation it is a
 * member of, and a channel — which anybody may read — still only yields the
 * message's own sender.
 */
export async function messageSender(
  env: Env,
  threadId: string,
  readerSub: string,
  messageId: string,
): Promise<{ sub: string; email: string; name: string | null; type: ThreadMessageType } | null> {
  const row = await env.USAGE.prepare('SELECT id FROM threads WHERE id = ?1')
    .bind(threadId).first<{ id: string }>();
  if (!row) return null;
  const found = await threadStub(env, threadId).message(readerSub, messageId);
  if (!found) return null;
  return { sub: found.senderSub, email: found.senderEmail, name: found.senderName, type: found.type };
}

/**
 * The last event naming each card, kept where the board can read it in one
 * query (`card_trace`, migration 0012). Event lines only, and best effort: a
 * trace that failed to write is a card face with one line missing, which is
 * a smaller failure than an event that failed to land.
 */
async function recordCardTrace(
  env: Env,
  event: { threadId: string; messageId: string; text: string; at: number; refs: ThreadMessageRef[] },
): Promise<void> {
  const cards = event.refs.filter((ref) => ref.kind === 'task' || ref.kind === 'issue');
  if (cards.length === 0) return;
  try {
    await env.USAGE.batch(cards.map((ref) => env.USAGE.prepare(
      `INSERT INTO card_trace (ref_kind, ref_id, thread_id, message_id, text, at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(ref_kind, ref_id) DO UPDATE
           SET thread_id = ?3, message_id = ?4, text = ?5, at = ?6
         WHERE at <= ?6`,
    ).bind(ref.kind, ref.id, event.threadId, event.messageId, preview(event.text), event.at)));
  } catch (error) {
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'threads.card-trace.failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
  }
}

/**
 * Every line that names a card (migration 0109), so a task's page can list
 * what was said about it. Best effort, like the trace: a line missing from
 * the index is still in its thread.
 */
async function recordCardLines(
  env: Env,
  line: { threadId: string; messageId: string; at: number; refs: ThreadMessageRef[] },
): Promise<void> {
  const cards = line.refs.filter((ref) => ref.kind === 'task' || ref.kind === 'issue');
  if (cards.length === 0) return;
  try {
    await env.USAGE.batch(cards.map((ref) => env.USAGE.prepare(
      'INSERT OR IGNORE INTO card_lines (ref_kind, ref_id, thread_id, message_id, at) VALUES (?1, ?2, ?3, ?4, ?5)',
    ).bind(ref.kind, ref.id, line.threadId, line.messageId, line.at)));
  } catch (error) {
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'threads.card-lines.failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
  }
}

/** The cards one indexed line names. */
async function cardRefsOfLine(env: Env, threadId: string, messageId: string): Promise<ThreadMessageRef[]> {
  try {
    const { results } = await env.USAGE.prepare(
      'SELECT ref_kind, ref_id FROM card_lines WHERE thread_id = ?1 AND message_id = ?2',
    ).bind(threadId, messageId).all<{ ref_kind: 'task' | 'issue'; ref_id: string }>();
    return (results ?? []).map((row) => ({ kind: row.ref_kind, id: row.ref_id }));
  } catch {
    return [];
  }
}

/** How many lines a card's page shows: the latest, oldest first. */
const CARD_LINES_LIMIT = 50;

/**
 * What was said about one card, across every thread that named it, oldest
 * first. A reader sees a line only where they may read its
 * thread: a thread they cannot open is left out, not refused.
 */
export async function readCardLines(
  owner: RoleSession,
  env: Env,
  ref: { kind: 'task' | 'issue'; id: string },
): Promise<ThreadMessage[]> {
  const { results } = await env.USAGE.prepare(
    `SELECT thread_id, message_id FROM card_lines
      WHERE ref_kind = ?1 AND ref_id = ?2
      ORDER BY at DESC LIMIT ?3`,
  ).bind(ref.kind, ref.id, CARD_LINES_LIMIT).all<{ thread_id: string; message_id: string }>();
  const byThread = new Map<string, string[]>();
  for (const row of results ?? []) byThread.set(row.thread_id, [...(byThread.get(row.thread_id) ?? []), row.message_id]);
  const pages = await Promise.all([...byThread].map(async ([threadId, ids]) => {
    try {
      await threadRow(env, threadId, owner);
      return await threadStub(env, threadId).messagesByIds(owner.sub, ids);
    } catch (error) {
      if (error instanceof ThreadError) return [];
      throw error;
    }
  }));
  return pages.flat().sort((left, right) => left.sent_at - right.sent_at);
}

/** "42 min" / "1 h 05 min", for an ended-meeting line. */
export function describeDuration(startedAt: number, endedAt: number): string {
  const minutes = Math.max(1, Math.round((endedAt - startedAt) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${String(rest).padStart(2, '0')} min`;
}

export async function readThread(
  owner: RoleSession,
  env: Env,
  threadId: string,
  query: { before?: string | undefined; limit?: number | undefined },
): Promise<ThreadMessagesResponse> {
  const row = await threadRow(env, threadId, owner);

  const thread = threadStub(env, threadId);
  const page = await thread.messages(owner.sub, query);

  return {
    thread: await summarize(env, row, owner),
    messages: page.messages,
    older_cursor: page.olderCursor,
  };
}

/** The `since=` projection is compact so polling cannot pull whole conversations into MCP. */
export async function readThreadChanges(
  owner: RoleSession,
  env: Env,
  threadId: string,
  since: string,
  limit = 200,
): Promise<ThreadMessagesSinceResponse> {
  await threadRow(env, threadId, owner);
  const cursor = parseMcpChangeCursor(since);
  if (!cursor) throw new ThreadError('The change cursor is invalid.', 400, 'invalid_request');
  const page = await threadStub(env, threadId).changesSince(owner.sub, cursor, limit);
  return { thread_id: threadId, changes: page.changes, has_more: page.hasMore };
}

/** Member-scoped cross-thread feed; the MCP edge calls this route, never D1 or a Durable Object directly. */
export async function readThreadChangesFeed(
  owner: OwnerSession,
  env: Env,
  since: string,
  requestedLimit = 200,
): Promise<ThreadChangesResponse> {
  const cursor = parseMcpChangeCursor(since);
  if (!cursor) throw new ThreadError('The change cursor is invalid.', 400, 'invalid_request');
  const limit = Math.min(Math.max(Math.trunc(requestedLimit), 1), 200);
  const { results } = await env.USAGE.prepare(
    `SELECT t.id
       FROM threads t
       LEFT JOIN thread_members m ON m.thread_id = t.id AND m.member_sub = ?1
      WHERE ${conversationVisibleSql('t', 'm', '?2')}
        AND t.removed_at IS NULL
        AND NOT ${subjectHiddenSql('t.kind', 't.parent_id', '?1', '?2')}
      ORDER BY t.id`,
  ).bind(owner.sub, sessionAgentBind(owner)).all<{ id: string }>();

  const candidates: Array<ThreadChangesResponse['changes'][number]> = [];
  let hasMore = false;
  for (let offset = 0; offset < results.length; offset += 16) {
    const page = await Promise.all(results.slice(offset, offset + 16).map(async ({ id }) => ({
      threadId: id,
      ...(await threadStub(env, id).changesSince(owner.sub, cursor, limit)),
    })));
    for (const result of page) {
      hasMore ||= result.hasMore;
      for (const change of result.changes) {
        candidates.push({ ...change, thread_id: result.threadId });
      }
    }
    candidates.sort((left, right) => left.changed_at - right.changed_at
      || left.id.localeCompare(right.id)
      || left.thread_id.localeCompare(right.thread_id));
    if (candidates.length > limit) {
      candidates.length = limit;
      hasMore = true;
    }
  }
  return { changes: candidates, has_more: hasMore };
}

/** The channels a subject has. A Hand off there goes to an agent by @mention. */
const SUBJECT_CHANNEL_KINDS: ReadonlySet<string> = new Set(['project', 'lead', 'organization', 'event']);

/**
 * A Hand off in a subject's channel names its agent by @mention,
 * and that agent must be able to answer there. Refused before the message
 * lands, so a hand-off never sits in a channel its agent cannot hear: on a
 * restricted subject, an agent without a write grant.
 */
async function requireHandOffAgent(env: Env, threadId: string, mentions: string[]): Promise<void> {
  const agents = (await Promise.all(mentions.map((email) => agentByEmail(env, email))))
    .filter((agent): agent is NonNullable<typeof agent> => agent !== null);
  if (agents.length === 0) throw new ThreadError('Name the agent this goes to.', 400, 'person_not_found');
  const reaching = await agentsReachingThread(env, threadId, 'write');
  if (reaching && !agents.some((agent) => reaching.has(agent.sub))) {
    throw new ThreadError('That agent can’t see this subject. Give it access first.', 403, 'subject_access_denied');
  }
}

export async function sendMessage(
  owner: RoleSession,
  env: Env,
  threadId: string,
  body: {
    text: string;
    refs?: ThreadMessageRef[] | undefined;
    mentions?: string[] | undefined;
    attachments?: string[] | undefined;
    reply_to_message_id?: string | null | undefined;
    /** A Hand off of the card in `refs`. */
    handoff?: ThreadHandoff | undefined;
  },
  ctx?: ExecutionContext,
  /** The MCP client this was sent through, read from the session token. */
  via?: string | null,
): Promise<SentMessageResponse> {
  const row = await threadRow(env, threadId, owner);
  await requireThreadWrite(env, owner, row);
  if (body.handoff && SUBJECT_CHANNEL_KINDS.has(row.kind)) await requireHandOffAgent(env, threadId, body.mentions ?? []);
  // An agent acting through `/mcp` writes where another company's Claude
  // reads: a machine turn (migration 0082). A person is never counted.
  if (row.kind === 'guest' && owner.agentSub) await takeMachineTurn(env, threadId);
  const { text } = body;

  const thread = threadStub(env, threadId);
  const id = `msg_${randomToken(12)}`;
  const sentAt = Date.now();
  await thread.append(
    { sub: owner.sub, email: owner.email, name: owner.name },
    text,
    id,
    sentAt,
    'text',
    body.refs ?? [],
    {
      mentions: body.mentions ?? [],
      attachmentIds: body.attachments ?? [],
      replyToMessageId: body.reply_to_message_id ?? null,
      ...(via ? { via } : {}),
      ...(body.handoff ? { handoff: body.handoff } : {}),
    },
  );

  // Index write is what makes the conversation list current. It carries a
  // clipped preview only — never the whole body.
  await env.USAGE.prepare(
    `UPDATE threads SET last_message_at = ?2, last_message_preview = ?3, last_sender_email = ?4, last_origin = NULL
      WHERE id = ?1`,
  ).bind(threadId, sentAt, preview(text), owner.email).run();
  // Sending is reading: your own message must never come back as unread. This
  // clears the mention flag too, which is why it runs *before* the mentions
  // this message carries are written — the sender is excluded from those, but
  // the ordering is what makes that true rather than merely intended.
  await recordRead(env, threadId, owner, sentAt);
  await recordMentions(env, threadId, owner.sub, body.mentions ?? []);
  await recordCardLines(env, { threadId, messageId: id, at: sentAt, refs: body.refs ?? [] });

  // Anything in this conversation that is software gets told. Off the
  // response by design — the answer arrives minutes later through the inbound
  // door, and nobody waits on a build to see their own message appear.
  const wake = notifyThreadAgents(env, {
    threadId,
    threadKind: row.kind as ThreadKind,
    messageId: id,
    text,
    sentAt,
    sender: { email: owner.email, name: owner.name },
    refs: body.refs ?? [],
    mentions: body.mentions ?? [],
    ...(body.handoff ? { handoff: body.handoff } : {}),
  });
  if (ctx) ctx.waitUntil(wake);
  else void wake;

  // A member's own line in an app user's intake thread goes back to the app
  // (app-intake.ts). An agent acting through `/mcp` is not a member's line.
  if (row.kind === 'guest' && !owner.agentSub) {
    const reply = queueAppIntakeReply(env, { threadId, messageId: id, text, authorName: owner.name || owner.email.split('@')[0]! })
      .catch(() => console.error(JSON.stringify({ level: 'error', message: 'app_intake.reply.failed', status: -1 })));
    if (ctx) ctx.waitUntil(reply);
    else void reply;
  }

  // Read back rather than assembled here: the attachments this message carries
  // were bound inside the Durable Object, and inventing the response would mean
  // the sender's own copy is the one view in the product that never shows them.
  const page = await thread.messages(owner.sub, { limit: 1 });
  const stored = page.messages.find((message) => message.id === id);
  return {
    message: stored ?? {
      id,
      thread_id: threadId,
      sent_at: sentAt,
      sender_email: owner.email,
      sender_name: owner.name,
      text,
      is_mine: true,
      type: 'text',
      reply_to_message_id: body.reply_to_message_id ?? null,
      ...(via ? { via } : {}),
    },
  };
}

/**
 * Record one member's explicit selection on an agent-authored question. The
 * registered request picks the first valid answer; the DO projects it as one
 * reply. Unassigned legacy questions keep their existing DO authority.
 */
export async function answerThreadQuestion(
  owner: RoleSession,
  env: Env,
  threadId: string,
  questionMessageId: string,
  optionIds: string[],
  ctx?: ExecutionContext,
): Promise<ThreadQuestionAnswerResponse> {
  const row = await threadRow(env, threadId, owner);
  await requireThreadWrite(env, owner, row);
  const author = await messageSender(env, threadId, owner.sub, questionMessageId);
  if (author) await registerDirectQuestion(env, threadId, author, questionMessageId);
  const sentAt = Date.now();
  const result = await threadStub(env, threadId).answerQuestion(
    { sub: owner.sub, email: owner.email, name: owner.name },
    questionMessageId,
    `answer_${randomToken(12)}`,
    sentAt,
    optionIds,
  );

  if (result.inserted) {
    await env.USAGE.prepare(
      `UPDATE threads SET last_message_at = ?2, last_message_preview = ?3, last_sender_email = ?4, last_origin = NULL
        WHERE id = ?1 AND (last_message_at IS NULL OR last_message_at <= ?2)`,
    ).bind(threadId, result.message.sent_at, preview(result.message.text), owner.email).run();
    await recordRead(env, threadId, owner, result.message.sent_at);
    // The answer is about the question's card: its page shows it answered.
    await recordCardLines(env, {
      threadId,
      messageId: result.message.id,
      at: result.message.sent_at,
      refs: await cardRefsOfLine(env, threadId, questionMessageId),
    });

    const author = result.question ? (await agentByEmail(env, result.question.senderEmail)) : null;
    // The watchdog's Retry is the Worker's to act on: it hands the stuck
    // request to the agent again, instead of the answer as a turn.
    const watchdog = author && result.question
      ? await answerWatchdogRetry(env, author.email, threadId, result.question.id, result.message.question_answer?.option_ids ?? [])
      : false;
    if (author && result.question && !watchdog) {
      const wake = notifyAgentQuestionAnswer(env, {
        agentEmail: author.email,
        threadId,
        threadKind: row.kind as ThreadKind,
        messageId: result.message.id,
        questionMessageId: result.question.id,
        questionText: result.question.text,
        optionIds: result.message.question_answer?.option_ids ?? [],
        optionLabels: result.message.question_answer?.option_labels ?? [],
        sentAt: result.message.sent_at,
        sender: { email: owner.email, name: owner.name },
      });
      if (ctx) ctx.waitUntil(wake);
      else void wake;
    }
  }

  return { message: result.message, accepted: result.accepted };
}

/**
 * Record on an agent's release card what the member's device did in Keep
 *: approved it, or ended it. The device acts in Keep first. Then
 * the Worker reads the release from Keep as the card's agent and records
 * what Keep says: an approval only when Keep names this member as the
 * approver, an end only when Keep has ended it. Meet never sees the item or
 * a key. The agent hears of it at once.
 */
export async function updateThreadRelease(
  owner: RoleSession,
  env: Env,
  threadId: string,
  messageId: string,
  body: ThreadReleaseUpdateRequest,
  ctx?: ExecutionContext,
): Promise<ThreadReleaseUpdateResponse> {
  const row = await threadRow(env, threadId, owner);
  await requireThreadWrite(env, owner, row);
  const thread = threadStub(env, threadId);
  const card = await thread.releaseCard(owner.sub, messageId);
  const agent = card ? await agentByEmail(env, card.authorEmail) : null;
  if (!card || !agent) throw new ThreadError('That request is not open.', 409, 'release_request_closed');
  if (!keepEnabled(env)) throw new ControlError('This workspace has no Keep.', 404, 'not_configured');
  const release = await readKeepRelease(env, { email: agent.email, name: agent.name }, card.request.request_id);
  const at = Date.now();
  let update: ReleaseCardUpdate;
  if (body.action === 'approve') {
    const live = release && (release.status === 'live' || release.status === 'used');
    if (!release || !live || release.approver.toLowerCase() !== owner.email.toLowerCase()) {
      throw new ThreadError('Keep has no live release from you for this request.', 409, 'release_request_closed');
    }
    update = { action: 'approve', vaultId: release.vault_id, itemName: release.item_name, expiresAt: Date.parse(release.expires_at) };
  } else {
    if (!release || release.status !== 'ended') throw new ThreadError('Keep has not ended this release.', 409, 'release_request_closed');
    update = { action: 'end', endedBy: release.ended_by ?? owner.email };
  }
  const result = await thread.updateRelease({ sub: owner.sub, email: owner.email, name: owner.name }, messageId, update, at);
  if (result.changed) {
    const wake = notifyAgentRelease(env, {
      agentEmail: agent.email,
      threadId,
      threadKind: row.kind as ThreadKind,
      messageId,
      requestId: result.request.request_id,
      status: body.action === 'approve' ? 'approved' : 'ended',
      expiresAt: result.state.expires_at,
      sentAt: at,
      sender: { email: owner.email, name: owner.name },
    });
    if (ctx) ctx.waitUntil(wake);
    else void wake;
  }
  return { message: result.message };
}

/**
 * Add or remove one emoji on one message. A toggle at every layer — one press,
 * one row, one route — because two of anything here are two ways to disagree
 * about whether the pill is lit.
 */
export async function reactToMessage(
  owner: RoleSession,
  env: Env,
  threadId: string,
  messageId: string,
  emoji: string,
  ctx?: ExecutionContext,
): Promise<{ message_id: string; reactions: ThreadMessageReaction[] }> {
  const row = await threadRow(env, threadId, owner);
  await requireThreadWrite(env, owner, row);
  const thread = threadStub(env, threadId);
  // Read the author before toggling: the reaction itself is stored in the DO,
  // but only a message authored by an agent should wake a runtime.
  const target = await messageSender(env, threadId, owner.sub, messageId);
  const reactedAt = Date.now();
  const result = await thread.react(
    { sub: owner.sub, email: owner.email, name: owner.name },
    messageId,
    emoji,
    reactedAt,
  );
  // Deliberately not an index write. A reaction is not a message: it must not
  // reorder the conversation list, move the preview, or badge anybody — for
  // the same reason an event line does not.
  const agent = target && target.type === 'text' ? (await agentByEmail(env, target.email)) : null;
  if (agent?.endpoint) {
    const wake = notifyAgentReaction(env, {
      agentEmail: agent.email,
      threadId,
      threadKind: row.kind as ThreadKind,
      messageId,
      emoji,
      on: result.on,
      reactedAt,
      sender: { email: owner.email, name: owner.name },
    });
    if (ctx) ctx.waitUntil(wake);
    else void wake;
  }
  return { message_id: messageId, reactions: result.reactions };
}

/**
 * Rewrite your own message, inside the window. The preview follows only when
 * this was the last thing said here — editing an old message must not drag a
 * week-old sentence back onto the conversation list.
 */
export async function editMessage(
  owner: RoleSession,
  env: Env,
  threadId: string,
  messageId: string,
  text: string,
): Promise<MessageEditResponse> {
  await requireThreadWrite(env, owner, await threadRow(env, threadId, owner));
  const thread = threadStub(env, threadId);
  const result = await thread.edit(owner.sub, messageId, text, Date.now());
  await env.USAGE.prepare(
    `UPDATE threads SET last_message_preview = ?2
      WHERE id = ?1 AND last_message_at = ?3`,
  ).bind(threadId, preview(text), result.sentAt).run();
  return { message_id: messageId, text: result.text, edited_at: result.editedAt };
}

/**
 * Withdraw your own message. The transcript keeps the row and loses the text;
 * the bytes behind any attachment are deleted outright, because a file that
 * survives the message carrying it is a file nothing in the product can reach
 * and nobody remembers sharing.
 */
export async function withdrawMessage(
  owner: RoleSession,
  env: Env,
  threadId: string,
  messageId: string,
  ctx?: ExecutionContext,
): Promise<MessageWithdrawResponse> {
  await requireThreadWrite(env, owner, await threadRow(env, threadId, owner));
  const thread = threadStub(env, threadId);
  const result = await thread.withdraw(owner.sub, messageId, Date.now());

  if (result.attachmentIds.length > 0) {
    // Off the response: the metadata already says the file is gone, so every
    // surface is correct the moment this returns, and a slow bucket must not
    // hold up somebody taking back something they regret.
    const purge = purgeAttachments(env, threadId, result.attachmentIds);
    if (ctx) ctx.waitUntil(purge);
    else void purge;
  }

  // The preview is only stale when the withdrawn message was the last thing
  // said. Left alone otherwise — rewriting it would mean re-reading the
  // transcript to find what is now newest, on every delete.
  await env.USAGE.prepare(
    `UPDATE threads SET last_message_preview = 'Message withdrawn'
      WHERE id = ?1 AND last_sender_email = ?2 AND last_message_at = (
        SELECT last_message_at FROM threads WHERE id = ?1
      ) AND last_message_preview IS NOT NULL`,
  ).bind(threadId, owner.email).run();

  return { message_id: messageId, deleted_at: result.deletedAt };
}

/** Best effort, like every storage delete: the metadata is already authoritative. */
async function purgeAttachments(env: Env, threadId: string, ids: string[]): Promise<void> {
  try {
    await env.ATTACHMENTS.delete(ids.map((id) => attachmentKey(threadId, id)));
  } catch (error) {
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'threads.attachments.purge.failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
  }
}

/**
 * Where one file's bytes live. Namespaced by thread so a listing can never
 * cross conversations, and never derived from the person's file name — a name
 * is theirs to choose and an object key is not a place to let them.
 */
export function attachmentKey(threadId: string, attachmentId: string): string {
  return `threads/${threadId}/${attachmentId}`;
}

/**
 * Reserve somewhere to put one file, before its message exists.
 *
 * Two steps rather than one multipart send, and the split is deliberate: the
 * metadata write is small and transactional, the bytes are up to
 * `ATTACHMENT_MAX_BYTES` and may fail halfway. A composer that has staged and
 * not yet uploaded shows a row it can retry; one that uploaded and was never
 * sent leaves an unbound row nothing reads.
 *
 * The declared size is a *reservation*, not a promise — the upload below
 * refuses anything larger than what was reserved, so the ceiling cannot be
 * beaten by understating it here.
 */
export async function stageAttachment(
  owner: RoleSession,
  env: Env,
  threadId: string,
  input: AttachmentCreateInput,
): Promise<{ attachment: ThreadMessageAttachment; upload_path: string }> {
  await requireThreadWrite(env, owner, await threadRow(env, threadId, owner));
  if (!env.ATTACHMENTS) throw new ThreadError('Attachments are not configured.', 503, 'not_configured');

  const id = `att_${randomToken(16)}`;
  const contentType = attachmentContentType(input.content_type);
  const thread = threadStub(env, threadId);
  await thread.stageAttachment(owner.sub, {
    id,
    name: input.name,
    contentType,
    bytes: input.bytes,
    width: input.width,
    height: input.height,
  }, Date.now());

  const attachment: ThreadMessageAttachment = {
    id,
    name: input.name,
    content_type: contentType,
    bytes: input.bytes,
  };
  if (input.width !== undefined) attachment.width = input.width;
  if (input.height !== undefined) attachment.height = input.height;
  return {
    attachment,
    upload_path: `/api/threads/${encodeURIComponent(threadId)}/attachments/${id}`,
  };
}

/**
 * The bytes for a staged attachment. Only its own uploader may write them, and
 * only while it is still unbound: once a message is carrying a file, replacing
 * what is behind it would rewrite something colleagues have already read.
 */
export async function uploadAttachment(
  owner: RoleSession,
  env: Env,
  threadId: string,
  attachmentId: string,
  body: Uint8Array,
): Promise<AttachmentUploadedResponse> {
  await requireThreadWrite(env, owner, await threadRow(env, threadId, owner));
  if (!env.ATTACHMENTS) throw new ThreadError('Attachments are not configured.', 503, 'not_configured');

  const thread = threadStub(env, threadId);
  const staged = await thread.attachment(owner.sub, attachmentId);
  if (!staged) throw new ThreadError('That upload is gone.', 404, 'room_not_found');
  if (staged.message_id !== null) {
    throw new ThreadError('That file has already been sent.', 409, 'message_not_editable');
  }

  if (body.byteLength === 0) throw new ThreadError('That file is empty.', 400, 'invalid_request');
  // Against the reservation as well as the ceiling: understating the size at
  // staging must not become a way past the limit.
  if (body.byteLength > Math.min(staged.bytes, ATTACHMENT_MAX_BYTES)) {
    throw new ThreadError('That file is larger than you said.', 413, 'capacity_reached');
  }

  await env.ATTACHMENTS.put(attachmentKey(threadId, attachmentId), body, {
    httpMetadata: { contentType: staged.content_type },
  });
  return { ok: true, id: attachmentId, bytes: body.byteLength };
}

/**
 * Serve one file to somebody in the conversation. Membership is the whole of
 * the authorization and it is checked twice — at the Worker for the thread, and
 * inside the Durable Object for the attachment — because an object key is the
 * one thing here that could otherwise be shared out of the product by accident.
 *
 * Always a download unless the type is one we are willing to render. Anything
 * unlisted is served as `application/octet-stream` with an attachment
 * disposition: a file a colleague uploaded must never execute on an origin
 * that also serves the app.
 */
export async function serveAttachment(
  owner: RoleSession,
  env: Env,
  threadId: string,
  attachmentId: string,
): Promise<Response> {
  await threadRow(env, threadId, owner);
  if (!env.ATTACHMENTS) throw new ThreadError('Attachments are not configured.', 503, 'not_configured');

  const thread = threadStub(env, threadId);
  const record = await thread.attachment(owner.sub, attachmentId);
  if (!record) throw new ThreadError('That file is gone.', 404, 'room_not_found');
  const object = await env.ATTACHMENTS.get(attachmentKey(threadId, attachmentId));
  if (!object) throw new ThreadError('That file is gone.', 404, 'room_not_found');

  const inline = (ATTACHMENT_INLINE_CONTENT_TYPES as readonly string[]).includes(record.content_type);
  return new Response(object.body, {
    headers: {
      'content-type': inline ? record.content_type : 'application/octet-stream',
      // The name is the person's, so it is quoted and stripped of anything
      // that could end the header early rather than trusted into it.
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${safeFilename(record.name)}"`,
      'content-length': String(record.bytes),
      // An attachment id is minted once and never reused, so the bytes behind
      // this URL cannot change. `private` because only members may hold it.
      'cache-control': 'private, max-age=31536000, immutable',
      // Belt and braces beside the octet-stream fallback: nothing served from
      // here is ever to be sniffed into something executable.
      'x-content-type-options': 'nosniff',
    },
  });
}

/** Unlisted types still travel — as a download, never as something to render. */
function attachmentContentType(declared: string): string {
  const value = declared.split(';')[0]?.trim().toLowerCase() ?? '';
  return (ATTACHMENT_INLINE_CONTENT_TYPES as readonly string[]).includes(value)
    ? value
    : 'application/octet-stream';
}

function safeFilename(name: string): string {
  // Quotes, backslashes and control characters are the three ways a filename
  // ends a header and starts writing its own.
  return name.replace(/["\\\u0000-\u001f\u007f]/gu, '_').slice(0, ATTACHMENT_NAME_MAX_CHARS);
}

export async function markThreadRead(
  owner: RoleSession,
  env: Env,
  threadId: string,
  at?: number,
): Promise<ThreadReadResponse> {
  await threadRow(env, threadId, owner);
  const readAt = at ?? Date.now();
  await recordRead(env, threadId, owner, readAt);
  return { ok: true, read_at: readAt };
}

/**
 * Read state, upserted rather than updated. A DM member always has a row; a
 * channel reader has one only once they have read it, and that first read is
 * what creates it.
 *
 * Takes only `sub`/`email` — never the full `OwnerSession` — so a caller who
 * knows an actor's identity but never signed them into a session (a request
 * handler's own `owner`, passed through for someone else's read) can call
 * this too.
 */
async function recordRead(
  env: Env,
  threadId: string,
  owner: Pick<OwnerSession, 'sub' | 'email'>,
  readAt: number,
): Promise<void> {
  await env.USAGE.prepare(
    `INSERT INTO thread_members (thread_id, member_sub, member_email, last_read_at, has_mention)
     VALUES (?1, ?2, ?3, ?4, 0)
       ON CONFLICT(thread_id, member_sub) DO UPDATE SET last_read_at = ?4, has_mention = 0`,
  ).bind(threadId, owner.sub, owner.email, readAt).run();
}

/**
 * Put one conversation away, or take it back out.
 *
 * Per-member for the same reason a mute is: a conversation you are done with
 * is still in the other person's list.
 *
 * Nothing ever clears `archived_at`. `listThreads` compares it against the
 * newest message, so the next thing anybody says brings the row back on its
 * own — no unarchive write, and no way for a message to arrive into a
 * conversation that has been filtered out for good. Un-archiving by hand is
 * the same call with `archived: false`, which is only needed to undo a
 * mistake.
 */
export async function setThreadArchived(
  owner: RoleSession,
  env: Env,
  threadId: string,
  archived: boolean,
): Promise<ThreadArchiveResponse> {
  const thread = await threadRow(env, threadId, owner);
  // Archive is a DM-only control on every client — a channel archived here
  // would just vanish from this one member's list with no UI path back.
  if (thread.kind !== 'dm') {
    throw new ThreadError('Only a direct conversation can be archived.', 400, 'invalid_request');
  }
  const archivedAt = archived ? Date.now() : null;
  await env.USAGE.prepare(
    `INSERT INTO thread_members (thread_id, member_sub, member_email, last_read_at, archived_at)
     VALUES (?1, ?2, ?3, 0, ?4)
       ON CONFLICT(thread_id, member_sub) DO UPDATE SET archived_at = ?4`,
  ).bind(threadId, owner.sub, owner.email, archivedAt).run();
  return { ok: true, archived_at: archivedAt };
}

/**
 * Silence one conversation, or let it speak again.
 *
 * Muting is per-member read state, which is why it lives on the same row as
 * `last_read_at` rather than on the thread: a channel one person has heard
 * enough of is still the channel everybody else is working in.
 *
 * A mute never suppresses a mention. The two flags are read together
 * everywhere, and a mute that also swallowed your name would make the quiet
 * option the one nobody can afford to choose.
 */
export async function setThreadMute(
  owner: RoleSession,
  env: Env,
  threadId: string,
  until: number | null,
): Promise<ThreadMuteResponse> {
  await threadRow(env, threadId, owner);
  await env.USAGE.prepare(
    `INSERT INTO thread_members (thread_id, member_sub, member_email, last_read_at, muted_until)
     VALUES (?1, ?2, ?3, 0, ?4)
       ON CONFLICT(thread_id, member_sub) DO UPDATE SET muted_until = ?4`,
  ).bind(threadId, owner.sub, owner.email, until).run();
  return { ok: true, muted_until: until };
}

/**
 * Flag everybody this message named, so the conversation list can be loud for
 * them and quiet for everybody else.
 *
 * Only members are flagged, and only ones who are not the sender. A mention
 * that matches nobody is dropped rather than refused — it is a stale address
 * or a typo, and failing the send over it would lose the message somebody
 * actually wrote.
 */
async function recordMentions(
  env: Env,
  threadId: string,
  senderSub: string,
  mentions: string[],
): Promise<void> {
  const addresses = [...new Set(mentions.map((email) => email.toLowerCase()))];
  if (addresses.length === 0) return;
  const list = addresses.map((_, index) => `?${index + 3}`).join(', ');
  try {
    await env.USAGE.prepare(
      `UPDATE thread_members SET has_mention = 1
        WHERE thread_id = ?1 AND member_sub != ?2 AND member_email IN (${list})`,
    ).bind(threadId, senderSub, ...addresses).run();
  } catch (error) {
    // Delivery loudness is not worth failing a sent message over: the message
    // is already in the transcript by the time this runs.
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'threads.mentions.failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
  }
}

/**
 * The audience is the authorization: a DM needs a membership row (and, for
 * an agent acting as the person, the agent's own row too:), a channel
 * needs only a caller who got this far, which `requireCapability` has
 * already decided. Anyone else gets the same 404 a missing thread gets —
 * whether a conversation exists is not something to leak. A removed channel
 * is a missing thread to everybody until something brings its
 * subject back (`ensureSubjectThread`, `appendInboundMessage`).
 */
async function threadRow(env: Env, threadId: string, owner: OwnerSession): Promise<ThreadRow> {
  const row = await env.USAGE.prepare(
    `SELECT ${THREAD_COLUMNS}
       FROM threads t
       LEFT JOIN thread_members m ON m.thread_id = t.id AND m.member_sub = ?2
      WHERE t.id = ?1 AND ${conversationVisibleSql('t', 'm', '?3')}
        AND t.removed_at IS NULL
        AND NOT ${subjectHiddenSql('t.kind', 't.parent_id', '?2', '?3')}`,
  ).bind(threadId, owner.sub, sessionAgentBind(owner)).first<ThreadRow>();
  if (!row) throw new ThreadError('Conversation not found.', 404, 'room_not_found');
  return row;
}

/**
 * Talk on a subject is a write onto that subject (docs/ACCESS.md): a member
 * whose grant on a restricted subject is `read` sees the channel and cannot
 * speak in it. Personal state (read, archive, mute) is not a write.
 */
async function requireThreadWrite(env: Env, owner: RoleSession, row: ThreadRow): Promise<void> {
  if (!row.parent_id) return;
  // A guest thread writes onto the subject it belongs to.
  const subject = row.kind === 'guest' ? parseGuestParent(row.parent_id) : isSubjectKind(row.kind) ? { kind: row.kind, id: row.parent_id } : null;
  if (subject) (await subjectAccessFor(env, owner)).requireWrite(subject.kind, subject.id);
}

async function summarize(env: Env, row: ThreadRow, owner: OwnerSession): Promise<ThreadSummary> {
  // No other member means this is a note to self: name it after the owner
  // rather than leaving a conversation with no title.
  const others = row.kind === 'dm' ? await otherMembers(env, row.id, owner.sub) : [];
  const peers = row.kind === 'dm'
    ? (others.length > 0 ? others : [{ email: owner.email, name: owner.name, kind: 'human' as const }])
    : null;
  return {
    id: row.id,
    kind: row.kind as ThreadKind,
    parent_id: row.parent_id,
    audience: row.audience === 'everyone' ? 'everyone' : 'members' satisfies ThreadAudience,
    title: row.title,
    peer_email: peers?.[0]?.email ?? null,
    peer_name: peers?.[0]?.name ?? null,
    ...(peers ? { peers } : {}),
    last_message_at: row.last_message_at,
    last_message_preview: row.last_message_preview,
    last_sender_email: row.last_sender_email,
    unread: (row.last_message_at ?? 0) > row.last_read_at,
    last_read_at: row.last_read_at,
    // A mention only counts while there is something unread carrying it. The
    // flag is cleared on read, and this second test is what keeps a row that
    // was read on another device from staying loud until this one catches up.
    has_mention: row.has_mention === 1 && (row.last_message_at ?? 0) > row.last_read_at,
    muted_until: row.muted_until !== null && row.muted_until > Date.now() ? row.muted_until : null,
    archived_at: row.archived_at,
    ...inboundAddressField(env, row),
  };
}

/**
 * The address a subject channel takes forwarded email at. Absent
 * on a DM and on the team channel, and on every row while Email Routing is
 * not configured — a client draws the copy action only when the field is
 * there. The readable slug when one was minted, the id spelling otherwise.
 */
function inboundAddressField(env: Env, row: ThreadRow): { inbound_address?: string } {
  const mailbox = channelMailbox(env);
  if (!mailbox || !row.parent_id) return {};
  if (row.kind !== 'project' && row.kind !== 'lead' && row.kind !== 'organization' && row.kind !== 'event') return {};
  const local = row.inbound_local ?? idLocalPart(row.kind, row.parent_id);
  return { inbound_address: inboundAddress(mailbox, local) };
}

/**
 * Everybody else in a conversation.
 *
 * Ordered by address rather than by when they were added, so the same group
 * reads the same way to all of its members — a roster that is also a title
 * cannot depend on who created it.
 */
async function otherMembers(
  env: Env,
  threadId: string,
  sub: string,
): Promise<ThreadPeer[]> {
  const { results } = await env.USAGE.prepare(
    `SELECT m.member_email AS email, p.name AS name,
            CASE WHEN p.kind = 'agent' THEN 'agent' ELSE 'human' END AS kind
       FROM thread_members m
       LEFT JOIN people p ON p.sub = m.member_sub
      WHERE m.thread_id = ?1 AND m.member_sub != ?2
      ORDER BY m.member_email
      LIMIT ?3`,
  ).bind(threadId, sub, THREAD_GROUP_MAX_MEMBERS).all<ThreadPeer>();
  return results;
}

/**
 * A person, or an agent.
 *
 * An agent's `people` row is derived from `AGENT_ROSTER` rather than written
 * at sign-in, and at first the only thing that derived it was a roster
 * read. That made "can I message this agent" depend on whether anybody had
 * looked at Team first — true on every real client and false the first time
 * something addressed an agent directly. The miss re-derives the rows and
 * asks again, so the map alone is enough to make an agent reachable.
 */
export async function memberByEmail(
  env: Env,
  email: string,
): Promise<{ sub: string; email: string } | null> {
  const lookup = async () => env.USAGE.prepare(
    'SELECT sub, email FROM people WHERE email = ?1',
  ).bind(email.toLowerCase()).first<{ sub: string; email: string }>();

  const row = await lookup();
  if (row) return row;
  if (!(await agentByEmail(env, email))) return null;
  await ensureAgentPeople(env, Date.now());
  return await lookup() ?? null;
}

function preview(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length <= MESSAGE_PREVIEW_MAX_CHARS
    ? flat
    : `${flat.slice(0, MESSAGE_PREVIEW_MAX_CHARS - 1)}…`;
}
