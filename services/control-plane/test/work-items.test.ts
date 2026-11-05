import { describe, expect, it } from 'vitest';
import {
  eventDaysUntil,
  eventPhase,
  filterMinePlan,
  filterWorkPlan,
  planBoard,
  planFocus,
  planUnowned,
  planWork,
  passesHolderFilter,
  passesTaskFilter,
  type WorkFilterShape,
  type WorkTaskFilter,
  stageOf,
  WORK_SECTIONS,
  WORK_STAGES,
  writeStage,
  type WorkCardShape,
  type WorkHeldCardShape,
  type WorkItemShape,
  type WorkSection,
  type WorkStage,
  type WorkStageShape,
} from '@starlings/contracts/work-items';
import fixture from '../../../fixtures/work-items.json';

/**
 * The shared table, run against the TypeScript implementation. The Swift port
 * runs the same file (Tests/WorkItemFixtureTests.swift), which is the whole
 * point: three surfaces answering "what do I owe" with three orderings is the
 * drift this table exists to prevent.
 *
 * A failure here is a question about `fixtures/work-items.json` first — the
 * rules live there, and both implementations answer to it.
 */

interface FixtureCase {
  name: string;
  now: string;
  timeZone: string;
  items: WorkItemShape[];
  expect: {
    order: string[];
    sections: Record<WorkSection, string[]>;
    open: number;
    late: number;
  };
}

const cases = fixture.cases as unknown as FixtureCase[];

