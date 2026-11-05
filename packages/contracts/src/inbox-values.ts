/**
 * Zod-free INBOX values used by browser clients on the guest entry path.
 * Wire schemas and inferred response types remain in `inbox.ts`.
 */

/** Events on listed subjects older than this fall off the tail. */
export const INBOX_RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const INBOX_RECENT_LIMIT = 30;

/** Every INBOX source. The one list: the Zod enums, the filter and the specs below derive from it. */
export const INBOX_SOURCES = ['decision', 'question', 'card', 'followup', 'talk', 'mention', 'guest', 'support', 'task', 'note', 'sales', 'comment', 'booking', 'invitation', 'forwarded', 'interest', 'submission', 'commercial'] as const;
export type InboxSource = (typeof INBOX_SOURCES)[number];

/**
 * Sources that existed and went (2026-10-05: your own overdue and assigned
 * work, which MINE lists). An installed client may still send them in
 * Settings; the Worker drops them there and nowhere else.
 */
export const RETIRED_INBOX_SOURCES = ['overdue', 'assigned'] as const;

/** Contextual source filter for INBOX. Mentions intentionally fold into talk. */
export const INBOX_FILTER_SOURCES = INBOX_SOURCES.filter(
  (source): source is Exclude<InboxSource, 'mention'> => source !== 'mention',
) as [Exclude<InboxSource, 'mention'>, ...Exclude<InboxSource, 'mention'>[]];
export type InboxFilterSource = 'all' | (typeof INBOX_FILTER_SOURCES)[number];
export const DEFAULT_INBOX_FILTER: InboxFilterSource = 'all';

/** The spec a source is read under: `mention` is read as `talk`. */
export function inboxSourceSpec(source: InboxSource): InboxSourceSpec | undefined {
  const filter = inboxFilterSource(source);
  return INBOX_SOURCE_SPECS.find((spec) => spec.source === filter);
}

export function inboxFilterSource(source: InboxSource): Exclude<InboxSource, 'mention'> {
  return source === 'mention' ? 'talk' : source;
}

/**
 * What one source is, for a Settings row and for the Worker's switch. One
 * entry per source a person can turn off; `talk` covers `mention` too, since
 * a mention is a loud unread, not a second feed. Adding a source is one
 * entry here, one reader in the Worker, one row per client.
 */
export interface InboxSourceSpec {
  source: Exclude<InboxSource, 'mention'>;
  title: string;
  /** One sentence: what arrives, and what makes it leave. */
  detail: string;
  /** Whether a person who never said otherwise sees it. */
  default_on: boolean;
  /** The source as a noun in "Couldn't read …", when the Worker could not read it. */
  partial: string;
}

export const INBOX_SOURCE_SPECS: readonly InboxSourceSpec[] = [
  { source: 'decision', title: 'Decisions', detail: 'A question an agent asked you, with options and a recommendation. Leaves when you answer it or it is withdrawn.', default_on: true, partial: 'decisions' },
  { source: 'question', title: 'Questions', detail: 'An agent question assigned to you. Leaves when answered, dismissed or withdrawn. Answer from Inbox or its conversation.', default_on: true, partial: 'questions' },
  { source: 'card', title: 'Agent work to check', detail: 'A card an agent moved to Review or Blocked, for the person who handed it off. Leaves when the card moves on.', default_on: true, partial: 'agent work' },
  { source: 'followup', title: 'Follow-ups to send', detail: 'After a call with people outside the team, a drafted follow-up and the tasks it proposed. Leaves when you approve or dismiss it, or after a week.', default_on: true, partial: 'follow-ups' },
  { source: 'talk', title: 'Unread talk', detail: 'A subject conversation with something unread. Leaves when read.', default_on: true, partial: 'talk' },
  { source: 'guest', title: 'Guest messages', detail: 'A guest or an organization wrote on a subject you can see, and nobody here has answered. Leaves when someone replies or you dismiss it.', default_on: true, partial: 'guest messages' },
  { source: 'support', title: 'Starlings support', detail: 'Starlings support answered a question you asked in Help. Leaves when you read it.', default_on: true, partial: 'Starlings support' },
  { source: 'task', title: 'Proposed tasks', detail: 'A proposed task. Leaves when accepted or declined.', default_on: true, partial: 'proposed tasks' },
  { source: 'note', title: 'Quick Notes', detail: 'A note not yet filed. Leaves when filed or deleted.', default_on: true, partial: 'notes' },
  { source: 'sales', title: 'Sales touches', detail: 'A CRM touch with no lead yet, with Sales on. Leaves when a lead starts or it is dismissed.', default_on: true, partial: 'sales touches' },
  { source: 'comment', title: 'Document comments', detail: 'An open comment thread on a document about your subjects. Leaves when resolved.', default_on: true, partial: 'comments' },
  { source: 'booking', title: 'Bookings', detail: 'A guest booked, moved or cancelled a time on your page. Leaves when filed, dismissed, or the meeting starts.', default_on: true, partial: 'bookings' },
  { source: 'invitation', title: 'Calendar invitations', detail: 'Someone invited you to an event. Leaves when you accept, decline or say maybe, or when the event ends.', default_on: true, partial: 'calendar invitations' },
  { source: 'forwarded', title: 'Events from email', detail: 'An event read from mail you forwarded to calendar@. Leaves when you add or discard it, or after a week.', default_on: true, partial: 'events from email' },
  { source: 'interest', title: 'Interest', detail: 'A company filled in /interest, for admins. Leaves when dismissed.', default_on: true, partial: 'interest' },
  { source: 'submission', title: 'Form submissions', detail: 'Someone filled in one of the workspace’s public forms, for the people the form names. Leaves when dismissed.', default_on: true, partial: 'form submissions' },
  { source: 'commercial', title: 'Offers and licenses', detail: 'An offer that expires within a week, or a license that renews within 30 days, on a lead or organization you can see, with Sales on. Leaves when it is decided or renewed, or when dismissed.', default_on: true, partial: 'offers and licenses' },
];

