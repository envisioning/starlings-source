/**
 * The cases of fixtures/work-ranker.json: the inputs are written here, the order,
 * the rail and the scores come from the TypeScript ranker, the source of truth.
 * `scripts/gen-swift-registries.mjs` writes the file (`pnpm registries:gen`);
 * `Tests/WorkRankerFixtureTests.swift` holds the Swift ranker to it.
 */
import { DEFAULT_WORK_RANK_CRITERIA, rankWorkSubjects, workRankRail, type WorkRankSignals, type WorkRankSubjectShape } from '../src/work-ranker';

const NOW = '2026-09-30T12:00:00Z';
const nowMs = Date.parse(NOW);
const ago = (days: number) => new Date(nowMs - days * 86_400_000).toISOString();
const day = (offset: number) => new Date(nowMs + offset * 86_400_000).toISOString().slice(0, 10);

type Subject = WorkRankSubjectShape;
const project = (id: string, title: string, extra: Partial<Subject> = {}): Subject => ({ id, title, kind: 'project', open_tasks: 0, overdue_tasks: 0, last_activity_at: null, event_date: null, ...extra });

const cases: Array<{ name: string; subjects: Subject[]; signals: Record<string, WorkRankSignals>; limit?: number }> = [
  {
    name: 'a star beats direct attention, attention beats unread, unread beats nothing',
    subjects: [project('a', 'Alpha'), project('b', 'Bravo'), project('c', 'Charlie'), project('d', 'Delta')],
    signals: { a: { unread: true }, b: { starred: true }, c: { direct_attention: true } },
  },
  {
    name: 'overdue counts up to three tasks, open work up to five',
    subjects: [
      project('a', 'Alpha', { overdue_tasks: 9 }),
      project('b', 'Bravo', { overdue_tasks: 3 }),
      project('c', 'Charlie', { open_tasks: 40 }),
      project('d', 'Delta', { open_tasks: 5 }),
    ],
    signals: {},
  },
  {
    name: 'an event today, soon, at the edge of the horizon, beyond it, and past',
    subjects: [
      { id: 'today', title: 'Today', kind: 'event', event_date: day(0) },
      { id: 'soon', title: 'Soon', kind: 'event', event_date: day(3) },
      { id: 'edge', title: 'Edge', kind: 'event', event_date: day(14) },
      { id: 'far', title: 'Far', kind: 'event', event_date: day(15) },
      { id: 'past', title: 'Past', kind: 'event', event_date: day(-2) },
      { id: 'undated', title: 'Undated', kind: 'event', event_date: null },
    ],
    signals: {},
  },
  {
    name: 'activity fades by half every three days, and old open work turns stale',
    subjects: [
      project('fresh', 'Fresh', { last_activity_at: ago(0) }),
      project('three', 'Three', { last_activity_at: ago(3) }),
      project('week', 'Week', { last_activity_at: ago(7) }),
      project('staleWork', 'StaleWork', { last_activity_at: ago(8), open_tasks: 1 }),
      project('staleQuiet', 'StaleQuiet', { last_activity_at: ago(8) }),
    ],
    signals: {},
  },
  {
    name: 'ties break on the latest activity, then the title, then the id',
    subjects: [
      project('z1', 'Same', { last_activity_at: ago(30) }),
      project('z2', 'Same', { last_activity_at: ago(30) }),
      project('m', 'Middle', { last_activity_at: ago(30) }),
      project('n', 'Newer', { last_activity_at: ago(31) }),
      project('o', 'Older', { last_activity_at: ago(40) }),
    ],
    signals: {},
  },
  {
    name: 'the rail holds twelve',
    subjects: Array.from({ length: 14 }, (_, index) => project(`p${String(index).padStart(2, '0')}`, `Project ${String(index).padStart(2, '0')}`, { open_tasks: index % 6 })),
    signals: {},
  },
];

export const workRankerFixture = () => ({
  version: 1,
  now: NOW,
  criteria: DEFAULT_WORK_RANK_CRITERIA,
  cases: cases.map((row) => {
    const signalsFor = (subject: Subject) => row.signals[subject.id] ?? {};
    const ranked = rankWorkSubjects(row.subjects, signalsFor, nowMs);
    return {
      name: row.name,
      subjects: row.subjects,
      signals: row.signals,
      order: ranked.map((entry) => entry.item.id),
      rail: workRankRail(row.subjects, signalsFor, nowMs).map((entry) => entry.item.id),
      scores: Object.fromEntries(ranked.map((entry) => [entry.item.id, Math.round(entry.score * 1e6) / 1e6])),
    };
  }),
});
