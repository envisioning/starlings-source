/**
 * Zod-free search values and algorithms shared by the browser entry path.
 * The schema module re-exports these names for existing contract consumers.
 */
import { SETTINGS_PAGES_EVERYWHERE, type SettingsPageEverywhere } from './settings-pages';
import type { WorkRowActionID } from './work-actions';
import { parseDoor, doorString, type Door } from '@starlings/subject-spec/doors';
import type { SubjectKind } from '@starlings/subject-spec/kinds';
import { MEMBER_SURFACES, type MemberSurfaceId } from './member-surfaces';

export const SEARCH_KINDS = [
  'subject', 'person', 'agent',
  // A person outside the workspace. Its door opens the contact page.
  'contact',
  'thread', 'document', 'folder', 'event', 'task', 'issue',
  // A goal on a project and a decision on a subject (#262). Their
  // door is the subject's: the row opens the subject, where the thing lives.
  'goal', 'decision',
  // A milestone on a project and a call on a subject, found in D1
  // once their group moves. Their door is the subject's, as a goal's is.
  'milestone', 'call',
  'core',
  'destination', 'settings', 'verb',
] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

/** The validated shape a search hit and local recent share. */
export interface SearchRow {
  kind: SearchKind;
  id: string;
  title: string;
  subtitle: string;
  door: string;
  image?: string;
}

/** Things. A hit's door opens the thing. */
export const SEARCH_HIT_KINDS = SEARCH_KINDS.slice(0, SEARCH_KINDS.indexOf('destination')) as readonly SearchKind[];
/** Places and verbs. A door's door is the place or verb itself. */
export const SEARCH_DOOR_KINDS = SEARCH_KINDS.slice(SEARCH_KINDS.indexOf('destination')) as readonly SearchKind[];

/**
 * The words of the palette, for every client: the badge on a row, the title
 * of each Settings door and verb. The web draws them through `t()`; the
 * generator writes the Swift `title` and `label` of the search enums
 * (`Sources/Generated/SearchValuesRegistry.swift`). The Go to doors are the
 * member surfaces' titles.
 */
export const SEARCH_KIND_LABELS: Record<SearchKind, string> = {
  subject: 'Subject',
  person: 'Person',
  agent: 'Agent',
  contact: 'Contact',
  thread: 'Conversation',
  document: 'Document',
  folder: 'Folder',
  event: 'Event',
  task: 'Task',
  issue: 'Issue',
  goal: 'Goal',
  decision: 'Decision',
  milestone: 'Milestone',
  call: 'Call',
  core: 'Records',
  destination: 'Go to',
  settings: 'Settings',
  verb: 'Do',
};

export function isSearchKind(value: unknown): value is SearchKind {
  return typeof value === 'string' && (SEARCH_KINDS as readonly string[]).includes(value);
}

/** The Go to doors are the member surfaces (`member-surfaces.ts`), in their order. */
export const SEARCH_DESTINATIONS: readonly MemberSurfaceId[] = MEMBER_SURFACES.map((surface) => surface.id);
export type SearchDestination = MemberSurfaceId;

/** The Settings pages a door can open: the ones every client lists (`settings-pages.ts`), not a list of its own. */
export const SEARCH_SETTINGS_PAGES = SETTINGS_PAGES_EVERYWHERE;
export type SearchSettingsPage = SettingsPageEverywhere;

export const SEARCH_VERBS = ['new-task', 'new-issue', 'new-document', 'start-room', 'open-internal-room'] as const;
export type SearchVerb = (typeof SEARCH_VERBS)[number];

/** The standard's subject kinds in the order search lists them. */
export const SEARCH_SUBJECT_KINDS = ['lead', 'project', 'organization', 'event'] as const satisfies readonly SubjectKind[];
export type SearchSubjectKind = (typeof SEARCH_SUBJECT_KINDS)[number];

/**
 * A person is one row. → or ⌘-Enter shows these, named per docs/SURFACES.md;
 * a client drops Call when the person is not callable. Knock is a guest's
 * gesture at a room door, not a person verb.
 */
export const SEARCH_PERSON_VERBS = ['message', 'wave', 'call'] as const satisfies readonly WorkRowActionID[];
export type SearchPersonVerb = (typeof SEARCH_PERSON_VERBS)[number];

export function searchPersonVerbs(kind: SearchKind): readonly SearchPersonVerb[] {
  if (kind === 'person') return SEARCH_PERSON_VERBS;
  if (kind === 'agent') return ['message'];
  return [];
}

