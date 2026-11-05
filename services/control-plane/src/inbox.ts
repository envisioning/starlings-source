import { listAttentionForOwner } from './attention-api';
import { workspaceDefaults } from './workspace-defaults';
// INBOX — one per-user feed ( decision 4, slice 2b).
// Sources with a resolution, merged newest first — the list is
// `INBOX_SOURCE_SPECS` in the contract, and a person turns each on or off
// in `work_preferences.inbox_sources`: unread subject talk (loud when it
// names you), Core-proposed tasks, unfiled Quick Notes, CRM touches with no
// lead yet when Sales is on for you, open comment threads on documents about
// listed subjects, guests who booked, moved or cancelled a time on
// your page, calendar invitations waiting on your answer and events read
// from mail forwarded to calendar@, and (admins) companies that filled in
// /interest. Calendar invitations come first, soonest event first; decisions
// waiting on you (Meet's own D1) follow, in their queue order.
// Under them, a capped
// RECENT tail: interactions on this person's listed subjects (not muted;
// leads only with Sales on), last seven days, never counted — see `@starlings/contracts/inbox` for why the two halves
// are kept apart.
//
// Every source is read on its own and named in `partial` when it fails: an
// inbox that came back short must say so, or a quiet morning and a broken
// read look the same.

import { hostBookings } from './booking-store';
import { bookingRoomFor } from './booking-settings';
import {
  INBOX_BOOKING_CHANGE_WINDOW_MS,
  INBOX_COMMENT_DOCUMENT_LIMIT,
  INBOX_COMMENT_LIST_PAGE,
  INBOX_COMMENT_LIST_PAGES,
  INBOX_PROPOSED_PAGE,
  INBOX_PROPOSED_PAGES,
  INBOX_RECENT_LIMIT,
  INBOX_RECENT_WINDOW_MS,
  resolveInboxSources,
  type InboxItem,
  type InboxRecentEntry,
  type InboxResponse,
  type InboxSource,
} from '@starlings/contracts/inbox';
import { resolveSubjectState, subjectGroup } from '@starlings/contracts/subject-state';
import { inboxRecentSubjectGroup } from '@starlings/contracts/inbox';
import type { QuickNote } from '@starlings/contracts/quick-notes';
import type { DocsDocumentSummary } from '@starlings/contracts';
import type { RoleSession } from './capabilities';
import type { CrmSubject, CrmTask, ThreadSummary } from './contracts';
import { openSubjects } from './board';
import { getCalendarPreferences, isCalendarConnected, readCalendarInvitations } from './calendar';
import { listPendingEvents } from './pending-calendar-events';
import { roleAllows } from './capabilities';
import { staleOnError } from './core-cache';
import { crmSyncEnabled, workModelEnabled, fetchCachedPartnerSubjects, fetchCrmTasksByStatus, fetchHostBookings, fetchUntriagedTouches, type CoreHostBooking } from './crm';
import { docsEnabled, listDocsAnnotations, listDocsDocuments } from './docs';
import { entryTimeMs, fetchRecentFeed } from './feed';
import { subjectAccessFor } from './subject-access';
import { readDismissedInboxKeys } from './inbox-dismissed';
import { interestInboxItems } from './interest';
import { formInboxItems } from './forms';
import { guestInboxItems } from './support-requests';
import { supportInboxItems } from './support-line';
import { decisionInboxItems } from './decision-asks';
import { cardInboxItems } from './card-holds';
import { followUpInboxItems } from './follow-ups';
import { readSubjectState } from './subject-state';
import { listThreadsFor } from './threads';
import { availableInboxSources, isInboxAdmin } from './inbox-audience';
import { quickNotesStub } from './do-jurisdiction';
import { sessionAgent } from './agent-boundary';
import { subjectKindFilter, workModulesOn } from './work-modules';
import { commercialInboxItems } from './inbox-commercial';
import type { SubjectKind } from '@starlings/contracts/subject-kinds';

