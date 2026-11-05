import type { ThreadSummary } from '@starlings/contracts';
import { fetchSubjectState, fetchSubjects, type CrmSubject, type SubjectPage } from './crm-work';
import { onOwnerPurge } from './owner-local-state';
import { fetchThreads, threadTitle } from './messages';
import { INVALIDATE_EVENT, snapshotMatches, staleReadError, storeGeneration } from './snapshot-store';
import { t } from './i18n';
import { type SearchablePickerOption } from './searchable-picker';

export const QUICK_NOTE_DESTINATIONS_TTL_MS = 5 * 60_000;

export type QuickNoteDestinationOption = SearchablePickerOption;

export interface QuickNoteDestinationLists {
  subjects: CrmSubject[];
  starred: Set<string>;
  threads: ThreadSummary[];
  projectsHaveMore: boolean;
  leadsHaveMore: boolean;
  partnersHaveMore: boolean;
}

interface Cached<T> {
  value: T;
  savedAt: number;
  generation: number;
  epoch: number;
}

let lists: Cached<QuickNoteDestinationLists> | null = null;
let listsRequest: Promise<QuickNoteDestinationLists> | null = null;
const subjectSearches = new Map<string, Cached<CrmSubject[]>>();
const subjectSearchRequests = new Map<string, Promise<CrmSubject[]>>();
let epoch = 0;

function clearQuickNoteDestinationCache(): void {
  epoch += 1;
  lists = null;
  listsRequest = null;
  subjectSearches.clear();
  subjectSearchRequests.clear();
}

onOwnerPurge(clearQuickNoteDestinationCache);

if (typeof window !== 'undefined') {
  window.addEventListener(INVALIDATE_EVENT, (event) => {
    const prefixes = (event as CustomEvent<string[]>).detail ?? [];
    if (['crm/subjects', 'crm/subject-state', 'crm/starred', 'threads']
      .some((source) => snapshotMatches(source, prefixes))) {
      clearQuickNoteDestinationCache();
    }
  });
}

export function peekQuickNoteDestinations(now = Date.now()): QuickNoteDestinationLists | null {
  if (!lists || !isFresh(lists, now)) return null;
  return lists.value;
}

/** A short memory cache prevents filing the same note twice from rereading every list. */
export async function fetchQuickNoteDestinations(): Promise<QuickNoteDestinationLists> {
  const cached = peekQuickNoteDestinations();
  if (cached) return cached;
  if (listsRequest) return listsRequest;

  const startedEpoch = epoch;
  const startedGeneration = storeGeneration();
  // A subject list that fails (an outage, or a workspace without that store
  // yet) leaves the other destinations usable: messages and docs never
  // depend on subjects ( audit). A partial answer is not cached.
  let partial = false;
  const subjectsOrNone = <T extends { subjects: CrmSubject[]; hasMore: boolean }>(read: Promise<T>) =>
    read.catch(() => {
      partial = true;
      return { subjects: [] as CrmSubject[], hasMore: false };
    });
  const request = Promise.all([
    subjectsOrNone(fetchSubjects('project', '')),
    subjectsOrNone(fetchSubjects('lead', '')),
    subjectsOrNone(fetchPartners('')),
    fetchThreads(),
    fetchSubjectState().catch(() => null),
  ]).then(([projects, leads, partners, threads, state]) => {
    if (startedEpoch !== epoch || startedGeneration !== storeGeneration()) {
      throw staleReadError();
    }
    const starred = new Set((state?.states ?? [])
      .filter((row) => row.starred)
      .map((row) => `${row.kind}:${row.id}`));
    const isStarred = (subject: CrmSubject) => starred.has(`${subject.kind}:${subject.id}`);
    const value: QuickNoteDestinationLists = {
      subjects: [...projects.subjects, ...leads.subjects, ...partners.subjects].sort((left, right) =>
        Number(isStarred(right)) - Number(isStarred(left)) || left.title.localeCompare(right.title)),
      starred,
      threads,
      projectsHaveMore: projects.hasMore,
      leadsHaveMore: leads.hasMore,
      partnersHaveMore: partners.hasMore,
    };
    if (!partial) lists = { value, savedAt: Date.now(), generation: startedGeneration, epoch: startedEpoch };
    return value;
  }).finally(() => {
    if (listsRequest === request) listsRequest = null;
  });
  listsRequest = request;
  return request;
}

/** A debounced picker search caches each owner-session query for the same short window. */
export async function searchQuickNoteSubjects(query: string, projectsOnly: boolean): Promise<CrmSubject[]> {
  const cleaned = query.trim();
  if (!cleaned) return [];
  const key = `${projectsOnly ? 'projects' : 'subjects'}:${fold(cleaned)}`;
  const cached = subjectSearches.get(key);
  if (cached && isFresh(cached)) return cached.value;
  const running = subjectSearchRequests.get(key);
  if (running) return running;

  const startedEpoch = epoch;
  const startedGeneration = storeGeneration();
  const request = (async () => {
    const [projects, leads, partners] = await Promise.all([
      fetchSubjects('project', cleaned),
      projectsOnly ? Promise.resolve(null) : fetchSubjects('lead', cleaned),
      projectsOnly ? Promise.resolve(null) : fetchPartners(cleaned),
    ]);
    if (startedEpoch !== epoch || startedGeneration !== storeGeneration()) throw staleReadError();
    const starred = peekQuickNoteDestinations()?.starred ?? (await fetchQuickNoteDestinations()).starred;
    const subjects = [...projects.subjects, ...(leads?.subjects ?? []), ...(partners?.subjects ?? [])].sort((left, right) =>
      Number(starred.has(`${right.kind}:${right.id}`)) - Number(starred.has(`${left.kind}:${left.id}`))
        || left.title.localeCompare(right.title));
    subjectSearches.set(key, {
      value: subjects,
      savedAt: Date.now(),
      generation: startedGeneration,
      epoch: startedEpoch,
    });
    return subjects;
  })();
  const tracked = request.finally(() => {
    if (subjectSearchRequests.get(key) === tracked) subjectSearchRequests.delete(key);
  });
  subjectSearchRequests.set(key, tracked);
  return tracked;
}

export function subjectDestinationOptions(
  subjects: CrmSubject[],
  starred: Set<string>,
  projectsOnly = false,
): QuickNoteDestinationOption[] {
  return subjects
    .filter((subject) => !projectsOnly || subject.kind === 'project')
    .map((subject) => ({
      id: `${subject.kind}:${subject.id}`,
      title: subject.title,
      context: subject.kind === 'project' ? t('Project') : subject.kind === 'organization' ? t('Partner') : t('Lead'),
      subtitle: subject.subtitle,
      isStarred: starred.has(`${subject.kind}:${subject.id}`),
    }));
}

export function threadDestinationOptions(threads: ThreadSummary[]): QuickNoteDestinationOption[] {
  return threads.map((thread) => ({
    id: thread.id,
    title: threadTitle(thread),
    isStarred: false,
  }));
}

/** Partners ride behind projects and leads: a Core that does not answer for them leaves them out, never the note's other destinations. */
function fetchPartners(query: string): Promise<SubjectPage> {
  return fetchSubjects('organization', query).catch(() => ({ subjects: [], hasMore: false }));
}

function fold(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase();
}

function isFresh<T>(cached: Cached<T>, now = Date.now()): boolean {
  return cached.epoch === epoch
    && cached.generation === storeGeneration()
    && now - cached.savedAt < QUICK_NOTE_DESTINATIONS_TTL_MS;
}
