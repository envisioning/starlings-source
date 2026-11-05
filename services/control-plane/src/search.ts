// `GET /api/search?q=` — the one search route. Fans out to what
// this Worker already serves and answers `SearchRow[]` in the contract's
// order. Nothing here matches or ranks on its own: every row goes through
// `search` from `@starlings/contracts/search`, the same function the clients run
// over their own stores and the same one that adds doors and recents on the
// device. A store that is down or not configured contributes nothing; the
// palette never waits on the slowest of them for the rest.
//
// What is not here, and why: the Core registry has no Worker route (the Mac
// reads Core directly), so `core` rows come only from the Mac's in-memory
// store; message bodies are asked of each conversation's Durable Object in
// turn (`searchMessages`) rather than indexed — docs/PRIVACY.md
// keeps bodies out of D1; Docs full text is `/api/docs/search`, which the client
// calls after a pause — this route answers document *titles* so they rank
// with everything else on the first keystroke.

import { canSeeDocument, interactionKey, subjectAccessFor, taskKey } from './subject-access';
import { agentMaySeeDocument, sessionAgent } from './agent-boundary';
import { filterMyWork } from './subject-access-filters';
import type { RoleSession } from './capabilities';
import { SEARCH_EVENTS_AHEAD_DAYS, SEARCH_EVENTS_BACK_DAYS } from '@starlings/contracts/limits';
import {
  SEARCH_HIT_KINDS,
  search,
  searchDoorString,
  type CrmIssue,
  type CrmMyTask,
  type CrmTask,
  type OwnerSession,
  type Peer,
  type SearchRow,
} from './contracts';
import type { FavoriteRow } from '@starlings/contracts/favorites';
import { contactSearchRow, documentSearchRow, folderSearchRow, subjectSearchRow, threadSearchRow, threadSearchTitle } from '@starlings/contracts/search-rows';
import { openSubjects } from './board';
import { listCalendarEventsInRange, type CalendarEventSummary } from './calendar';
import { fetchAllCrmGoals, fetchCrmContacts, fetchCrmIssue, fetchCrmMyWork, fetchCrmSubject, fetchCrmSubjects, fetchCrmTask, fetchRecentCrmDecisions, githubIssuesEnabled, searchCrmOrganizations, workModelEnabled } from './crm';
import type { CrmDecision, CrmGoal } from '@starlings/contracts/goals-decisions';
import { docsCategoryLabels, docsEnabled, docsTree, getDocsDocument, listDocsDocuments } from './docs';
import { requireCapability } from './capabilities';
import { peerRoster } from './peers';
import { readStarredKeys } from './subject-state';
import { listThreadsFor, threadStub } from './threads';
import { usesCore, usesCoreFor } from './work-store';
import { d1SearchCalls, d1SearchMilestones, d1SearchTasks, type D1CallHit, type D1MilestoneHit } from './work-d1';
import { normalizeSearchText, searchTokens } from '@starlings/contracts/search';
import type { ThreadSummary } from './contracts';
import { subjectKindFilter } from './work-modules';
import { taskSubject } from '@starlings/contracts/standard-records';
import type { SubjectKind } from '@starlings/contracts/subject-kinds';

/** Rows past this are noise on a phone; the query narrows, not the page. */
const SEARCH_RESULT_LIMIT = 60;
/**
 * Message bodies: the caller's newest conversations are each
 * asked, in parallel, for their newest hits. Bodies stay in the per-thread
 * Durable Objects (docs/PRIVACY.md); this is a fan-out, not an index.
 */
const MESSAGE_SEARCH_THREADS = 40;
const MESSAGE_SEARCH_HITS_PER_THREAD = 5;
const MESSAGE_SEARCH_ROWS = 20;
/** The matched line, clipped around the first hit so every token stays in it. */
const MESSAGE_EXCERPT_CHARS = 160;
/** The calendar window a query reaches: last week, and the 45-day range cap ahead. */
const EVENTS_BACK_MS = SEARCH_EVENTS_BACK_DAYS * 24 * 60 * 60 * 1000;
const EVENTS_AHEAD_MS = SEARCH_EVENTS_AHEAD_DAYS * 24 * 60 * 60 * 1000;

/**
 * The window search reads events in. MCP `open` reads the same window, so
 * every event door search gives also opens.
 */