describe('work-items fixture', () => {
  it('is the version this implementation was written against', () => {
    expect(fixture.version).toBe(2);
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const testCase of cases) {
    it(testCase.name, () => {
      const plan = planWork(testCase.items, Date.parse(testCase.now), testCase.timeZone);

      expect(plan.order.map((item) => item.id)).toEqual(testCase.expect.order);
      for (const section of WORK_SECTIONS) {
        expect(plan.sections[section].map((item) => item.id), section)
          .toEqual(testCase.expect.sections[section]);
      }
      expect(plan.openCount).toBe(testCase.expect.open);
      expect(plan.lateCount).toBe(testCase.expect.late);
    });
  }

  it('sections partition the order, and sectionOf agrees', () => {
    for (const testCase of cases) {
      const plan = planWork(testCase.items, Date.parse(testCase.now), testCase.timeZone);
      const grouped = WORK_SECTIONS.flatMap((section) => plan.sections[section]);
      expect(grouped).toEqual(plan.order);
      for (const section of WORK_SECTIONS) {
        for (const item of plan.sections[section]) {
          expect(plan.sectionOf[item.id]).toBe(section);
        }
      }
    }
  });

  it('filters an existing plan without changing its section or order rules', () => {
    const plan = planWork([
      {
        id: 'late-task',
        origin: 'task',
        done: false,
        filed: true,
        dueDate: '2026-09-09T10:00:00.000Z',
        updatedAt: null,
        githubRef: null,
      },
      {
        id: 'today-task',
        origin: 'task',
        done: false,
        filed: true,
        dueDate: '2026-09-10T10:00:00.000Z',
        updatedAt: null,
        githubRef: null,
      },
    ], Date.parse('2026-09-10T12:00:00.000Z'), 'UTC');

    const filtered = filterWorkPlan(plan, (item) => item.id === 'today-task');
    expect(filtered.order.map((item) => item.id)).toEqual(['today-task']);
    expect(filtered.sections.today.map((item) => item.id)).toEqual(['today-task']);
    expect(filtered.sections.late).toEqual([]);
    expect(filtered.sectionOf).toEqual({ 'today-task': 'today' });
  });

  it('narrows Mine by its canonical due section and origin', () => {
    const plan = planWork([
      { id: 'late-task', origin: 'task', done: false, filed: true, dueDate: '2026-09-09T10:00:00.000Z', updatedAt: null, githubRef: null },
      { id: 'today-task', origin: 'task', done: false, filed: true, dueDate: '2026-09-10T10:00:00.000Z', updatedAt: null, githubRef: null },
      { id: 'today-issue', origin: 'issue', done: false, filed: true, dueDate: null, updatedAt: '2026-09-10T11:00:00.000Z', githubRef: null },
    ], Date.parse('2026-09-10T12:00:00.000Z'), 'UTC');

    const filtered = filterMinePlan(plan, { section: 'today', origin: 'task' });
    expect(filtered.order.map((item) => item.id)).toEqual(['today-task']);
    expect(filtered.sectionOf).toEqual({ 'today-task': 'today' });
  });
});

// MARK: - Stages (docs/BOARD.md)

interface StageCase {
  name: string;
  item: WorkStageShape & { id: string };
  expect: WorkStage;
}

interface WriteCase {
  name: string;
  item: WorkStageShape & { id: string };
  stage: WorkStage;
  expect: { status: string } | { state: string; state_reason?: string; labels: string[] };
}

interface BoardCase {
  name: string;
  now: string;
  timeZone: string;
  finishedSince: string | null;
  items: WorkCardShape[];
  expect: { columns: Record<WorkStage, string[]> };
}

interface HolderCase {
  name: string;
  item: WorkStageShape & { id: string };
  filter: string;
  agentEmail: string | null;
  expect: boolean;
}

const stages = fixture.stages as unknown as {
  vocabulary: string[];
  stageCases: StageCase[];
  writeCases: WriteCase[];
  boardCases: BoardCase[];
  holderCases: HolderCase[];
  taskFilterCases: Array<{ name: string; now: string; timeZone: string; item: WorkFilterShape; filter: WorkTaskFilter; expect: boolean }>;
};

describe('work-items fixture: stages', () => {
  it('names the columns this implementation draws, in order', () => {
    expect(stages.vocabulary).toEqual(WORK_STAGES);
  });

  for (const testCase of stages.stageCases) {
    it(`stage: ${testCase.name}`, () => {
      expect(stageOf(testCase.item)).toBe(testCase.expect);
    });
  }

  for (const testCase of stages.writeCases) {
    it(`write: ${testCase.name}`, () => {
      const write = writeStage(testCase.item, testCase.stage);
      const { kind, ...fields } = write;
      expect(kind).toBe(testCase.item.origin);
      expect(fields).toEqual(testCase.expect);
    });
  }

  for (const testCase of stages.holderCases) {
    it(`holder: ${testCase.name}`, () => {
      expect(passesHolderFilter(testCase.item, testCase.filter, testCase.agentEmail)).toBe(testCase.expect);
    });
  }

  for (const testCase of stages.taskFilterCases) {
    it(`task filter: ${testCase.name}`, () => {
      expect(passesTaskFilter(testCase.item, testCase.filter, Date.parse(testCase.now), testCase.timeZone)).toBe(testCase.expect);
    });
  }

  for (const testCase of stages.boardCases) {
    it(`board: ${testCase.name}`, () => {
      const since = testCase.finishedSince === null ? null : Date.parse(testCase.finishedSince);
      const board = planBoard(testCase.items, Date.parse(testCase.now), testCase.timeZone, since);
      for (const stage of WORK_STAGES) {
        expect(board.columns[stage].map((item) => item.id), stage).toEqual(testCase.expect.columns[stage]);
        for (const item of board.columns[stage]) {
          expect(board.stageOf[item.id]).toBe(stage);
        }
      }
    });
  }
});

interface UnownedCase {
  name: string;
  now: string;
  timeZone: string;
  items: WorkHeldCardShape[];
  expect: string[];
}

const unowned = fixture.unowned as unknown as { cases: UnownedCase[] };

describe('work-items fixture: unowned', () => {
  for (const testCase of unowned.cases) {
    it(testCase.name, () => {
      const rows = planUnowned(testCase.items, Date.parse(testCase.now), testCase.timeZone);
      expect(rows.map((item) => item.id)).toEqual(testCase.expect);
    });
  }
});

interface PhaseCase {
  name: string;
  eventDate: string | null;
  now: string;
  timeZone: string;
  expect: string;
  daysUntil: number | null;
}

const events = fixture.events as unknown as { vocabulary: string[]; phaseCases: PhaseCase[] };

describe('work-items fixture: events', () => {
  it('names the three phases', () => {
    expect(events.vocabulary).toEqual(['upcoming', 'live', 'past']);
  });

  for (const testCase of events.phaseCases) {
    it(`phase and countdown: ${testCase.name}`, () => {
      const now = Date.parse(testCase.now);
      expect(eventPhase(testCase.eventDate, now, testCase.timeZone)).toBe(testCase.expect);
      expect(eventDaysUntil(testCase.eventDate, now, testCase.timeZone)).toBe(testCase.daysUntil);
    });
  }
});

// MARK: - Focus (docs/WORK.md §1)

interface FocusCase {
  name: string;
  now: string;
  timeZone: string;
  items: WorkCardShape[];
  expect: { rows: string[]; next: boolean; lateCount: number; todayCount: number; mineFilter: string[] };
}

describe('work-items fixture: focus', () => {
  for (const testCase of (fixture as unknown as { focus: { cases: FocusCase[] } }).focus.cases) {
    it(testCase.name, () => {
      const now = Date.parse(testCase.now);
      const plan = planWork(testCase.items, now, testCase.timeZone);
      const focus = planFocus(plan, now, testCase.timeZone);
      expect(focus.rows.map((item) => item.id)).toEqual(testCase.expect.rows);
      expect(focus.next).toBe(testCase.expect.next);
      expect(focus.lateCount).toBe(testCase.expect.lateCount);
      expect(focus.todayCount).toBe(testCase.expect.todayCount);
      const filtered = filterMinePlan(plan, { section: 'focus', origin: 'all' }, now, testCase.timeZone);
      expect(filtered.order.map((item) => item.id)).toEqual(testCase.expect.mineFilter);
    });
  }
});
