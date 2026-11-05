import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrmSubject } from './crm-work';

const subject = (kind: CrmSubject['kind'], id: string, title: string): CrmSubject => ({ id, kind, title, subtitle: null });
const fetchSubjects = vi.fn();
const fetchSubjectState = vi.fn();
const fetchThreads = vi.fn();

vi.mock('./crm-work', () => ({
  fetchSubjects: (...args: unknown[]) => fetchSubjects(...args),
  fetchSubjectState: () => fetchSubjectState(),
}));
vi.mock('./messages', () => ({ fetchThreads: () => fetchThreads(), threadTitle: () => '' }));

import { purgeOwnerLocalState } from './owner-local-state';
import {
  fetchQuickNoteDestinations,
  peekQuickNoteDestinations,
  QUICK_NOTE_DESTINATIONS_TTL_MS,
  searchQuickNoteSubjects,
  subjectDestinationOptions,
} from './quick-note-destinations';
import { invalidateSnapshots } from './snapshot-store';

/** One of each kind per list, so a call count is a count of reads. */
function answerEveryKind(): void {
  fetchSubjects.mockImplementation((kind: CrmSubject['kind']) => Promise.resolve({
    subjects: [subject(kind, kind, `${kind} acme`)], hasMore: false,
  }));
}

describe('quick note destinations', () => {
  beforeEach(() => {
    fetchSubjects.mockReset();
    fetchSubjectState.mockReset().mockResolvedValue({ states: [] });
    fetchThreads.mockReset().mockResolvedValue([]);
    window.dispatchEvent(new CustomEvent('meet-snapshot-invalidate', { detail: ['crm/subjects'] }));
  });

  it('labels a partner as Partner and keeps projectsOnly to projects', () => {
    const subjects = [subject('project', 'p', 'Alpha'), subject('lead', 'l', 'Beta'), subject('organization', 'o', 'Gamma')];
    expect(subjectDestinationOptions(subjects, new Set()).map((o) => [o.id, o.context]))
      .toEqual([['project:p', 'Project'], ['lead:l', 'Lead'], ['organization:o', 'Partner']]);
    expect(subjectDestinationOptions(subjects, new Set(), true).map((o) => o.id)).toEqual(['project:p']);
  });

  it('searches partners too, but never on the projectsOnly path', async () => {
    fetchSubjects.mockImplementation((kind: CrmSubject['kind']) => Promise.resolve({
      subjects: [subject(kind, kind, `${kind} acme`)], hasMore: false,
    }));
    const all = await searchQuickNoteSubjects('acme', false);
    expect(all.map((s) => s.kind).sort()).toEqual(['lead', 'organization', 'project']);
    fetchSubjects.mockClear();
    const projects = await searchQuickNoteSubjects('acme', true);
    expect(projects.map((s) => s.kind)).toEqual(['project']);
    expect(fetchSubjects).toHaveBeenCalledTimes(1);
  });

  it('lists partners with their has-more flag, and survives a partner read that fails', async () => {
    fetchSubjects.mockImplementation((kind: CrmSubject['kind']) => kind === 'organization'
      ? Promise.reject(new Error('no partners'))
      : Promise.resolve({ subjects: [subject(kind, kind, kind)], hasMore: true }));
    const lists = await fetchQuickNoteDestinations();
    expect(lists.subjects.map((s) => s.kind).sort()).toEqual(['lead', 'project']);
    expect(lists.partnersHaveMore).toBe(false);
    expect(lists.projectsHaveMore).toBe(true);
  });

  it('puts starred subjects first, then the rest by title', async () => {
    fetchSubjects.mockImplementation((kind: CrmSubject['kind']) => Promise.resolve({
      subjects: kind === 'project'
        ? [subject('project', 'b', 'Bravo'), subject('project', 'z', 'Zulu')]
        : kind === 'lead' ? [subject('lead', 'a', 'Alpha')] : [],
      hasMore: false,
    }));
    fetchSubjectState.mockResolvedValue({ states: [{ kind: 'project', id: 'z', starred: true }] });
    const lists = await fetchQuickNoteDestinations();
    expect(lists.subjects.map((s) => s.title)).toEqual(['Zulu', 'Alpha', 'Bravo']);
    expect(subjectDestinationOptions(lists.subjects, lists.starred).map((o) => o.isStarred))
      .toEqual([true, false, false]);
  });

  it('reuses the lists on the next open, and shares one read between two opens at once', async () => {
    answerEveryKind();
    const [first, second] = await Promise.all([fetchQuickNoteDestinations(), fetchQuickNoteDestinations()]);
    expect(second).toBe(first);
    expect(fetchSubjects).toHaveBeenCalledTimes(3);
    expect(fetchThreads).toHaveBeenCalledTimes(1);

    expect(peekQuickNoteDestinations()).toBe(first);
    expect(await fetchQuickNoteDestinations()).toBe(first);
    expect(fetchSubjects).toHaveBeenCalledTimes(3);
    expect(fetchThreads).toHaveBeenCalledTimes(1);
  });

  it('lets the lists go after five minutes', async () => {
    answerEveryKind();
    await fetchQuickNoteDestinations();
    expect(peekQuickNoteDestinations(Date.now() + QUICK_NOTE_DESTINATIONS_TTL_MS - 1_000)).not.toBeNull();
    expect(peekQuickNoteDestinations(Date.now() + QUICK_NOTE_DESTINATIONS_TTL_MS)).toBeNull();
  });

  it.each(['crm/subjects', 'crm/subject-state', 'crm/starred', 'threads'])(
    'reads again after a write invalidates %s',
    async (source) => {
      answerEveryKind();
      const first = await fetchQuickNoteDestinations();
      invalidateSnapshots([source]);
      expect(peekQuickNoteDestinations()).toBeNull();
      const second = await fetchQuickNoteDestinations();
      expect(second).not.toBe(first);
      expect(fetchSubjects).toHaveBeenCalledTimes(6);
    },
  );

  it('keeps the lists through a write to an unrelated source', async () => {
    answerEveryKind();
    const first = await fetchQuickNoteDestinations();
    invalidateSnapshots(['calendar/events']);
    expect(peekQuickNoteDestinations()).toBe(first);
    expect(fetchSubjects).toHaveBeenCalledTimes(3);
  });

  it('reuses a search for the same query, and forgets it on invalidation', async () => {
    answerEveryKind();
    await fetchQuickNoteDestinations();
    fetchSubjects.mockClear();
    const first = await searchQuickNoteSubjects('Acme', false);
    expect(await searchQuickNoteSubjects('  acme ', false)).toBe(first);
    expect(fetchSubjects).toHaveBeenCalledTimes(3);
    invalidateSnapshots(['crm/subjects']);
    await searchQuickNoteSubjects('acme', false);
    expect(fetchSubjects.mock.calls.filter(([, query]) => query !== '')).toHaveLength(6);
  });

  it('forgets everything on sign-out, so the next owner reads their own lists', async () => {
    answerEveryKind();
    await fetchQuickNoteDestinations();
    await searchQuickNoteSubjects('acme', false);
    purgeOwnerLocalState();
    expect(peekQuickNoteDestinations()).toBeNull();
    fetchSubjects.mockClear();
    await fetchQuickNoteDestinations();
    await searchQuickNoteSubjects('acme', false);
    expect(fetchSubjects).toHaveBeenCalledTimes(6);
  });

  it('never keeps a read that was in flight when the owner signed out', async () => {
    let release: () => void = () => {};
    fetchThreads.mockImplementation(() => new Promise((resolve) => { release = () => resolve([]); }));
    answerEveryKind();
    const pending = fetchQuickNoteDestinations();
    // Let the reads start before the purge, as a slow network would.
    await Promise.resolve();
    purgeOwnerLocalState();
    release();
    await expect(pending).rejects.toMatchObject({ status: 401 });
    expect(peekQuickNoteDestinations()).toBeNull();

    fetchThreads.mockResolvedValue([]);
    await expect(fetchQuickNoteDestinations()).resolves.toBeTruthy();
    expect(peekQuickNoteDestinations()).not.toBeNull();
  });
});