export function searchEventsWindow(now = Date.now()): { timeMin: string; timeMax: string } {
  return {
    timeMin: new Date(now - EVENTS_BACK_MS).toISOString(),
    timeMax: new Date(now + EVENTS_AHEAD_MS).toISOString(),
  };
}

/**
 * The event an `event:` door names. The door id is the summary's own `id`,
 * which already is `<calendarId>:<googleId>` (calendar.ts). Prefixing the
 * calendar again matched nothing.
 */
export function eventForDoor<T extends { id: string }>(events: readonly T[], doorId: string): T | null {
  return events.find((event) => event.id === doorId) ?? null;
}

function warn(message: string, error: unknown): void {
  console.warn(JSON.stringify({
    level: 'warn',
    message,
    error: error instanceof Error ? error.message : 'Unknown error',
  }));
}

/**
 * Each source has this long. The answer goes out with what came back and
 * names the source that did not, instead of waiting on the slowest read
 *. A read that outlives the budget still finishes on its own;
 * nothing here cancels it.
 */
const SOURCE_BUDGET_MS = 4_000;

/** A source's rows, or none and its name in `partial`. */
async function quietly<T>(source: string, partial: string[], read: () => Promise<T[]>): Promise<T[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`search.${source}: no answer in ${SOURCE_BUDGET_MS}ms`)), SOURCE_BUDGET_MS);
  });
  try {
    return await Promise.race([read(), budget]);
  } catch (error) {
    warn(`search.${source}.failed`, error);
    partial.push(source);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One row per matching message: a `thread` row whose door opens the
 * conversation and whose subtitle is the line that matched. The id is the
 * message's, so a hit and the conversation's own row are two keys.
 */
function messageRow(
  thread: ThreadSummary,
  message: { id: string; sender_name: string | null; sender_email: string; text: string },
  tokens: readonly string[],
): SearchRow {
  const who = message.sender_name?.trim() || message.sender_email;
  return {
    kind: 'thread',
    id: message.id,
    title: threadSearchTitle(thread),
    subtitle: `${who}: ${messageExcerpt(message.text, tokens)}`,
    door: searchDoorString({ to: 'thread', id: thread.id }),
  };
}

/**
 * A window on the text around the earliest token, so a long message still
 * shows why it matched. The window is cut on the raw text at the offset the
 * folded text gave, which drifts by the number of combining marks before
 * it; a wide window absorbs that, and a clip that lost a token falls back to
 * the whole line rather than to a row the matcher would then drop.
 */
export function messageExcerpt(text: string, tokens: readonly string[]): string {
  const line = text.replace(/\s+/gu, ' ').trim();
  if (line.length <= MESSAGE_EXCERPT_CHARS) return line;
  const folded = normalizeSearchText(line);
  const first = Math.min(...tokens.map((token) => folded.indexOf(token)).filter((index) => index >= 0), line.length);
  const start = Math.max(0, first - Math.floor(MESSAGE_EXCERPT_CHARS / 3));
  const clipped = `${start > 0 ? '…' : ''}${line.slice(start, start + MESSAGE_EXCERPT_CHARS)}${start + MESSAGE_EXCERPT_CHARS < line.length ? '…' : ''}`;
  const check = normalizeSearchText(clipped);
  return tokens.every((token) => check.includes(token)) ? clipped : line;
}

/**
 * Hits across the caller's conversations, newest first. Only threads the
 * caller can read are asked (`listThreadsFor` is that rule), and only the
 * newest few: a query is about recent talk, and every extra thread is a
 * Durable Object round trip inside the source budget.
 */
async function searchMessages(env: Env, owner: OwnerSession, threads: ThreadSummary[], query: string): Promise<SearchRow[]> {
  const tokens = searchTokens(query);
  if (tokens.length === 0) return [];
  const candidates = threads
    .filter((thread) => thread.last_message_at !== null)
    .slice(0, MESSAGE_SEARCH_THREADS);
  const perThread = await Promise.all(candidates.map(async (thread) => {
    try {
      const hits = await threadStub(env, thread.id).search(owner.sub, tokens, MESSAGE_SEARCH_HITS_PER_THREAD);
      return hits.map((hit) => ({ thread, hit }));
    } catch (error) {
      // One conversation that will not answer is not the whole source down.
      warn('search.messages.thread.failed', error);
      return [];
    }
  }));
  return perThread
    .flat()
    .sort((a, b) => b.hit.sent_at - a.hit.sent_at)
    .slice(0, MESSAGE_SEARCH_ROWS)
    .map(({ thread, hit }) => messageRow(thread, hit, tokens));
}

function peerRow(peer: Peer): SearchRow {
  const agent = peer.kind === 'agent';
  return {
    kind: agent ? 'agent' : 'person',
    id: peer.email,
    title: peer.name?.trim() || peer.email,
    subtitle: agent ? 'Agent' : peer.email,
    door: searchDoorString({ to: agent ? 'agent' : 'person', id: peer.email }),
  };
}

/**
 * The subtitle of a D1 work hit: its place, and when the title
 * alone does not hold every token, the clip of the text that matched, so the
 * contract's matcher keeps the row and the reader sees why it matched.
 */
function workSubtitle(place: string, title: string, body: string | null, tokens: readonly string[]): string {
  const folded = normalizeSearchText(title);
  if (!body || tokens.every((token) => folded.includes(token))) return place;
  return `${place}: ${messageExcerpt(body, tokens)}`;
}

/**
 * A task from the D1 search: any status, any assignee. The
 * subtitle is its subject, as a Mine row's is.
 */
function anyTaskRow(task: CrmTask & { subject_title: string | null }, tokens: readonly string[]): SearchRow {
  return {
    kind: 'task',
    id: task.id,
    title: task.title,
    subtitle: workSubtitle(task.subject_title ?? 'Task', task.title, task.notes, tokens),
    door: searchDoorString({ to: 'task', id: task.id }),
  };
}

/** A milestone's door is its project, where its date shows. */
function milestoneRow(milestone: D1MilestoneHit, tokens: readonly string[]): SearchRow {
  return {
    kind: 'milestone',
    id: milestone.id,
    title: milestone.title,
    subtitle: workSubtitle(milestone.project_title ?? 'Milestone', milestone.title, milestone.notes, tokens),
    door: searchDoorString({ to: 'subject', subjectKind: 'project', id: milestone.project_id }),
  };
}

/**
 * A call's door is its subject, whose History lists it. A call on
 * no subject opens its first contact; a call with neither draws no row.
 */
function callRow(call: D1CallHit, tokens: readonly string[]): SearchRow | null {
  const subject = interactionKey(call);
  const door = subject
    ? searchDoorString({ to: 'subject', subjectKind: subject.kind, id: subject.id })
    : call.contact_id ? searchDoorString({ to: 'contact', id: call.contact_id }) : null;
  if (!door) return null;
  return { kind: 'call', id: call.id, title: call.title, subtitle: workSubtitle(call.subject_title ?? 'Call', call.title, call.summary, tokens), door };
}

function taskRow(task: CrmMyTask): SearchRow {
  return {
    kind: 'task',
    id: task.id,
    title: task.title,
    subtitle: task.subject_title ?? 'Mine',
    door: searchDoorString({ to: 'task', id: task.id }),
  };
}

/** A goal's door is its project: the row opens where the goal lives. */
function goalRow(goal: CrmGoal): SearchRow {
  return {
    kind: 'goal',
    id: goal.id,
    title: goal.title,
    subtitle: goal.project_title ?? 'Goal',
    door: searchDoorString({ to: 'subject', subjectKind: 'project', id: goal.project_id }),
  };
}

/** A decision's door is its subject, whose History lists it. */
function decisionRow(decision: CrmDecision): SearchRow {
  return {
    kind: 'decision',
    id: decision.id,
    title: decision.body,
    subtitle: decision.subject_title ?? 'Decision',
    door: searchDoorString({ to: 'subject', subjectKind: decision.subject_kind, id: decision.subject_id }),
  };
}

function issueRow(issue: CrmIssue): SearchRow {
  return {
    kind: 'issue',
    id: issue.id,
    title: issue.title,
    subtitle: `${issue.owner}/${issue.repo}`,
    door: searchDoorString({ to: 'issue', id: issue.id }),
  };
}

/**
 * Invariant 20: a clock a person reads is 24-hour. `en-GB` with `h23` is the
 * same spelling `formatTime` gives on the web; the zone is the device's,
 * passed as `tz`, because the Worker has none of its own worth trusting.
 */
function eventSubtitle(event: CalendarEventSummary, timeZone: string): string {
  const start = new Date(event.start);
  if (Number.isNaN(start.getTime())) return event.calendarSummary;
  const options: Intl.DateTimeFormatOptions = event.allDay
    ? { weekday: 'short', day: 'numeric', month: 'short', timeZone }
    : { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone };
  try {
    return new Intl.DateTimeFormat('en-GB', options).format(start);
  } catch {
    return new Intl.DateTimeFormat('en-GB', { ...options, timeZone: 'UTC' }).format(start);
  }
}

export function eventRow(event: CalendarEventSummary, timeZone: string): SearchRow {
  return {
    kind: 'event',
    id: event.id,
    title: event.title || '(No title)',
    subtitle: eventSubtitle(event, timeZone),
    door: searchDoorString({ to: 'event', id: event.id }),
  };
}

/**
 * Every hit this Worker can see for the signed-in member, matched and ranked
 * by the contract. Recents are the device's, so the client runs the same
 * function once more with them; that is one function twice, not two rankings.
 */
export async function searchRows(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  owner: RoleSession,
  query: string,
  timeZone: string,
): Promise<{ rows: SearchRow[]; partial: string[] }> {
  // The work model: Core's, or a D1 workspace's own (docs/WORKSPACE_STORE.md).
  const crm = workModelEnabled(env);
  // docs/ACCESS.md: every source is cut to what this member reaches before
  // a row is built, because a row drops the subject key it came from.
  const access = await subjectAccessFor(env, owner);
  const docs = docsEnabled(env);
  // A kind whose work module is off finds nothing (docs/WORK_MODEL.md).
  const shown = await subjectKindFilter(env);
  const partial: string[] = [];
  // A document row names its category by the workspace's label; the labels
  // are data on Docs, read beside the documents.
  const categoryLabels = docs ? docsCategoryLabels(env, owner.email) : Promise.resolve(new Map<string, string>());
  // Contacts are asked by the query's longest word, then matched by the
  // contract like every other row; an empty query lists none.
  const contactNeedle = searchTokens(query).reduce((longest, token) => (token.length > longest.length ? token : longest), '');
  // Every organization, not only partners, once the subjects group answers
  // from D1: before that, Core's record search finds them.
  const organizationsInD1 = crm && shown('organization') && !usesCoreFor(env, 'subjects') && contactNeedle !== '';
  // Every task and milestone, and every call, once its group answers from D1
  //: before that, search finds the member's own tasks only.
  const tasksInD1 = crm && !usesCoreFor(env, 'tasks') && contactNeedle !== '';
  const callsInD1 = crm && !usesCoreFor(env, 'interactions') && contactNeedle !== '';
  const [peers, threads, subjects, partners, mine, events, documents, goals, decisions, contacts, organizations, allTasks, milestones, calls] = await Promise.all([
    quietly('people', partial, async () => (await peerRoster(await requireCapability(request, env, 'roster'), env, ctx)).peers),
    quietly('conversations', partial, async () => (await listThreadsFor(env, owner)).threads),
    crm ? quietly('subjects', partial, async () => {
      // `openSubjects` swallows a status read that failed into its own list;
      // any entry there means subject rows are missing here too.
      const missing: string[] = [];
      const found = await openSubjects(env, missing);
      if (missing.length > 0) partial.push('subjects');
      return found;
    }) : Promise.resolve([]),
    crm && shown('organization') ? quietly('partners', partial, async () => (await fetchCrmSubjects(env, 'organization', '')).subjects) : Promise.resolve([]),
    crm ? quietly('mine', partial, async () => [await filterMyWork(env, access, await fetchCrmMyWork(env, owner.email))]) : Promise.resolve([]),
    // The member's calendar is "Only you": an agent searching as them gets no events.
    sessionAgent(owner) ? Promise.resolve([]) : quietly('events', partial, () => {
      const { timeMin, timeMax } = searchEventsWindow();
      return listCalendarEventsInRange(env, owner, timeMin, timeMax);
    }),
    docs ? quietly('documents', partial, async () => (await listDocsDocuments(env, owner.email, { limit: 200 })).documents) : Promise.resolve([]),
    crm ? quietly('goals', partial, () => fetchAllCrmGoals(env)) : Promise.resolve([]),
    crm ? quietly('decisions', partial, () => fetchRecentCrmDecisions(env)) : Promise.resolve([]),
    crm && contactNeedle ? quietly('contacts', partial, async () => (await fetchCrmContacts(env, owner.email, { q: contactNeedle, limit: 50 })).contacts) : Promise.resolve([]),
    organizationsInD1 ? quietly('organizations', partial, () => searchCrmOrganizations(env, owner.email, contactNeedle)) : Promise.resolve([]),
    tasksInD1 ? quietly('tasks', partial, () => d1SearchTasks(env, contactNeedle)) : Promise.resolve([]),
    tasksInD1 ? quietly('milestones', partial, () => d1SearchMilestones(env, contactNeedle)) : Promise.resolve([]),
    callsInD1 ? quietly('calls', partial, () => d1SearchCalls(env, contactNeedle)) : Promise.resolve([]),
  ]);
  const tokens = searchTokens(query);
  const mineTaskIDs = new Set(mine.flatMap((work) => work.tasks.map((task) => task.id)));
  const partnerIDs = new Set(partners.map((partner) => partner.id));
  const otherOrganizations = organizations
    .filter((organization) => !partnerIDs.has(organization.id))
    .map((organization) => ({ id: organization.id, kind: 'organization' as const, title: organization.name, subtitle: null }));

  // After the conversation list, which says which objects to ask; its own
  // budget, so a slow object costs the message rows and nothing else.
  const messages = await quietly('messages', partial, () => searchMessages(env, owner, threads, query));
  const labels = await categoryLabels;

  const rows: SearchRow[] = [
    ...access.filter(subjects, (subject) => subject).map(subjectSearchRow),
    ...access.filter(partners, (subject) => subject).map(subjectSearchRow),
    ...access.filter(otherOrganizations, (subject) => subject).map(subjectSearchRow),
    ...peers.filter((peer) => peer.email !== owner.email).map(peerRow),
    // A contact is seen through its organization (docs/ACCESS.md).
    ...access.filter(contacts, (contact) => (contact.organization_id ? { kind: 'organization', id: contact.organization_id } : null)).map(contactSearchRow),
    ...threads.map(threadSearchRow),
    ...messages,
    ...documents.filter((document) => document.status === 'active' && canSeeDocument(access, document.subjects) && agentMaySeeDocument(owner, document)).map((document) => documentSearchRow(document, document.category ? labels.get(document.category) : null)),
    ...access.filter(events, (event) => event.subject).filter((event) => !event.demoted).map((event) => eventRow(event, timeZone)),
    ...mine.flatMap((work) => work.tasks.filter((task) => onShownSubject(taskSubject(task), shown)).map(taskRow)),
    ...access.filter(allTasks, taskKey)
      .filter((task) => !mineTaskIDs.has(task.id) && onShownSubject(taskSubject(task), shown))
      .map((task) => anyTaskRow(task, tokens)),
    ...mine.flatMap((work) => work.issues.map(issueRow)),
    ...access.filter(goals, (goal) => ({ kind: 'project', id: goal.project_id })).map(goalRow),
    ...access.filter(decisions, (decision) => ({ kind: decision.subject_kind, id: decision.subject_id }))
      .filter((decision) => shown(decision.subject_kind))
      .map(decisionRow),
    ...(shown('project') ? access.filter(milestones, (milestone) => ({ kind: 'project', id: milestone.project_id })).map((milestone) => milestoneRow(milestone, tokens)) : []),
    ...access.filter(calls, interactionKey)
      .filter((call) => onShownSubject(interactionKey(call), shown))
      .flatMap((call) => callRow(call, tokens) ?? []),
  ];
  return {
    rows: search(rows, query, { scope: SEARCH_HIT_KINDS, order: 'rank' }).slice(0, SEARCH_RESULT_LIMIT),
    partial,
  };
}

/**
 * `GET /api/crm/starred`: the subjects this person starred, as the rows the
 * palette would give them (`subjectSearchRow`), newest star first. Home's
 * QUICK ACCESS module puts them ahead of the device's recents, so each row
 * appears once on every device. CRM subjects resolve from the open
 * list; historical events also get an authorized by-id read so closing,
 * demoting, or changing one never erases its favorite. An unavailable target
 * drops out of the projection but remains in the shared relation.
 */
export async function starredSubjectRows(
  env: Env,
  sub: string,
  sharedKeys?: Array<{ kind: 'lead' | 'project' | 'organization' | 'event'; id: string }>,
): Promise<{ rows: SearchRow[]; partial: string[] }> {
  const shown = await subjectKindFilter(env);
  const keys = (sharedKeys ?? await readStarredKeys(env, sub)).filter((key) => shown(key.kind));
  if (keys.length === 0 || !workModelEnabled(env)) return { rows: [], partial: [] };
  const partial: string[] = [];
  const wantsPartner = keys.some((key) => key.kind === 'organization');
  const [subjects, partners] = await Promise.all([
    quietly('subjects', partial, async () => {
      const missing: string[] = [];
      const found = await openSubjects(env, missing);
      if (missing.length > 0) partial.push('subjects');
      return found;
    }),
    wantsPartner
      ? quietly('partners', partial, async () => (await fetchCrmSubjects(env, 'organization', '')).subjects)
      : Promise.resolve([]),
  ]);
  const byKey = new Map([...subjects, ...partners].map((subject) => [`${subject.kind}:${subject.id}`, subject]));
  const historicalEvents = keys.filter((key) => key.kind === 'event' && !byKey.has(`event:${key.id}`));
  // Events are favorites even after they leave the open Work window. Keep the
  // Core fan-out bounded while resolving the exact stored ids through the
  // same member-authorized subject endpoint used by event detail.
  for (let start = 0; start < historicalEvents.length; start += 5) {
    const page = historicalEvents.slice(start, start + 5);
    const resolved = await Promise.all(page.map(async (key) => {
      try {
        return await fetchCrmSubject(env, 'event', key.id);
      } catch (error) {
        warn('starred.event.failed', error);
        partial.push('events');
        return null;
      }
    }));
    for (const subject of resolved) if (subject) byKey.set(`event:${subject.id}`, subject);
  }
  const rows = keys.flatMap((key) => {
    const subject = byKey.get(`${key.kind}:${key.id}`);
    return subject ? [subjectSearchRow(subject)] : [];
  });
  return { rows, partial };
}

function favoriteThreadRow(thread: ThreadSummary): SearchRow {
  const subtitle = thread.kind === 'dm'
    ? ((thread.peers?.length ?? 0) > 1 ? 'Group' : 'Direct message')
    : thread.kind === 'team' ? 'The internal room' : 'Channel';
  return {
    kind: 'thread',
    id: thread.id,
    title: threadSearchTitle(thread),
    subtitle,
    door: searchDoorString({ to: 'thread', id: thread.id }),
  };
}

function favoriteTaskRow(task: Awaited<ReturnType<typeof fetchCrmTask>> & {}): SearchRow {
  return {
    kind: 'task',
    id: task.id,
    title: task.title,
    subtitle: task.project_id ? 'Project task' : task.lead_id ? 'Lead task' : task.event_id ? 'Event task' : task.organization_id ? 'Partner task' : 'Task',
    door: searchDoorString({ to: 'task', id: task.id }),
  };
}

function favoriteIssueRow(issue: NonNullable<Awaited<ReturnType<typeof fetchCrmIssue>>>): SearchRow {
  return {
    kind: 'issue',
    id: issue.id,
    title: issue.title,
    subtitle: `${issue.owner}/${issue.repo}`,
    door: searchDoorString({ to: 'issue', id: issue.id }),
  };
}

/**
 * Home's shared starred projection. Every row is resolved on demand through
 * the service that owns it, under this member's existing read path. The
 * favorite relation stores references only; stale/inaccessible targets stay
 * stored but do not draw.
 */
export async function starredFavoriteRows(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  owner: OwnerSession,
  favorites: FavoriteRow[],
): Promise<{ rows: SearchRow[]; partial: string[] }> {
  const partial = new Set<string>();
  const resolved = new Map<string, SearchRow>();
  const identity = (row: Pick<FavoriteRow, 'kind' | 'target_ref'>) => `${row.kind}\u0000${row.target_ref}`;
  const resolveEach = async (
    source: string,
    targets: FavoriteRow[],
    resolve: (target: FavoriteRow) => Promise<SearchRow | null>,
  ) => {
    for (let start = 0; start < targets.length; start += 8) {
      const batch = targets.slice(start, start + 8);
      const rows = await Promise.all(batch.map(async (target) => {
        try { return await resolve(target); }
        catch { partial.add(source); return null; }
      }));
      rows.forEach((row, index) => { if (row) resolved.set(identity(batch[index]!), row); });
    }
  };

  const subjects = favorites.filter((row) => ({
    'crm.lead': 'lead', 'crm.project': 'project', 'crm.partner': 'organization', 'cms.event': 'event',
  } as Record<string, string>)[row.kind]);
  await resolveEach('subjects', subjects, async (target) => {
    const kind = ({ 'crm.lead': 'lead', 'crm.project': 'project', 'crm.partner': 'organization', 'cms.event': 'event' } as const)[target.kind as 'crm.lead' | 'crm.project' | 'crm.partner' | 'cms.event'];
    const subject = await fetchCrmSubject(env, kind, target.target_ref);
    return subject ? subjectSearchRow(subject) : null;
  });

  await resolveEach('tasks', favorites.filter((row) => row.kind === 'crm.task'), async (target) => {
    const task = await fetchCrmTask(env, target.target_ref);
    return task ? favoriteTaskRow(task) : null;
  });

  // A D1 workspace with no path to GitHub draws no issue rows; a starred
  // issue stays stored. A Core workspace reads them as it always has.
  const issuesReadable = usesCore(env) || githubIssuesEnabled(env);
  await resolveEach('issues', issuesReadable ? favorites.filter((row) => row.kind === 'github.issue') : [], async (target) => {
    const match = target.target_ref.match(/^([a-z0-9-]+)\/([a-z0-9_.-]+)#([1-9][0-9]*)$/u);
    if (!match) return null;
    const issue = await fetchCrmIssue(env, match[1]!, match[2]!, Number(match[3]));
    return issue ? favoriteIssueRow(issue) : null;
  });

  const documents = favorites.filter((row) => row.kind === 'docs.document');
  const labels = documents.length > 0 ? await docsCategoryLabels(env, owner.email) : new Map<string, string>();
  await resolveEach('docs', documents, async (target) => {
    const document = await getDocsDocument(env, owner.email, target.target_ref);
    return document.id === target.target_ref ? documentSearchRow(document, document.category ? labels.get(document.category) : null) : null;
  });
  const folders = favorites.filter((row) => row.kind === 'docs.folder');
  if (folders.length > 0) {
    try {
      const tree = await docsTree(env, owner.email);
      const byID = new Map(tree.folders.map((folder) => [folder.id, folder]));
      for (const favorite of folders) {
        const folder = byID.get(favorite.target_ref);
        if (folder) resolved.set(identity(favorite), folderSearchRow(folder));
      }
    } catch {
      partial.add('docs');
    }
  }

  const peerFavorites = favorites.filter((row) => row.kind === 'meet.person' || row.kind === 'meet.agent');
  if (peerFavorites.length > 0) {
    try {
      // `sub` is not part of the directory wire row. Resolve it inside the
      // Worker, then still require a row in the caller's member-gated roster.
      const placeholders = peerFavorites.map((_, index) => `?${index + 1}`).join(', ');
      const people = await env.USAGE.prepare(
        `SELECT sub, email, kind FROM people WHERE sub IN (${placeholders})`,
      ).bind(...peerFavorites.map((row) => row.target_ref)).all<{ sub: string; email: string; kind: string }>();
      const peers = await peerRoster(await requireCapability(request, env, 'roster'), env, ctx);
      const bySub = new Map((people.results ?? []).map((person) => [person.sub, person]));
      const byEmail = new Map(peers.peers.map((peer) => [`${peer.kind}:${peer.email.toLowerCase()}`, peer]));
      for (const favorite of peerFavorites) {
        const person = bySub.get(favorite.target_ref);
        const expectedPeerKind = favorite.kind === 'meet.agent' ? 'agent' : 'human';
        if (!person || person.kind !== expectedPeerKind) continue;
        const peer = byEmail.get(`${expectedPeerKind}:${person.email.toLowerCase()}`);
        if (peer) resolved.set(identity(favorite), peerRow(peer));
      }
    } catch {
      partial.add('people');
    }
  }

  const threadFavorites = favorites.filter((row) => row.kind === 'meet.thread');
  if (threadFavorites.length > 0) {
    try {
      const threads = await listThreadsFor(env, owner);
      const byID = new Map(threads.threads.map((thread) => [thread.id, thread]));
      for (const favorite of threadFavorites) {
        const thread = byID.get(favorite.target_ref);
        if (thread) resolved.set(identity(favorite), favoriteThreadRow(thread));
      }
    } catch {
      partial.add('conversations');
    }
  }

  return {
    rows: favorites.flatMap((favorite) => {
      const row = resolved.get(identity(favorite));
      return row ? [row] : [];
    }),
    partial: [...partial],
  };
}

/** A row with no subject, or one on a kind this workspace shows. */
function onShownSubject(subject: { kind: SubjectKind } | null, shown: (kind: SubjectKind) => boolean): boolean {
  return subject === null || shown(subject.kind);
}
