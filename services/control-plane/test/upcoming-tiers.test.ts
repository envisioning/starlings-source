import { describe, expect, it } from 'vitest';
import {
  canJoin,
  classifyUpcoming,
  closedDaySummary,
  UPCOMING_CONFIG,
  UPCOMING_REQUEST_HOURS,
  upcomingRequestHours,
  UPCOMING_TIERS,
  type UpcomingEventShape,
  type UpcomingTier,
} from '@starlings/contracts/upcoming';
import fixture from '../../../fixtures/upcoming-tiers.json';

/**
 * The shared table, run against the TypeScript implementation. The Swift port
 * runs the same file (Tests/UpcomingTierFixtureTests.swift), which is the whole
 * point: three surfaces drifted apart because nothing could tell that they had.
 *
 * A failure here is a question about `fixtures/upcoming-tiers.json` first — the
 * rules live there, and both implementations answer to it.
 */

interface FixtureEvent extends UpcomingEventShape {
  joinable: boolean;
}

interface FixtureCase {
  name: string;
  now: string;
  timeZone: string;
  events: FixtureEvent[];
  expect: {
    agenda: string[];
    tiers: Record<string, UpcomingTier>;
    focus: string | null;
    counts: Record<string, number>;
    canJoin?: Record<string, boolean>;
  };
}

const cases = fixture.cases as unknown as FixtureCase[];