/**
 * Which sources one person wants, stored as `{ [source]: boolean }` in
 * `work_preferences.inbox_sources` (migration 0040) and resolved source by
 * source: a stored key this build does not know is ignored, a source the
 * store does not name is on or off by its spec. `mention` follows `talk`.
 */
export type InboxSourcePreferences = Partial<Record<InboxSourceSpec['source'], boolean>>;

export function resolveInboxSources(stored: unknown): Record<InboxSource, boolean> {
  const row = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;
  const out = {} as Record<InboxSource, boolean>;
  for (const spec of INBOX_SOURCE_SPECS) {
    const value = row[spec.source];
    out[spec.source] = typeof value === 'boolean' ? value : spec.default_on;
  }
  out.mention = out.talk;
  return out;
}

/** The stored map, narrowed to keys this build knows and booleans only. */
export function normalizeInboxSourcePreferences(stored: unknown): InboxSourcePreferences {
  const row = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;
  const out: InboxSourcePreferences = {};
  for (const spec of INBOX_SOURCE_SPECS) {
    const value = row[spec.source];
    if (typeof value === 'boolean') out[spec.source] = value;
  }
  return out;
}

/** Store only choices that differ from the shared defaults. */
export function normalizeInboxSourceOverrides(stored: unknown): InboxSourcePreferences {
  const row = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;
  const out: InboxSourcePreferences = {};
  for (const spec of INBOX_SOURCE_SPECS) {
    const value = row[spec.source];
    if (typeof value === 'boolean' && value !== spec.default_on) out[spec.source] = value;
  }
  return out;
}

/** A cancelled booking older than this has been absorbed. */
export const INBOX_BOOKING_CHANGE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** An interest submission older than this is the tracker's, not news. */
export const INBOX_INTEREST_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** How many documents INBOX asks for comments, newest first. */
export const INBOX_COMMENT_DOCUMENT_LIMIT = 20;
/** Cross-subject read page ceilings; a hit is reported as a partial read. */
export const INBOX_PROPOSED_PAGE = 100;
export const INBOX_PROPOSED_PAGES = 5;
export const INBOX_COMMENT_LIST_PAGE = 200;
/** A follow-up nobody approved leaves INBOX after this. */
export const INBOX_FOLLOW_UP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const INBOX_FOLLOW_UP_LIMIT = 20;
/** How far back, and how many, cards handed to agents INBOX looks at. */
export const INBOX_CARD_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const INBOX_CARD_LIMIT = 50;
export const INBOX_COMMENT_LIST_PAGES = 5;

export function inboxItemMatchesFilter(
  item: { source: InboxSource },
  filter: InboxFilterSource,
): boolean {
  return filter === 'all' || inboxFilterSource(item.source) === filter;
}