/**
 * A subject is one row too. → or ⌘-Enter shows what can be made
 * about it: a task, an issue, a document, a room filed under it. A partner
 * is read-only and takes none; an event takes tasks only (docs/EVENTS.md).
 * The verbs are the same names as the bare palette verbs, with the subject
 * as their argument; the client opens the subject's own editor.
 */
export const SEARCH_SUBJECT_VERBS = ['new-task', 'new-issue', 'new-document', 'start-room'] as const satisfies readonly WorkRowActionID[];
export type SearchSubjectVerb = (typeof SEARCH_SUBJECT_VERBS)[number];

export const SEARCH_SETTINGS_TITLES: Record<SearchSettingsPage, string> = {
  account: 'Account',
  home: 'Home',
  work: 'Work',
  calendar: 'Calendar',
  appearance: 'Appearance',
  about: 'About',
};

export const SEARCH_VERB_TITLES: Record<SearchVerb, string> = {
  'new-task': 'New task',
  'new-issue': 'New issue',
  'new-document': 'New document',
  'start-room': 'Start room',
  'open-internal-room': 'Open Team Room',
};

/** The words are docs/SURFACES.md's (invariant 22). */
export const SEARCH_PERSON_VERB_TITLES: Record<SearchPersonVerb, string> = {
  message: 'Message',
  wave: 'Wave',
  call: 'Call',
};

/** A subject's verbs: the bare verbs' names, with the subject as their argument. */
export const SEARCH_SUBJECT_VERB_TITLES: Record<SearchSubjectVerb, string> = {
  'new-task': 'New task',
  'new-issue': 'New issue',
  'new-document': 'New document',
  'start-room': 'Meet about this',
};
export type SearchRowVerb = SearchPersonVerb | SearchSubjectVerb;

export function searchSubjectVerbs(subjectKind: SearchSubjectKind): readonly SearchSubjectVerb[] {
  switch (subjectKind) {
    case 'project':
    case 'lead':
      return SEARCH_SUBJECT_VERBS;
    case 'event':
    case 'organization':
      return ['new-task'];
  }
}

/** The verbs behind a row: a person's, or a subject's by the kind its door names. */
export function searchRowVerbs(row: Pick<SearchRow, 'kind' | 'door'>): readonly SearchRowVerb[] {
  if (row.kind === 'subject') {
    const door = parseSearchDoor(row.door);
    return door?.to === 'subject' ? searchSubjectVerbs(door.subjectKind) : [];
  }
  return searchPersonVerbs(row.kind);
}

/** The scope each field asks with. The table in the fixture. */
export const SEARCH_SCOPES: Readonly<Record<'palette' | 'work' | 'team' | 'calendar' | 'docs', readonly SearchKind[]>> = {
  palette: SEARCH_KINDS,
  work: ['subject', 'contact', 'task', 'issue', 'goal', 'decision', 'milestone', 'call', 'core', 'document'],
  team: ['person', 'agent', 'thread'],
  calendar: ['event'],
  docs: ['document', 'folder'],
};

// MARK: - Doors

/**
 * Where a row goes. The wire spelling is `<to>:<id>` (`subject:<kind>:<id>`);
 * `parseSearchDoor` is the one reader and `searchDoorString` the one writer.
 * Thing doors are the open standard's (`parseDoor`, ADR 0005); places, verbs,
 * folders and Core records are Starlings' own. A door names an existing route
 * or window destination; the palette never invents navigation.
 */
export type SearchDoor =
  | Door
  | { to: 'destination'; destination: SearchDestination }
  | { to: 'settings'; page: SearchSettingsPage }
  | { to: 'verb'; verb: SearchVerb }
  | { to: 'folder' | 'core'; id: string };

export function parseSearchDoor(door: string): SearchDoor | null {
  const thing = parseDoor(door);
  if (thing) return thing;
  const colon = door.indexOf(':');
  if (colon <= 0) return null;
  const to = door.slice(0, colon);
  const rest = door.slice(colon + 1);
  if (rest.length === 0) return null;
  switch (to) {
    case 'destination':
      return (SEARCH_DESTINATIONS as readonly string[]).includes(rest) ? { to, destination: rest as SearchDestination } : null;
    case 'settings':
      return (SEARCH_SETTINGS_PAGES as readonly string[]).includes(rest) ? { to, page: rest as SearchSettingsPage } : null;
    case 'verb':
      return (SEARCH_VERBS as readonly string[]).includes(rest) ? { to, verb: rest as SearchVerb } : null;
    case 'folder':
    case 'core':
      return { to, id: rest };
    default:
      return null;
  }
}

