/**
 * Zod-free subject and work-list rules used by browser clients on the guest
 * entry path. Wire schemas and inferred response types remain in
 * `subject-state.ts`.
 */
import type {
  ResolvedSubjectState,
  SubjectGroup,
  SubjectGroupShape,
  SubjectStateOverride,
  SubjectStatePrefs,
  WorkListGroup,
  WorkListPreferences,
  WorkListRowShape,
  WorkListSort,
} from './subject-state';

export const SUBJECT_GROUPS = ['envisioning', 'clients', 'partners', 'events', 'sales'] as const;

/**
 * Which group a subject belongs to. One rule, in one place: the same test
 * `isEnvisioningProject` runs on every client — Core's flag when present, the
 * "Envisioning " title prefix only when it is not.
 */
export function subjectGroup(subject: SubjectGroupShape, projectGroupName = 'Envisioning'): SubjectGroup {
  switch (subject.kind) {
    case 'organization': return 'partners';
    case 'event': return 'events';
    case 'lead': return 'sales';
    case 'project': {
      const internal = typeof subject.internal === 'boolean'
        ? subject.internal
        : subject.title.startsWith(`${projectGroupName} `);
      return internal ? 'envisioning' : 'clients';
    }
  }
}

export function resolveSubjectState(
  subject: SubjectGroupShape,
  prefs: SubjectStatePrefs,
  override: SubjectStateOverride | null | undefined,
): ResolvedSubjectState {
  const muted = override?.muted === true;
  const kindHidden = prefs.hidden_kinds
    ? prefs.hidden_kinds.includes(subject.kind)
    : subject.kind === 'lead' && !prefs.sales_enabled;
  return {
    listed: !muted && !kindHidden,
    starred: override?.starred === true,
    muted,
  };
}

export function isDefaultOverride(override: SubjectStateOverride): boolean {
  return !override.starred && !override.muted;
}

export const WORK_LIST_SORTS = ['activity', 'upcoming', 'busiest', 'alphabetical'] as const;
export const WORK_LIST_GROUPS = ['none', 'relationship'] as const;

export const DEFAULT_WORK_LIST: WorkListPreferences = {
  sort: 'activity',
  group: 'none',
  starred_only: false,
};

export const WORK_LIST_SORT_TITLES: Record<WorkListSort, string> = {
  activity: 'Last activity',
  upcoming: 'Upcoming first',
  busiest: 'Busiest first',
  alphabetical: 'Alphabetical',
};

export const WORK_LIST_GROUP_TITLES: Record<WorkListGroup, string> = {
  none: 'None',
  relationship: 'Relationship',
};

/** How far ahead an event starts to float. */
export const EVENT_FLOAT_HORIZON_DAYS = 30;
const DAY_MS = 86_400_000;

function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** A plain `YYYY-MM-DD` as UTC midnight, with no zone to apply. */
function eventDateMs(date: string | null | undefined): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/u.exec(date ?? '');
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

export function eventFloatMs(row: Pick<WorkListRowShape, 'kind' | 'event_date'>, nowMs: number): number | null {
  if (row.kind !== 'event') return null;
  const date = eventDateMs(row.event_date);
  if (date === null) return null;
  const daysUntil = Math.floor(date / DAY_MS) - Math.floor(nowMs / DAY_MS);
  if (daysUntil < 0 || daysUntil > EVENT_FLOAT_HORIZON_DAYS) return null;
  return nowMs - daysUntil * DAY_MS;
}

export function activityKeyMs(row: WorkListRowShape, nowMs: number): number | null {
  const moved = parseMs(row.last_activity_at);
  const floated = eventFloatMs(row, nowMs);
  if (moved === null) return floated;
  if (floated === null) return moved;
  return Math.max(moved, floated);
}

function byBusiest(a: WorkListRowShape, b: WorkListRowShape): number {
  const overdue = (b.overdue_tasks ?? 0) - (a.overdue_tasks ?? 0);
  if (overdue !== 0) return overdue;
  const open = (b.open_tasks ?? 0) - (a.open_tasks ?? 0);
  if (open !== 0) return open;
  return a.title.localeCompare(b.title);
}

export function sortByWorkList<T extends WorkListRowShape>(rows: T[], sort: WorkListSort, nowMs: number): T[] {
  const busiest = [...rows].sort(byBusiest);
  if (sort === 'alphabetical') return [...rows].sort((a, b) => a.title.localeCompare(b.title));
  if (sort === 'busiest') return busiest;
  const byActivity = (list: T[]): T[] => {
    const keyed = list.map((row) => ({ row, key: activityKeyMs(row, nowMs) }));
    const dated = keyed.filter((entry) => entry.key !== null).sort((a, b) => (b.key ?? 0) - (a.key ?? 0));
    const undated = keyed.filter((entry) => entry.key === null);
    return [...dated, ...undated].map((entry) => entry.row);
  };
  if (sort === 'activity') return byActivity(busiest);
  const today = Math.floor(nowMs / DAY_MS);
  const isUpcoming = (row: T) => {
    const date = row.kind === 'event' ? eventDateMs(row.event_date) : null;
    return date !== null && Math.floor(date / DAY_MS) >= today;
  };
  const events = busiest.filter(isUpcoming).sort((a, b) => {
    const diff = (eventDateMs(a.event_date) ?? 0) - (eventDateMs(b.event_date) ?? 0);
    return diff !== 0 ? diff : a.title.localeCompare(b.title);
  });
  return [...events, ...byActivity(busiest.filter((row) => !isUpcoming(row)))];
}

export function resolveWorkList(stored: unknown): WorkListPreferences {
  const row = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;
  const sort = (WORK_LIST_SORTS as readonly string[]).includes(row.sort as string)
    ? (row.sort as WorkListSort) : DEFAULT_WORK_LIST.sort;
  const group = (WORK_LIST_GROUPS as readonly string[]).includes(row.group as string)
    ? (row.group as WorkListGroup) : DEFAULT_WORK_LIST.group;
  const starredOnly = typeof row.starred_only === 'boolean' ? row.starred_only : DEFAULT_WORK_LIST.starred_only;
  return { sort, group, starred_only: starredOnly };
}

export function isDefaultWorkList(prefs: WorkListPreferences): boolean {
  return prefs.sort === DEFAULT_WORK_LIST.sort
    && prefs.group === DEFAULT_WORK_LIST.group
    && prefs.starred_only === DEFAULT_WORK_LIST.starred_only;
}
