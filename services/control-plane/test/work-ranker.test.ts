import { describe, expect, it } from 'vitest';
import { DEFAULT_WORK_RANK_CRITERIA, rankWorkSubjects, workRankRail, type WorkRankSubjectShape } from '@starlings/contracts/work-ranker';
import workRankerFixture from '../../../fixtures/work-ranker.json';

const subject = (id: string, extra: Partial<WorkRankSubjectShape> = {}): WorkRankSubjectShape => ({ id, title: id, kind: 'project', ...extra });

describe('work ranker', () => {
  const now = Date.parse('2026-09-20T12:00:00.000Z');

  it('floats direct attention and overdue work above ordinary recency', () => {
    const ranked = rankWorkSubjects([
      subject('quiet', { last_activity_at: '2026-09-20T11:55:00.000Z', open_tasks: 1 }),
      subject('late', { overdue_tasks: 2, open_tasks: 2, last_activity_at: '2026-09-10T11:55:00.000Z' }),
      subject('mention', { last_activity_at: '2026-09-01T11:55:00.000Z' }),
    ], (row) => ({ direct_attention: row.id === 'mention' }), now);
    expect(ranked.map((row) => row.item.id)).toEqual(['mention', 'late', 'quiet']);
    expect(ranked[0]?.reasons.map((reason) => reason.code)).toContain('direct_attention');
    expect(ranked[1]?.reasons.map((reason) => reason.code)).toContain('overdue');
  });

  it('floats approaching events but ignores distant events', () => {
    const ranked = rankWorkSubjects([
      subject('distant-event', { kind: 'event', event_date: '2026-10-30' }),
      subject('tomorrow-event', { kind: 'event', event_date: '2026-09-21' }),
      subject('today-event', { kind: 'event', event_date: '2026-09-20' }),
    ], undefined, now);
    expect(ranked.map((row) => row.item.id)).toEqual(['today-event', 'tomorrow-event', 'distant-event']);
    expect(ranked[0]?.reasons.map((reason) => reason.code)).toContain('event_today');
    expect(ranked[1]?.reasons.map((reason) => reason.code)).toContain('event_soon');
    expect(ranked[2]?.reasons.map((reason) => reason.code)).not.toContain('event_soon');
  });

  it('bounds the rail without losing the full ranked answer', () => {
    const rows = Array.from({ length: DEFAULT_WORK_RANK_CRITERIA.railLimit + 3 }, (_, index) => subject(String(index)));
    const ranked = rankWorkSubjects(rows, undefined, now);
    const rail = workRankRail(rows, undefined, now);
    expect(ranked).toHaveLength(rows.length);
    expect(rail).toHaveLength(DEFAULT_WORK_RANK_CRITERIA.railLimit);
    expect(rail.map((row) => row.item.id)).toEqual(ranked.slice(0, DEFAULT_WORK_RANK_CRITERIA.railLimit).map((row) => row.item.id));
  });

  it('caps task volume so direct attention still wins', () => {
    const ranked = rankWorkSubjects([
      subject('big', { open_tasks: 100, overdue_tasks: 3 }),
      subject('direct'),
    ], (row) => ({ direct_attention: row.id === 'direct' }), now);
    expect(ranked[0]?.item.id).toBe('direct');
  });
});

describe('work ranker fixture', () => {
  // fixtures/work-ranker.json is generated from this ranker (pnpm registries:gen; the
  // cases are in packages/contracts/scripts/work-ranker-fixture.ts) and held to it by the Swift
  // ranker (Tests/WorkRankerFixtureTests.swift). A change here without regenerating it fails here.
  const fixture = workRankerFixture as {
    now: string;
    criteria: typeof DEFAULT_WORK_RANK_CRITERIA;
    cases: Array<{ name: string; subjects: WorkRankSubjectShape[]; signals: Record<string, { starred?: boolean; direct_attention?: boolean; unread?: boolean }>; order: string[]; rail: string[]; scores: Record<string, number> }>;
  };

  it('holds the criteria the native rankers are generated from', () => {
    expect(fixture.criteria).toEqual(DEFAULT_WORK_RANK_CRITERIA);
  });

  it('is what the ranker answers today', () => {
    const now = Date.parse(fixture.now);
    for (const row of fixture.cases) {
      const signalsFor = (subject: WorkRankSubjectShape) => row.signals[subject.id] ?? {};
      const ranked = rankWorkSubjects(row.subjects, signalsFor, now);
      expect(ranked.map((entry) => entry.item.id), row.name).toEqual(row.order);
      expect(workRankRail(row.subjects, signalsFor, now).map((entry) => entry.item.id), row.name).toEqual(row.rail);
      for (const entry of ranked) expect(entry.score, `${row.name}: ${entry.item.id}`).toBeCloseTo(row.scores[entry.item.id] ?? Number.NaN, 5);
    }
  });
});