export function searchDoorString(door: SearchDoor): string {
  switch (door.to) {
    case 'destination': return `destination:${door.destination}`;
    case 'settings': return `settings:${door.page}`;
    case 'verb': return `verb:${door.verb}`;
    case 'folder':
    case 'core': return `${door.to}:${door.id}`;
    default: return doorString(door);
  }
}

// MARK: - Rows

export function searchRowKey(row: Pick<SearchRow, 'kind' | 'id'>): string {
  return `${row.kind}:${row.id}`;
}

export type SearchOrder = 'list' | 'rank';

export interface SearchOptions {
  scope: readonly SearchKind[];
  order: SearchOrder;
  /** Keys of the last opened hits, newest first. Per device; never on the server. */
  recents?: readonly string[];
}

/** NORMALIZE in the fixture: case-folded, diacritic-folded. */
export function normalizeSearchText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
}

function words(normalized: string): string[] {
  return normalized.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 0);
}

export function searchTokens(query: string): string[] {
  return words(normalizeSearchText(query));
}

/** MATCH in the fixture: the row's tier, or null when a token matches nothing. */
export function searchTier(row: Pick<SearchRow, 'title' | 'subtitle'>, tokens: readonly string[]): number | null {
  if (tokens.length === 0) return 2;
  const title = normalizeSearchText(row.title);
  const titleWords = words(title);
  const subtitle = normalizeSearchText(row.subtitle);
  let tier = 2;
  for (const token of tokens) {
    let own: number;
    if (titleWords.some((word) => word.startsWith(token))) own = 2;
    else if (title.includes(token)) own = 1;
    else if (subtitle.includes(token)) own = 0;
    else return null;
    tier = Math.min(tier, own);
  }
  return tier;
}

/**
 * A field that thins a list in place (decision 13) asks this per row: the
 * same MATCH rule as `search`, with the order left to the list.
 */
export function searchMatches(query: string, title: string, subtitle: string): boolean {
  return searchTier({ title, subtitle }, searchTokens(query)) !== null;
}

/**
 * The one matcher. `list` thins the rows and keeps their order; `rank`
 * orders by tier, then recency, then kind order, then the rows' order.
 */
export function search<Row extends SearchRow>(rows: readonly Row[], query: string, options: SearchOptions): Row[] {
  const scope = new Set(options.scope);
  const tokens = searchTokens(query);
  const matched: Array<{ row: Row; tier: number; index: number }> = [];
  rows.forEach((row, index) => {
    if (!scope.has(row.kind)) return;
    const tier = searchTier(row, tokens);
    if (tier === null) return;
    matched.push({ row, tier, index });
  });
  if (options.order === 'list') return matched.map((entry) => entry.row);

  const recency = new Map<string, number>();
  (options.recents ?? []).forEach((key, at) => {
    if (!recency.has(key)) recency.set(key, at);
  });
  const recentRank = (row: Row): number => {
    if (!SEARCH_HIT_KINDS.includes(row.kind)) return Number.MAX_SAFE_INTEGER;
    return recency.get(searchRowKey(row)) ?? Number.MAX_SAFE_INTEGER;
  };
  matched.sort((a, b) =>
    b.tier - a.tier
    || recentRank(a.row) - recentRank(b.row)
    || SEARCH_KINDS.indexOf(a.row.kind) - SEARCH_KINDS.indexOf(b.row.kind)
    || a.index - b.index);
  return matched.map((entry) => entry.row);
}

/** Push a key to the front of a recents list, once, capped. */
export function rememberSearchRecent(recents: readonly string[], row: Pick<SearchRow, 'kind' | 'id'>, limit = 20): string[] {
  if (!SEARCH_HIT_KINDS.includes(row.kind)) return [...recents];
  const key = searchRowKey(row);
  return [key, ...recents.filter((other) => other !== key)].slice(0, limit);
}

/** A browser guard for API rows and locally stored recents. */
export function isSearchRow(value: unknown): value is SearchRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const allowed = new Set(['kind', 'id', 'title', 'subtitle', 'door', 'image']);
  if (Object.keys(row).some((key) => !allowed.has(key))) return false;
  if (!isSearchKind(row.kind)) return false;
  if (typeof row.id !== 'string' || row.id.length < 1 || row.id.length > 1024) return false;
  if (typeof row.title !== 'string' || row.title.length > 1024) return false;
  if (typeof row.subtitle !== 'string' || row.subtitle.length > 1024) return false;
  if (typeof row.door !== 'string' || row.door.length < 1 || row.door.length > 2048 || parseSearchDoor(row.door) === null) return false;
  if (row.image === undefined) return true;
  if (typeof row.image !== 'string' || row.image.length > 2048) return false;
  try {
    new URL(row.image);
    return true;
  } catch {
    return false;
  }
}
