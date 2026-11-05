/**
 * Automatic ranking for the Work subject rail.
 *
 * This is intentionally a small, explainable ranker rather than a user
 * selectable sort. The full subject directory still lives behind Browse;
 * this answer is only about what deserves to float in the limited rail.
 */

export type WorkRankReasonCode =
  | 'starred'
  | 'direct_attention'
  | 'unread'
  | 'overdue'
  | 'event_today'
  | 'event_soon'
  | 'open_work'
  | 'recent_activity'
  | 'stale_work';

export interface WorkRankSubjectShape {
  id: string;
  title: string;
  kind: 'lead' | 'project' | 'organization' | 'event';
  open_tasks?: number | null;
  overdue_tasks?: number | null;
  last_activity_at?: string | null;
  event_date?: string | null;
}

export interface WorkRankSignals {
  starred?: boolean;
  direct_attention?: boolean;
  unread?: boolean;
}

export interface WorkRankCriteria {
  railLimit: number;
  starred: number;
  directAttention: number;
  unread: number;
  overduePerTask: number;
  overdueCap: number;
  eventToday: number;
  eventSoonBase: number;
  eventSoonDecayPerDay: number;
  eventHorizonDays: number;
  openWorkPerTask: number;
  openWorkCap: number;
  recentActivityMax: number;
  activityHalfLifeMs: number;
  staleAfterMs: number;
  staleWork: number;
}

/** Criteria are data so the policy can grow without scattering conditionals. */
export const DEFAULT_WORK_RANK_CRITERIA: WorkRankCriteria = {
  railLimit: 12,
  starred: 1_000,
  directAttention: 500,
  unread: 150,
  overduePerTask: 90,
  overdueCap: 3,
  eventToday: 120,
  eventSoonBase: 90,
  eventSoonDecayPerDay: 10,
  eventHorizonDays: 14,
  openWorkPerTask: 18,
  openWorkCap: 5,
  recentActivityMax: 80,
  activityHalfLifeMs: 3 * 24 * 60 * 60 * 1_000,
  staleAfterMs: 7 * 24 * 60 * 60 * 1_000,
  staleWork: 24,
};

export interface WorkRankReason { code: WorkRankReasonCode; points: number }
export interface RankedWorkSubject<T> { item: T; score: number; reasons: WorkRankReason[] }

const DAY_MS = 86_400_000;

function parseMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function eventDayMs(value: string | null | undefined): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/u.exec(value ?? '');
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function addReason(reasons: WorkRankReason[], code: WorkRankReasonCode, points: number): number {
  if (points <= 0) return 0;
  reasons.push({ code, points });
  return points;
}

function rankOne<T extends WorkRankSubjectShape>(item: T, signals: WorkRankSignals, nowMs: number, criteria: WorkRankCriteria): RankedWorkSubject<T> {
  const reasons: WorkRankReason[] = [];
  let score = 0;
  if (signals.starred) score += addReason(reasons, 'starred', criteria.starred);
  if (signals.direct_attention) score += addReason(reasons, 'direct_attention', criteria.directAttention);
  if (signals.unread) score += addReason(reasons, 'unread', criteria.unread);

  const overdue = Math.min(Math.max(0, item.overdue_tasks ?? 0), criteria.overdueCap);
  score += addReason(reasons, 'overdue', overdue * criteria.overduePerTask);

  const eventMs = item.kind === 'event' ? eventDayMs(item.event_date) : null;
  if (eventMs !== null) {
    const daysUntil = Math.floor(eventMs / DAY_MS) - Math.floor(nowMs / DAY_MS);
    if (daysUntil === 0) score += addReason(reasons, 'event_today', criteria.eventToday);
    else if (daysUntil > 0 && daysUntil <= criteria.eventHorizonDays) {
      score += addReason(reasons, 'event_soon', Math.max(0, criteria.eventSoonBase - (daysUntil - 1) * criteria.eventSoonDecayPerDay));
    }
  }

  const openTasks = Math.min(Math.max(0, item.open_tasks ?? 0), criteria.openWorkCap);
  score += addReason(reasons, 'open_work', openTasks * criteria.openWorkPerTask);
  const activityMs = parseMs(item.last_activity_at);
  if (activityMs !== null) {
    const age = Math.max(0, nowMs - activityMs);
    score += addReason(reasons, 'recent_activity', criteria.recentActivityMax * Math.pow(0.5, age / criteria.activityHalfLifeMs));
    if (openTasks > 0 && age >= criteria.staleAfterMs) score += addReason(reasons, 'stale_work', criteria.staleWork);
  }
  return { item, score, reasons };
}

export function rankWorkSubjects<T extends WorkRankSubjectShape>(subjects: readonly T[], signalsFor: (subject: T) => WorkRankSignals = () => ({}), nowMs = Date.now(), criteria: WorkRankCriteria = DEFAULT_WORK_RANK_CRITERIA): RankedWorkSubject<T>[] {
  return subjects.map((subject) => rankOne(subject, signalsFor(subject), nowMs, criteria)).sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const activityA = parseMs(a.item.last_activity_at) ?? 0;
    const activityB = parseMs(b.item.last_activity_at) ?? 0;
    if (activityA !== activityB) return activityB - activityA;
    const title = a.item.title.localeCompare(b.item.title);
    return title !== 0 ? title : a.item.id.localeCompare(b.item.id);
  });
}

/** `hold` keeps the open subject where it was drawn (`holdWorkRankPlace`). */
export function workRankRail<T extends WorkRankSubjectShape>(subjects: readonly T[], signalsFor: (subject: T) => WorkRankSignals = () => ({}), nowMs = Date.now(), criteria: WorkRankCriteria = DEFAULT_WORK_RANK_CRITERIA, hold?: { id: string | null | undefined; previous: readonly string[] }): RankedWorkSubject<T>[] {
  const ranked = rankWorkSubjects(subjects, signalsFor, nowMs, criteria);
  const held = hold ? holdWorkRankPlace(ranked, (row) => row.item.id, hold.id, hold.previous) : ranked;
  return held.slice(0, Math.max(0, criteria.railLimit));
}

/**
 * The open subject holds its place. Opening a subject reads it, and reading
 * clears its unread signal: ranked as-is, the row would slide away from the
 * click that picked it. The held id keeps the index it had in `previous`, the
 * last order drawn; every other row ranks as usual around it. Apply this to
 * the full ranking, before the rail's limit, so a held row is never cut.
 */
export function holdWorkRankPlace<T>(ranked: readonly T[], idOf: (row: T) => string, heldID: string | null | undefined, previous: readonly string[]): T[] {
  const rows = [...ranked];
  if (!heldID) return rows;
  const from = rows.findIndex((row) => idOf(row) === heldID);
  const was = previous.indexOf(heldID);
  if (from < 0 || was < 0 || from === was) return rows;
  const [held] = rows.splice(from, 1) as [T];
  rows.splice(Math.min(was, rows.length), 0, held);
  return rows;
}