describe('upcoming-tiers fixture', () => {
  it('is the version this implementation was written against', () => {
    expect(fixture.version).toBe(1);
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const testCase of cases) {
    it(testCase.name, () => {
      const plan = classifyUpcoming(testCase.events, {
        now: Date.parse(testCase.now),
        timeZone: testCase.timeZone,
      });

      expect(plan.agenda.map((event) => event.id)).toEqual(testCase.expect.agenda);
      expect(plan.tiers).toEqual(testCase.expect.tiers);
      expect(plan.focus?.id ?? null).toBe(testCase.expect.focus);

      const counts: Record<string, number> = { agenda: plan.agenda.length };
      for (const tier of UPCOMING_TIERS) counts[tier] = plan.tiered[tier].length;
      expect(counts).toEqual(testCase.expect.counts);

      for (const [id, expected] of Object.entries(testCase.expect.canJoin ?? {})) {
        const event = testCase.events.find((candidate) => candidate.id === id);
        expect(event, `${id} — ${testCase.name}`).toBeDefined();
        // `canJoin` wants a scheduled event; an unscheduled fixture row asks
        // the question with empty stamps and gets `false`, as the app would.
        const stamps = { start: event!.start ?? '', end: event!.end ?? '' };
        expect(canJoin(stamps, Date.parse(testCase.now)), `canJoin ${id} — ${testCase.name}`).toBe(expected);
      }
    });
  }
});

describe('upcoming config', () => {
  it('derives every client-facing feed constant from the shared config', () => {
    expect(UPCOMING_CONFIG.version).toBe(1);
    expect(UPCOMING_CONFIG.sectionTitle).toBe('UPCOMING');
    expect(UPCOMING_CONFIG.horizonDays).toBe(2);
    expect(UPCOMING_REQUEST_HOURS).toBe(
      (UPCOMING_CONFIG.horizonDays + UPCOMING_CONFIG.requestSlackDays) * 24,
    );
    expect(UPCOMING_CONFIG.homeFollowingRows).toBe(2);
    expect(UPCOMING_CONFIG.joinWindowMinutes).toBe(10);
    expect(UPCOMING_CONFIG.showTomorrow).toBe(true);
  });
});

describe('classifyUpcoming', () => {
  /*
   * The rules the table cannot state, because they are about the shape of the
   * answer rather than about any one day.
   */
  it('never puts an event in two tiers', () => {
    for (const testCase of cases) {
      const plan = classifyUpcoming(testCase.events, {
        now: Date.parse(testCase.now),
        timeZone: testCase.timeZone,
      });
      const grouped = UPCOMING_TIERS.flatMap((tier) => plan.tiered[tier].map((event) => event.id));
      expect(grouped.slice().sort()).toEqual(plan.agenda.map((event) => event.id).slice().sort());
      expect(new Set(grouped).size).toBe(grouped.length);
    }
  });

  it('only ever focuses something on the agenda, and only today', () => {
    for (const testCase of cases) {
      const plan = classifyUpcoming(testCase.events, {
        now: Date.parse(testCase.now),
        timeZone: testCase.timeZone,
      });
      if (!plan.focus) continue;
      expect(plan.agenda).toContain(plan.focus);
      expect(['now', 'today']).toContain(plan.tiers[plan.focus.id]);
      expect(plan.focus.demoted).toBe(false);
      expect(plan.focus.allDay).toBe(false);
    }
  });

  it('defaults to the host zone and to now', () => {
    // Not a claim about which zone, only that omitting both is legal and that
    // an obviously-live meeting still lands in the hero.
    const start = new Date(Date.now() - 5 * 60_000).toISOString();
    const end = new Date(Date.now() + 25 * 60_000).toISOString();
    const plan = classifyUpcoming([
      { id: 'live', title: 'Roadmap', start, end, allDay: false, demoted: false },
    ]);
    expect(plan.focus?.id).toBe('live');
    expect(plan.tiers.live).toBe('now');
  });

  it('does not surface meetings farther ahead in the closed-day summary', () => {
    const now = Date.parse('2026-08-19T19:00:00Z');
    const plan = classifyUpcoming([
      {
        id: 'next-week',
        title: 'Planning',
        start: '2026-08-25T09:00:00Z',
        end: '2026-08-25T10:00:00Z',
        allDay: false,
        demoted: false,
      },
    ], { now, timeZone: 'UTC' });

    expect(plan.tiered.ahead).toHaveLength(0);
    expect(closedDaySummary(plan)).toEqual({ kind: 'empty' });
  });

  it('uses one compact Home projection for the hero, tomorrow, and row density', () => {
    const inProgress = cases.find((testCase) => testCase.name === 'an in-progress meeting holds the hero');
    expect(inProgress).toBeDefined();
    const inProgressPlan = classifyUpcoming(inProgress!.events, {
      now: Date.parse(inProgress!.now),
      timeZone: inProgress!.timeZone,
    });
    expect(inProgressPlan.focus?.id).toBe('review');
    expect(inProgressPlan.homeRows.map((event) => event.id)).toEqual(['sam']);
    expect(inProgressPlan.homeRows).toHaveLength(1);

    const closed = cases.find((testCase) => testCase.name === "a closed day: tomorrow's first meeting never takes the hero");
    expect(closed).toBeDefined();
    const closedPlan = classifyUpcoming(closed!.events, {
      now: Date.parse(closed!.now),
      timeZone: closed!.timeZone,
    });
    expect(closedPlan.focus).toBeUndefined();
    expect(closedPlan.homeRows.map((event) => event.id)).toEqual(['standup', 'board']);

    const crowded = cases.find((testCase) => testCase.name === 'the compact card points to the rest of day before farther dates');
    expect(crowded).toBeDefined();
    const crowdedPlan = classifyUpcoming(crowded!.events, {
      now: Date.parse(crowded!.now),
      timeZone: crowded!.timeZone,
    });
    expect(crowdedPlan.homeRows.map((event) => event.id)).toEqual(['today-2', 'today-3']);
    expect(crowdedPlan.remainingTodayCount).toBe(1);
    expect(crowdedPlan.remainingToday.map((event) => event.id)).toEqual(['today-4']);
  });

  it('applies the owner display policy to the shared agenda and Home rows', () => {
    const now = Date.parse('2026-08-19T19:00:00Z');
    const plan = classifyUpcoming([
      {
        id: 'tomorrow', title: 'Standup', start: '2026-08-20T09:00:00Z', end: '2026-08-20T09:30:00Z',
        allDay: false, demoted: false,
      },
      {
        id: 'later', title: 'Planning', start: '2026-08-25T09:00:00Z', end: '2026-08-25T10:00:00Z',
        allDay: false, demoted: false,
      },
    ], {
      now,
      timeZone: 'UTC',
      preferences: { horizonDays: 3, homeFollowingRows: 0, showTomorrow: false },
    });
    expect(plan.agenda.map((event) => event.id)).toEqual(['tomorrow']);
    expect(plan.homeRows).toEqual([]);
    expect(closedDaySummary(plan)).toEqual({ kind: 'tomorrow', count: 1, time: '09:00' });
    expect(plan.preferences.horizonDays).toBe(2);
    expect(plan.preferences.showTomorrow).toBe(true);
    expect(upcomingRequestHours(plan.preferences)).toBe(3 * 24);
  });

  it("counts only the member's events in the closed-day summary", () => {
    const flights = cases.find((testCase) => testCase.name.startsWith('only events the member is part of'));
    expect(flights).toBeDefined();
    const plan = classifyUpcoming(flights!.events, {
      now: Date.parse(flights!.now),
      timeZone: flights!.timeZone,
    });
    expect(closedDaySummary(plan)).toEqual({ kind: 'tomorrow', count: 1, time: '09:00' });
  });

  it('collapses a cross-calendar copy while preserving same-calendar copies', () => {
    const events = [
      {
        id: 'primary-status',
        calendarId: 'primary',
        title: 'Status',
        start: '2026-08-19T15:00:00Z',
        end: '2026-08-19T15:30:00Z',
        allDay: false,
        demoted: false,
      },
      {
        id: 'secondary-status',
        calendarId: 'acct:secondary:primary',
        title: ' status ',
        start: '2026-08-19T15:00:00Z',
        end: '2026-08-19T15:30:00Z',
        allDay: false,
        demoted: false,
      },
      {
        id: 'primary-status-copy',
        calendarId: 'primary',
        title: 'Status',
        start: '2026-08-19T15:00:00Z',
        end: '2026-08-19T15:30:00Z',
        allDay: false,
        demoted: false,
      },
    ];

    const plan = classifyUpcoming(events, {
      now: Date.parse('2026-08-19T09:00:00Z'),
      timeZone: 'UTC',
    });
    expect(plan.agenda.map((event) => event.id)).toEqual(['primary-status', 'primary-status-copy']);
  });
});