function warn(message: string, error: unknown): void {
  console.warn(JSON.stringify({
    level: 'warn',
    message,
    error: error instanceof Error ? error.message : 'Unknown error',
  }));
}

function isoMs(raw: string | null | undefined): number {
  const ms = raw ? Date.parse(raw) : Number.NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

async function talkItems(env: Env, owner: RoleSession): Promise<InboxItem[]> {
  const { threads } = await listThreadsFor(env, owner);
  return threads
    .filter((thread: ThreadSummary) => (thread.kind === 'project' || thread.kind === 'lead' || thread.kind === 'organization' || thread.kind === 'event') && thread.unread)
    .map((thread): InboxItem => ({
      key: `${thread.has_mention ? 'mention' : 'talk'}:${thread.id}`,
      at: thread.last_message_at ?? 0,
      source: thread.has_mention ? 'mention' : 'talk',
      thread,
    }));
}

async function proposedTaskItems(
  env: Env,
  subjects: CrmSubject[],
  onSubjectFailed: (subject: CrmSubject, error: unknown) => void,
): Promise<{ items: InboxItem[]; truncated: boolean }> {
  const items: InboxItem[] = [];
  // Leads and projects carry tasks, and so do partners (their own tasks, no
  // project or lead). Every subject is a candidate: the board skips subjects
  // whose `open_tasks` is zero, but that count excludes `proposed` on purpose
  // (: not yet anybody's work), so a subject with nothing open may
  // still hold a proposal.
  const candidates = subjects.filter((subject) => subject.kind === 'project' || subject.kind === 'lead');
  // Partners resolve proposals through one cached list read, never one task
  // read each.
  const partners = await fetchCachedPartnerSubjects(env).catch((error: unknown) => {
    warn('inbox.task.partners.failed', error);
    onSubjectFailed({ kind: 'organization', id: 'partners', title: 'Partners' } as CrmSubject, error);
    return [] as CrmSubject[];
  });
  const item = (task: CrmTask, subject: CrmSubject): InboxItem => ({
    key: `task:${task.id}`,
    at: isoMs(task.updated_at),
    source: 'task',
    task,
    subject: { kind: subject.kind as 'lead' | 'project' | 'organization', id: subject.id, title: subject.title },
  });

  // One read across every subject, paged. Eighty per-subject reads, beside
  // the feed's eighty, spent the invocation's subrequest budget and every
  // subject came back "Couldn't read". A proposal on a subject that is not
  // open is not in play, so it is left out here as the walk left it out.
  // Past the page ceiling the read is short and says so.
  const bySubject = new Map([...candidates, ...partners].map((subject) => [`${subject.kind}:${subject.id}`, subject]));
  const seen = new Set<string>();
  let truncated = false;
  let page = await staleOnError('tasks-status/proposed/0', () => fetchCrmTasksByStatus(env, 'proposed', INBOX_PROPOSED_PAGE));
  for (let index = 0; ; index += 1) {
    for (const task of page.filter((row) => !seen.has(row.id))) {
      seen.add(task.id);
      const subject = task.project_id
        ? bySubject.get(`project:${task.project_id}`)
        : task.lead_id ? bySubject.get(`lead:${task.lead_id}`)
          : task.organization_id && !task.event_id && !task.meeting_id ? bySubject.get(`organization:${task.organization_id}`) : undefined;
      if (subject) items.push(item(task, subject));
    }
    if (page.length < INBOX_PROPOSED_PAGE) break;
    if (index + 1 >= INBOX_PROPOSED_PAGES) {
      truncated = true;
      break;
    }
    page = await staleOnError(`tasks-status/proposed/${(index + 1) * INBOX_PROPOSED_PAGE}`, () => fetchCrmTasksByStatus(env, 'proposed', INBOX_PROPOSED_PAGE, (index + 1) * INBOX_PROPOSED_PAGE));
  }
  return { items, truncated };
}

async function noteItems(env: Env, owner: RoleSession): Promise<InboxItem[]> {
  // Quick Notes are "Only you": an agent reading INBOX as the owner gets none.
  if (sessionAgent(owner)) return [];
  const notes = await quickNotesStub(env, owner.sub);
  const response = await notes.fetch('https://quick-notes/notes');
  if (!response.ok) throw new Error(`Quick Notes read failed (${response.status}).`);
  const body = await response.json() as { notes?: QuickNote[] };
  return (body.notes ?? [])
    .filter((note) => note.state === 'open')
    .map((note): InboxItem => ({ key: `note:${note.id}`, at: isoMs(note.updated_at || note.created_at), source: 'note', note }));
}

async function salesItems(env: Env, owner: RoleSession): Promise<InboxItem[]> {
  const { data: touches } = await fetchUntriagedTouches(env, owner.email, { limit: 50 });
  return touches.map((touch): InboxItem => ({ key: `sales:${touch.id}`, at: isoMs(touch.occurred_at), source: 'sales', touch }));
}

const COMMENT_CONCURRENCY = 4;

/**
 * Open comment threads on documents about your listed subjects, whose
 * last word is not yours ( slice 2). Docs has no cross-document
 * annotation list, so this reads the documents Meet wrote about a listed
 * subject — newest first, capped — and asks each for its threads. There is
 * no age window: a comment does not touch the document's `updated_at`, so
 * a fortnight's cut-off dropped open threads on quiet documents.
 * Past the cap the rest are unread, and `truncated` says so.
 */
async function commentItems(
  env: Env,
  owner: RoleSession,
  subjects: CrmSubject[],
  listed: (subject: CrmSubject) => boolean,
): Promise<{ items: InboxItem[]; truncated: boolean }> {
  const wanted = new Map(subjects.filter(listed).map((subject) => [`${subject.kind}:${subject.id}`, subject]));
  if (wanted.size === 0) return { items: [], truncated: false };
  // Only documents with an open thread, and every page of them up to the
  // ceiling: `open_annotations` is Docs' own projection, so a
  // quiet document with a thread from months ago is in the list, not past
  // its end. A Docs that predates the filter answers every document, which
  // the subject match and the read cap below cut as before.
  const documents: DocsDocumentSummary[] = [];
  let truncated = false;
  for (let index = 0; index < INBOX_COMMENT_LIST_PAGES; index += 1) {
    const page = await listDocsDocuments(env, owner.email, {
      source: 'native',
      open_annotations: true,
      limit: INBOX_COMMENT_LIST_PAGE,
      offset: index * INBOX_COMMENT_LIST_PAGE,
    });
    const known = new Set(documents.map((document) => document.id));
    const fresh = page.documents.filter((document) => !known.has(document.id));
    if (index > 0 && fresh.length === 0) {
      // The same page again: this Docs does not page.
      truncated = true;
      break;
    }
    documents.push(...fresh);
    if (page.documents.length < INBOX_COMMENT_LIST_PAGE || documents.length >= page.total) break;
    if (index + 1 >= INBOX_COMMENT_LIST_PAGES) truncated = true;
  }
  const about = documents
    .map((document) => ({
      document,
      subject: document.subjects.map((subject) => wanted.get(`${subject.kind}:${subject.subject_id}`)).find(Boolean) ?? null,
    }))
    .filter((entry) => entry.subject)
    .sort((a, b) => isoMs(b.document.updated_at) - isoMs(a.document.updated_at));
  const candidates = about.slice(0, INBOX_COMMENT_DOCUMENT_LIMIT);
  if (about.length > candidates.length) truncated = true;

  const me = owner.email.trim().toLowerCase();
  const items: InboxItem[] = [];
  for (let start = 0; start < candidates.length; start += COMMENT_CONCURRENCY) {
    const batch = candidates.slice(start, start + COMMENT_CONCURRENCY);
    const results = await Promise.all(batch.map(async (entry) => ({ ...entry, annotations: await listDocsAnnotations(env, owner.email, entry.document.id) })));
    for (const { document, subject, annotations } of results) {
      const byThread = new Map<string, typeof annotations>();
      for (const annotation of annotations) {
        const list = byThread.get(annotation.thread_id) ?? [];
        list.push(annotation);
        byThread.set(annotation.thread_id, list);
      }
      for (const list of byThread.values()) {
        const sorted = list.slice().sort((a, b) => a.created_at.localeCompare(b.created_at));
        const root = sorted.find((annotation) => annotation.parent_id === null) ?? sorted[0]!;
        const latest = sorted[sorted.length - 1]!;
        if (root.status !== 'open') continue;
        if (latest.author.trim().toLowerCase() === me) continue;
        items.push({
          key: `comment:${root.thread_id}`,
          at: isoMs(latest.created_at),
          source: 'comment',
          document: { id: document.id, title: document.title, path: document.path },
          subject: subject ? { kind: subject.kind as 'lead' | 'project', id: subject.id, title: subject.title } : null,
          thread: root,
          latest,
          replies: sorted.length - 1,
        });
      }
    }
  }
  return { items, truncated };
}

/**
 * Guests who booked, moved or cancelled a time on your page. A booking is
 * the one item an outsider makes, so it is read from Core, not from the
 * calendar: the calendar event says when, the row says who and why. Only
 * `self` bookings — invites the host issued from Meet are their own doing.
 *
 * `booked` resolves when the event is filed under a subject
 * (`event_subjects`, the calendar's own map), when the row is dismissed,
 * or when the window opens. `rescheduled` is the same row under a key that
 * names the move, so a dismissed booking that moves is news again.
 * `cancelled` resolves by dismiss or after a week; a cancelled booking
 * whose window was already past is not news.
 */
async function bookingItems(env: Env, owner: RoleSession, dismissed: Set<string>): Promise<InboxItem[]> {
  const hostUsername = await bookingRoomFor(env, owner);
  // No room, no booking page, nothing to read.
  if (!hostUsername) return [];
  const now = Date.now();
  // `from` reaches back a week so a cancellation of what was to be this
  // week still arrives; confirmed rows past their start are dropped below.
  const from = now - INBOX_BOOKING_CHANGE_WINDOW_MS;
  const [d1, core, prefs] = await Promise.all([
    // Bookings taken on Meet's booking page, on every workspace.
    hostBookings(env, owner.sub, from),
    // Bookings guests made on Core's pages: before Envisioning's switch, and
    // their moves and cancellations after it. A booking Meet's page took is
    // in Core as a host-issued (`event`) row, so `self` never repeats one.
    crmSyncEnabled(env)
      ? fetchHostBookings(env, owner.email, { hostUsername, from: new Date(from), source: 'self', status: 'all' })
      : Promise.resolve([]),
    getCalendarPreferences(env, owner),
  ]);
  const bookings = [...d1, ...core];
  const wire = (booking: CoreHostBooking) => ({
    id: booking.id,
    title: booking.title,
    guest_name: booking.guest_name,
    guest_email: booking.guest_email,
    guest_title: booking.guest_title,
    guest_organization: booking.guest_organization,
    guest_notes: booking.guest_notes,
    start_time: booking.start_time,
    end_time: booking.end_time,
    google_event_id: booking.google_event_id,
    nda_required: booking.nda_required,
    created_at: booking.created_at,
    cancelled_at: booking.cancelled_at ?? null,
    rescheduled_at: booking.rescheduled_at ?? null,
    previous_start_time: booking.previous_start_time ?? null,
    previous_end_time: booking.previous_end_time ?? null,
  });
  const items: InboxItem[] = [];
  for (const booking of bookings) {
    const eventKey = booking.google_event_id ? `event:g:${booking.google_event_id}` : null;
    if (booking.status === 'cancelled') {
      const cancelledAt = isoMs(booking.cancelled_at);
      // No stamp: a Core before the change columns, or a row cancelled
      // before them. Not news either way.
      if (!cancelledAt || cancelledAt < now - INBOX_BOOKING_CHANGE_WINDOW_MS) continue;
      // A cancellation of a meeting that had already started is history.
      if (isoMs(booking.start_time) <= cancelledAt && isoMs(booking.start_time) <= now) continue;
      const key = `booking:${booking.id}:cancelled:${cancelledAt}`;
      if (dismissed.has(key)) continue;
      items.push({ key, at: cancelledAt, source: 'booking', change: 'cancelled', booking: wire(booking), event_key: eventKey });
      continue;
    }
    if (booking.status !== 'confirmed') continue;
    // Started (or about to): the launch card owns it from here.
    if (isoMs(booking.start_time) <= now) continue;
    if (eventKey && prefs.eventSubjects[eventKey]) continue;
    const rescheduledAt = isoMs(booking.rescheduled_at);
    const key = rescheduledAt ? `booking:${booking.id}:rescheduled:${rescheduledAt}` : `booking:${booking.id}`;
    if (dismissed.has(key)) continue;
    items.push({
      key,
      at: rescheduledAt || isoMs(booking.created_at),
      source: 'booking',
      change: rescheduledAt ? 'rescheduled' : 'booked',
      booking: wire(booking),
      event_key: eventKey,
    });
  }
  return items;
}

/**
 * Google invitations still waiting on your answer, from every connected
 * account. A row leaves when you answer it here or anywhere else, or when
 * the event ends; the Calendar list reaches back a month, INBOX does not.
 * No calendar connected is nothing to read, not a failed read.
 */
async function invitationItems(env: Env, owner: RoleSession): Promise<InboxItem[]> {
  if (!(await isCalendarConnected(env, owner.sub))) return [];
  const now = Date.now();
  return (await readCalendarInvitations(env, owner))
    .filter(({ event }) => Date.parse(event.end) > now)
    .map(({ event, updatedMs }): InboxItem => ({
      key: `invitation:${event.id}`,
      at: updatedMs || isoMs(event.start),
      source: 'invitation',
      event,
    }));
}

/**
 * Invitations in the order INBOX shows them, at the top: the event that
 * starts first comes first. A Home card draws three rows, and an invitation
 * under the decisions was an invitation nobody saw.
 */
export function invitationsByStart(items: InboxItem[]): InboxItem[] {
  const startMs = (item: InboxItem) => (item.source === 'invitation' ? isoMs(item.event.start) : 0);
  return items.slice().sort((a, b) => startMs(a) - startMs(b) || a.key.localeCompare(b.key));
}

/** Events read from mail forwarded to calendar@, until added, discarded or a week old. */
async function forwardedItems(env: Env, owner: RoleSession): Promise<InboxItem[]> {
  return (await listPendingEvents(env, owner.sub))
    .map((event): InboxItem => ({ key: `forwarded:${event.id}`, at: event.created_at, source: 'forwarded', event }));
}

export async function fetchInbox(env: Env, owner: RoleSession, includeQuestions = false, includeCards = false, includeFollowUps = false, includeCalendar = false): Promise<InboxResponse> {
  const partial: InboxSource[] = [];
  const capped: InboxSource[] = [];
  const attempt = async (source: InboxSource, read: () => Promise<InboxItem[]>): Promise<InboxItem[]> => {
    try {
      return await read();
    } catch (error) {
      partial.push(source);
      warn(`inbox.${source}.failed`, error);
      return [];
    }
  };

  const modules = await workModulesOn(env);
  const eligibleSources = availableInboxSources(env, owner, modules);
  const [state, dismissed, defaults] = await Promise.all([
    readSubjectState(env, owner.sub, owner.role, eligibleSources),
    readDismissedInboxKeys(env, owner.sub),
    workspaceDefaults(env),
  ]);
  // Which sources this person wants; a source turned off is not read at
  // all, so it can neither cost a subrequest nor show in `partial`.
  const on = resolveInboxSources(state.inbox_sources);
  const canReadInterest = eligibleSources.includes('interest') && on.interest;
  const canReadSubmissions = eligibleSources.includes('submission') && on.submission;
  // The calendar routes refuse agents; INBOX read through an agent does too.
  const canReadCalendar = includeCalendar && !sessionAgent(owner) && roleAllows(owner.role, 'calendar');
  const overrides = new Map(state.states.map((row) => [`${row.kind}:${row.id}`, row]));
  const prefs = { sales_enabled: state.sales_enabled, hidden_kinds: state.hidden_kinds };
  const access = await subjectAccessFor(env, owner);
  // A kind whose work module is off is not in INBOX (docs/WORK_MODEL.md).
  const shown = await subjectKindFilter(env);
  const listed = (subject: CrmSubject): boolean =>
    shown(subject.kind) && access.canSee(subject.kind, subject.id) && resolveSubjectState(subject, prefs, overrides.get(`${subject.kind}:${subject.id}`)).listed;

  // Sales touches are Core's alone; bookings are D1's and, on a Core
  // workspace, Core's too (bookingItems). Tasks, comments on
  // subjects, My work and the recent feed read the work model, which a D1
  // workspace keeps itself (docs/WORKSPACE_STORE.md). On a Core workspace
  // the two are the same.
  const core = crmSyncEnabled(env);
  const work = workModelEnabled(env);
  const recentPartial: string[] = [];
  const taskPartial: string[] = [];
  // The open subjects, once, for the sources that walk them.
  const subjectsOnce = work ? openSubjects(env, recentPartial) : Promise.resolve([] as CrmSubject[]);
  const [questions, cards, followUps, decisions, talk, guests, support, tasks, notes, sales, commercial, comments, bookings, invitations, forwarded, interest, submissions, feed] = await Promise.all([
    includeQuestions && on.question ? attempt('question', async () => (await listAttentionForOwner(env, owner, { state: 'open' }))
      .filter((request) => request.kind === 'question')
      .map((request): InboxItem => ({ source: 'question', key: request.id, at: Date.parse(request.created_at), request }))) : Promise.resolve([]),
    // A card you handed to an agent, now in Review or Blocked (card-holds.ts).
    work && includeCards && on.card ? attempt('card', async () => {
      const { items, truncated } = await cardInboxItems(env, owner, await subjectsOnce, listed);
      if (truncated && !partial.includes('card')) partial.push('card');
      return items;
    }) : Promise.resolve([]),
    // A follow-up waiting on the host after a call with outside people (follow-ups.ts).
    work && includeFollowUps && on.followup ? attempt('followup', () => followUpInboxItems(env, owner)) : Promise.resolve([]),
    // Decisions waiting on you: Meet's own D1, no Core.
    on.decision ? attempt('decision', async () => (await decisionInboxItems(env, owner))
      .filter((item) => item.source !== 'decision' || !item.ask.subject || shown(item.ask.subject.kind as SubjectKind))) : Promise.resolve([]),
    on.talk ? attempt('talk', () => talkItems(env, owner)) : Promise.resolve([]),
    // An outside line nobody here answered, on a subject you can see (docs/SUPPORT.md).
    on.guest ? attempt('guest', () => guestInboxItems(env, owner, dismissed)) : Promise.resolve([]),
    // Starlings support answered a conversation you started in Help.
    on.support ? attempt('support', () => supportInboxItems(env, owner)) : Promise.resolve([]),
    work && on.task
      ? attempt('task', async () => {
        const { items, truncated } = await proposedTaskItems(env, await subjectsOnce, (subject, error) => {
          warn(`inbox.task.failed ${subject.kind}/${subject.id} (${subject.title})`, error);
          if (!partial.includes('task')) partial.push('task');
          taskPartial.push(subject.title);
        });
        // Past the page ceiling the rest are unread: a short read, said the
        // way a failed one is.
        if (truncated && !partial.includes('task')) partial.push('task');
        return items;
      })
      : Promise.resolve([]),
    on.note ? attempt('note', () => noteItems(env, owner)) : Promise.resolve([]),
    // Sales touches only when Sales is on for you — the whole of decision 5's
    // "sales touches (only when Sales is on for you)".
    core && shown('lead') && state.sales_enabled && on.sales ? attempt('sales', () => salesItems(env, owner)) : Promise.resolve([]),
    // Offers and licenses coming due, for the same people as Sales touches.
    core && work && state.sales_enabled && on.commercial && eligibleSources.includes('commercial')
      ? attempt('commercial', async () => commercialInboxItems(env, owner.email, {
        on: { offers: modules.includes('offers'), licenses: modules.includes('licenses') },
        subjects: (await subjectsOnce).filter(listed),
        access,
        shown,
        dismissed,
      }))
      : Promise.resolve([]),
    work && docsEnabled(env) && on.comment ? attempt('comment', async () => {
      const { items, truncated } = await commentItems(env, owner, await subjectsOnce, listed);
      // A capped read is not a failed one: the threads shown are right, and
      // the line says only that more are past the cap.
      if (truncated) capped.push('comment');
      return items;
    }) : Promise.resolve([]),
    on.booking ? attempt('booking', () => bookingItems(env, owner, dismissed)) : Promise.resolve([]),
    canReadCalendar && on.invitation ? attempt('invitation', () => invitationItems(env, owner)) : Promise.resolve([]),
    canReadCalendar && on.forwarded && eligibleSources.includes('forwarded') ? attempt('forwarded', () => forwardedItems(env, owner)) : Promise.resolve([]),
    // A company filling in /interest is a sales signal for the admins, read
    // from Meet's own D1, so it needs no Core.
    canReadInterest ? attempt('interest', () => interestInboxItems(env, dismissed)) : Promise.resolve([]),
    // Answers to the workspace's public forms, from its own D1 (docs/FORMS.md).
    canReadSubmissions ? attempt('submission', () => formInboxItems(env, dismissed, { isAdmin: isInboxAdmin(env, owner) })) : Promise.resolve([]),
    work
      ? fetchRecentFeed(env, { limit: INBOX_RECENT_LIMIT, include: listed, since: Date.now() - INBOX_RECENT_WINDOW_MS }).catch((error: unknown) => {
        warn('inbox.recent.failed', error);
        recentPartial.push('recent');
        return { entries: [], partial: [] as string[] };
      })
      : Promise.resolve({ entries: [], partial: [] as string[] }),
  ]);

  // A mention and its thread's plain unread are one row, not two; the merge
  // keys already differ by source, so dedupe on the thread.
  // Invitations lead, soonest event first: an event cannot wait for the
  // queue. Decisions follow, already in queue order (overdue, then the
  // soonest default-by); the rest follow, newest first.
  const rest = [...talk, ...guests, ...support, ...tasks, ...notes, ...sales, ...commercial, ...comments, ...bookings, ...forwarded, ...interest, ...submissions].sort((a, b) => b.at - a.at || a.key.localeCompare(b.key));
  // A card waiting on you follows the questions: an agent stopped for it.
  const items = [...invitationsByStart(invitations), ...decisions, ...questions, ...cards.sort((a, b) => b.at - a.at), ...followUps, ...rest];

  const since = Date.now() - INBOX_RECENT_WINDOW_MS;
  const recent: InboxRecentEntry[] = feed.entries
    .filter((entry) => entryTimeMs(entry.interaction) >= since)
    .map((entry) => ({
      subject: {
        kind: entry.subject.kind,
        id: entry.subject.id,
        title: entry.subject.title,
        group: inboxRecentSubjectGroup(subjectGroup({ kind: entry.subject.kind, title: entry.subject.title, internal: null }, defaults.project_group_name ?? undefined)),
      },
      id: entry.interaction.id,
      title: entry.interaction.title,
      type: entry.interaction.type,
      date: entry.interaction.occurred_at ?? entry.interaction.created_at,
      url: entry.interaction.url,
    }));

  return {
    items,
    recent,
    partial,
    recent_partial: [...new Set([...recentPartial, ...feed.partial])],
    task_partial: taskPartial,
    capped,
  };
}
