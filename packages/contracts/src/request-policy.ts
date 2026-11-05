/**
 * How the clients talk to the Worker, decided once: how long a
 * request may take, which failed requests are sent again, and which snapshotted
 * lists each write makes stale.
 *
 * `MeetingControlAPI` (Mac) and `StarlingsAPI` (iOS) each kept their own copy of
 * all three, and the copies differed: 15 s against 20 s, a retry on the Mac
 * only, and write-by-write lists of what to clear that disagreed (a favourite
 * cleared one list on the Mac and two on the phone; an issue update cleared
 * `crm/mine` on the Mac and `crm/mine` + `crm/issues` on the phone). Now there
 * is one table. The Swift clients read it from the generated
 * `Sources/Generated/RequestPolicyRegistry.swift`; the web's `invalidateFor`
 * (`snapshot-store.ts`) reads this module. `fixtures/request-policy.json` pins
 * both. It is rule input, not a wire shape: no zod.
 *
 * Where the clients differed, the stricter behaviour won:
 * - A write clears every list it can change, the union of what the three
 *   clients cleared before.
 * - Every idempotent request is retried once, on the phone too.
 * - The timeout is 15 s, the shorter of the two. It is URLSession's idle
 *   interval (time without data), not a cap on the whole transfer, and a
 *   request that times out is now retried once, so a slow line gets two tries
 *   rather than one long one. A call that needs longer (an upload, a wide
 *   calendar read) names its own value at the call site.
 *
 * Snapshots themselves are docs/CACHING.md; this table is the "Invalidation"
 * section of it, written as data.
 */

/** Seconds a request waits for data before it stops, when the call names no other value. */
export const REQUEST_TIMEOUT_SECONDS = 15;

/**
 * When a failed request is sent again. One extra attempt, after `delaySeconds`,
 * for an idempotent method only: a retried POST that had in fact landed would
 * create a second row. DELETE is left out on purpose: its second answer to a
 * delete that did land is a 404, and a person would read a failure for
 * something that worked. A transport failure (offline, timed out, connection
 * lost) is retried, except a cancelled request, which was meant.
 */
export const REQUEST_RETRY = {
  methods: ['GET', 'HEAD', 'PUT', 'PATCH'],
  extraAttempts: 1,
  delaySeconds: 0.7,
  /** Every status from here up (a 5xx) is the service saying "not now". */
  statusFloor: 500,
  /** And these two below it: request timeout, rate limit. */
  statuses: [408, 429],
} as const;

export const SNAPSHOT_CLIENTS = ['mac', 'ios', 'web'] as const;
export type SnapshotClient = (typeof SNAPSHOT_CLIENTS)[number];

/**
 * A write that makes a snapshotted list stale, named for what it does and not
 * for the route: `task.update` is a status change, a reassignment and an
 * accepted proposal alike.
 */
export const SNAPSHOT_WRITES = [
  'thread.open',
  'thread.message',
  'thread.state',
  'attention.resolve',
  'comment.resolve',
  'quickNote.write',
  'task.create',
  'task.update',
  'issue.write',
  'githubLogin.set',
  'subject.write',
  'subjectState.set',
  'workPreferences.set',
  'favorite.set',
  'interaction.write',
] as const;
export type SnapshotWrite = (typeof SNAPSHOT_WRITES)[number];

export interface SnapshotRow {
  /** The Swift constant: `StarlingsSnapshotKey.<name>`. */
  readonly name: string;
  /**
   * What the snapshot is stored under, or the front of what it is stored under
   * when the read is per query (`crm/subjects?kind=…`): a write names this key
   * and takes every page with it. The stores match `key`, `key?…` and `key/…`,
   * so `crm/subject-counts` is not under `crm/subjects`.
   */
  readonly key: string;
  readonly read: string;
  /**
   * Which clients keep a snapshot of this read. A client not listed reads it
   * live, because no screen of its own paints it before the answer, so it has
   * nothing to clear. A write still names the row for the clients that keep it.
   */
  readonly clients: readonly SnapshotClient[];
  /** Every write that can change the list. Empty: nothing a client writes does. */
  readonly invalidatedBy: readonly SnapshotWrite[];
}

export const SNAPSHOT_ROWS: readonly SnapshotRow[] = [
  {
    name: 'threads', key: 'threads', read: 'GET /api/threads',
    clients: ['mac', 'ios', 'web'],
    // Opening a conversation (a person, a group, a channel, a subject's thread),
    // sending in it, and the per-member state: read, mute, archive. The phone
    // and the Mac never cleared the list for read, mute or archive, and the
    // web did.
    invalidatedBy: ['thread.open', 'thread.message', 'thread.state'],
  },
  {
    // Who is on the team is durable, who is around is not: the phone paints the
    // identity of the roster from this and draws everybody offline until the
    // first live poll. The Mac's roster is the live poll.
    name: 'peers', key: 'peers', read: 'GET /api/peers',
    clients: ['ios'],
    invalidatedBy: [],
  },
  {
    name: 'mine', key: 'crm/mine', read: 'GET /api/crm/mine',
    clients: ['mac', 'ios', 'web'],
    invalidatedBy: ['task.create', 'task.update', 'issue.write', 'githubLogin.set'],
  },
  {
    name: 'inbox', key: 'crm/inbox', read: 'GET /api/crm/inbox',
    clients: ['mac', 'ios', 'web'],
    // An answered proposal leaves INBOX (task.update). The web did not clear it
    // on a task update, and neither the web nor the Mac cleared it when a Quick
    // Note was saved, edited or filed.
    invalidatedBy: ['attention.resolve', 'comment.resolve', 'quickNote.write', 'task.update', 'workPreferences.set'],
  },
  {
    name: 'quickNotes', key: 'quick-notes', read: 'GET /api/quick-notes',
    clients: ['mac', 'ios', 'web'],
    // The web cleared it for a create only; an edit, a delete and a filing
    // changed the list just the same.
    invalidatedBy: ['quickNote.write'],
  },
  {
    name: 'subjects', key: 'crm/subjects', read: 'GET /api/crm/subjects',
    clients: ['mac', 'ios', 'web'],
    // A rename or a status change moves a row between pages, and there is no
    // telling which. A star or a mute can reorder or hide a row; the Sales
    // opt-in changes which leads are listed.
    invalidatedBy: ['subject.write', 'subjectState.set', 'workPreferences.set'],
  },
  {
    name: 'subjectCounts', key: 'crm/subject-counts', read: 'GET /api/crm/subject-counts',
    clients: ['mac', 'ios'],
    // The badges follow the pages. The web fetches them live.
    invalidatedBy: ['subject.write', 'subjectState.set', 'workPreferences.set'],
  },
  {
    // The Mac paints Work's star and mute marks from it; the phone reads it live.
    name: 'subjectState', key: 'crm/subject-state', read: 'GET /api/crm/subject-state',
    clients: ['mac'],
    invalidatedBy: ['subjectState.set', 'workPreferences.set'],
  },
  {
    name: 'tasks', key: 'crm/tasks', read: 'GET /api/crm/tasks',
    clients: ['mac', 'ios', 'web'],
    // A task can move between subjects, so every subject's page goes.
    invalidatedBy: ['task.create', 'task.update'],
  },
  {
    // Filed by the meeting log, and by hand on a subject's History.
    name: 'interactions', key: 'crm/interactions', read: 'GET /api/crm/interactions',
    clients: ['mac', 'ios', 'web'],
    invalidatedBy: ['interaction.write'],
  },
  {
    // The phone's Issues pane. The Mac's issue list is a live read.
    name: 'issues', key: 'crm/issues', read: 'GET /api/crm/issues',
    clients: ['ios'],
    invalidatedBy: ['issue.write'],
  },
  {
    name: 'starred', key: 'crm/starred', read: 'GET /api/crm/starred',
    clients: ['mac', 'ios', 'web'],
    invalidatedBy: ['favorite.set'],
  },
  {
    // The phone keeps the favourites list apart; the Mac reads it live and the
    // web keeps it inside `crm/starred`.
    name: 'favorites', key: 'crm/favorites', read: 'GET /api/crm/favorites',
    clients: ['ios'],
    invalidatedBy: ['favorite.set'],
  },
  {
    name: 'commercialSummary', key: 'crm/commercial-summary', read: 'GET /api/crm/commercial-summary',
    clients: ['mac', 'ios', 'web'],
    invalidatedBy: [],
  },
  {
    name: 'ownerRoom', key: 'owner/room', read: 'GET /api/owner/room',
    clients: ['ios', 'web'],
    invalidatedBy: [],
  },
  {
    name: 'calendarUpcoming', key: 'calendar/upcoming', read: 'GET /api/calendar/upcoming',
    clients: ['mac', 'web'],
    invalidatedBy: [],
  },
  {
    // The display policy the agenda is drawn under, kept beside it so a cold
    // Home derives the same plan it showed last time.
    name: 'calendarPreferences', key: 'calendar/preferences', read: 'GET /api/calendar/preferences',
    clients: ['mac', 'web'],
    invalidatedBy: [],
  },
  {
    name: 'calendarInvitations', key: 'calendar/invitations', read: 'GET /api/calendar/invitations',
    clients: ['mac', 'ios', 'web'],
    invalidatedBy: [],
  },
  {
    name: 'calendarPending', key: 'calendar/pending', read: 'GET /api/calendar/pending',
    clients: ['mac', 'ios', 'web'],
    invalidatedBy: [],
  },
];

/**
 * The keys and prefixes a write makes stale, in the table's order. Pass them
 * to the snapshot store's `invalidate`; it drops every stored key that starts
 * with one.
 */
export function snapshotsInvalidatedBy(write: SnapshotWrite): string[] {
  return SNAPSHOT_ROWS.filter((row) => row.invalidatedBy.includes(write)).map((row) => row.key);
}
