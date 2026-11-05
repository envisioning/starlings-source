/**
 * What Home is made of and the order it is drawn in — one answer for Mac,
 * iOS and web. Pinned by `fixtures/home-layout.json`; the Swift port
 * (Sources/HomeLayout.swift) reads the same file.
 *
 * The person owns the order and which modules show; Quick Access is always
 * last but can be hidden. The Worker stores the list behind
 * `/api/home/preferences`; every client resolves what it reads
 * through `resolveHomeLayout`, so a module that ships tomorrow reaches a
 * layout stored today without a migration, and an id a newer build wrote is
 * ignored rather than drawn blank by an older one.
 */

/** Zod-free values and helpers used by the browser entry path. */
import { WORK_MODULES, type WorkModule } from './work-modules';
import { searchRowKey, type SearchRow } from './search-values';

export const HOME_MODULE_IDS = ['messages', 'work', 'commercial', 'notes', 'agenda', 'events', 'room', 'recent'] as const;
export type HomeModuleID = (typeof HOME_MODULE_IDS)[number];

export interface HomeModuleDefinition {
  id: HomeModuleID;
  /** Settings row title. The surface's own card header keeps its own spelling. */
  title: string;
  detail: string;
  enabledByDefault: boolean;
  /** Rows listed, and placeholder rows while waiting (fixture DENSITY). Null: not a capped list. */
  rows: number | null;
  /** False for the room: Start is the primary action on the native apps. */
  canHide: boolean;
  /**
   * SHOW in the fixture: true when the card draws with nothing to list (the
   * room, the notes capture, the agenda's calendar state). False when a card
   * with nothing to say draws nothing. Every surface asks `homeModuleDraws`.
   */
  showsEmpty: boolean;
}

/** The default order — the table in `fixtures/home-layout.json`, kept in step by its test. */
export const HOME_MODULES: readonly HomeModuleDefinition[] = [
  { id: 'messages', title: 'Inbox', detail: 'What is new: unread conversations, decisions, requests and invitations', enabledByDefault: true, rows: 3, canHide: true, showsEmpty: false },
  { id: 'work', title: 'Work', detail: 'Everything assigned to you', enabledByDefault: true, rows: 5, canHide: true, showsEmpty: false },
  { id: 'commercial', title: 'Commercial', detail: 'Offers, sales, pipeline, and new licenses', enabledByDefault: true, rows: null, canHide: true, showsEmpty: false },
  { id: 'notes', title: 'Quick Notes', detail: 'Capture now, file later', enabledByDefault: true, rows: null, canHide: true, showsEmpty: true },
  { id: 'agenda', title: 'Upcoming', detail: 'What is next, and the rest of today', enabledByDefault: true, rows: null, canHide: true, showsEmpty: true },
  { id: 'events', title: 'Events', detail: 'Upcoming events', enabledByDefault: true, rows: 3, canHide: true, showsEmpty: false },
  { id: 'room', title: 'Your room', detail: 'Start, join, and share the room', enabledByDefault: true, rows: null, canHide: false, showsEmpty: true },
  { id: 'recent', title: 'Quick access', detail: 'Starred and recently opened items', enabledByDefault: true, rows: null, canHide: true, showsEmpty: false },
];

/**
 * Home's one jump list: starred rows first, followed by this device's recent
 * rows. A row present in both sources appears once, keyed by kind and id.
 * Starred and recent source order is preserved within each group.
 */
export function mergeHomeRecentRows(recentRows: readonly SearchRow[], starredRows: readonly SearchRow[]): SearchRow[] {
  const rows: SearchRow[] = [];
  const seen = new Set<string>();
  for (const row of [...starredRows, ...recentRows]) {
    const key = searchRowKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  return rows;
}

/**
 * The Inbox card's order (`messages`): what waits on your answer first —
 * invitations, decisions and questions, in the order given (INBOX sends
 * invitations first, the soonest event first) — then everything else that
 * is new, newest first. Ties keep the order given. `HomeLayout.orderInbox` in
 * Sources/HomeLayout.swift; pinned by `inboxOrderCases`.
 */
export function orderHomeInbox<T>(rows: readonly T[], pinned: (row: T) => boolean, at: (row: T) => number): T[] {
  const indexed = rows.map((row, index) => ({ row, index }));
  const first = indexed.filter(({ row }) => pinned(row));
  const rest = indexed.filter(({ row }) => !pinned(row)).sort((a, b) => at(b.row) - at(a.row) || a.index - b.index);
  return [...first, ...rest].map(({ row }) => row);
}

export function homeModule(id: HomeModuleID): HomeModuleDefinition {
  const found = HOME_MODULES.find((module) => module.id === id);
  if (!found) throw new Error(`home-layout: no module ${id}`);
  return found;
}

/**
 * `HomeLayout.packColumns` in Sources/HomeLayout.swift: which of two columns
 * each module goes to (true = right). Tallest first to the shorter column,
 * ties in the person's order; a module with no height yet goes to whichever
 * column is shorter at the end. The order inside a column is the caller's.
 * Its result is never `homeColumnsLopsided`.
 */
export function packHomeColumns(
  modules: readonly HomeModuleID[],
  heights: Partial<Record<HomeModuleID, number>>,
  gap: number,
): Partial<Record<HomeModuleID, boolean>> {
  let left = 0;
  let right = 0;
  const assignment: Partial<Record<HomeModuleID, boolean>> = {};
  const height = (id: HomeModuleID) => heights[id] ?? 0;
  const byHeight = modules
    .map((id, index) => ({ id, index }))
    .filter(({ id }) => height(id) > 0)
    .sort((a, b) => height(b.id) - height(a.id) || a.index - b.index);
  for (const { id } of byHeight) {
    const goesRight = right < left;
    assignment[id] = goesRight;
    if (goesRight) right += height(id) + gap;
    else left += height(id) + gap;
  }
  for (const id of modules) {
    if (assignment[id] === undefined) assignment[id] = right < left;
  }
  return assignment;
}

/**
 * `HomeLayout.columnsLopsided` in Sources/HomeLayout.swift: a placement that
 * a surface must pack again. True when a card in the taller column, plus the
 * gap, is at most half the difference between the columns, or when a
 * measured card has no column. A card with no height does not count.
 */
export function homeColumnsLopsided(
  modules: readonly HomeModuleID[],
  heights: Partial<Record<HomeModuleID, number>>,
  assignment: Partial<Record<HomeModuleID, boolean>>,
  gap: number,
): boolean {
  let left = 0;
  let right = 0;
  const leftCards: number[] = [];
  const rightCards: number[] = [];
  for (const id of modules) {
    const height = heights[id] ?? 0;
    if (height <= 0) continue;
    const goesRight = assignment[id];
    if (goesRight === undefined) return true;
    if (goesRight) {
      right += height + gap;
      rightCards.push(height);
    } else {
      left += height + gap;
      leftCards.push(height);
    }
  }
  const difference = Math.abs(left - right);
  const taller = left >= right ? leftCards : rightCards;
  return taller.some((height) => 2 * (height + gap) <= difference);
}

/**
 * SHOW in `fixtures/home-layout.json`: whether a visible module draws, given
 * whether it has anything to list. `HomeLayout.draws` in
 * Sources/HomeLayout.swift; pinned by `showCases`.
 */
export function homeModuleDraws(id: HomeModuleID, hasContent: boolean): boolean {
  return hasContent || homeModule(id).showsEmpty;
}

/** The one count for a list module: its cap and its skeleton. */
export function homeModuleRows(id: HomeModuleID): number {
  const rows = homeModule(id).rows;
  if (rows === null) throw new Error(`home-layout: ${id} is not a capped list`);
  return rows;
}

/** One row of the stored list, and of the resolved one. */
export interface HomeModuleSetting {
  id: HomeModuleID;
  enabled: boolean;
}

export function isHomeModuleID(value: string): value is HomeModuleID {
  return (HOME_MODULE_IDS as readonly string[]).includes(value);
}

export const DEFAULT_HOME_LAYOUT: readonly HomeModuleSetting[] = HOME_MODULES.map((module) => ({
  id: module.id,
  enabled: module.enabledByDefault,
}));

/**
 * RESOLVE in `fixtures/home-layout.json`: stored order wins for the ids it
 * names, unknown ids and later duplicates go, missing modules slot in after
 * their nearest present default predecessor (walking the missing ones in
 * default order), and a module that cannot hide is enabled regardless.
 */
export function resolveHomeLayout(
  stored: ReadonlyArray<{ id: string; enabled: boolean }> | null | undefined,
): HomeModuleSetting[] {
  const result: HomeModuleSetting[] = [];
  const seen = new Set<HomeModuleID>();
  const firstStoredID = new Map<HomeModuleID, string>();
  for (const row of stored ?? []) {
    // `starred` was a separate Home module through 5.5.4. Keep its visibility
    // when old device or server preferences arrive. `invitations` was one
    // until 2026-10-06 and is now INBOX rows: it drops as an unknown id.
    const id: HomeModuleID | undefined = row.id === 'starred'
      ? 'recent'
      : isHomeModuleID(row.id) ? row.id : undefined;
    if (!id) continue;
    if (seen.has(id)) {
      // The two old modules now name one list. Keep it visible when either
      // old module was enabled.
      if (id === 'recent' && firstStoredID.get(id) !== row.id) {
        const previous = result.find((entry) => entry.id === id)!;
        previous.enabled ||= row.enabled;
      }
      continue;
    }
    seen.add(id);
    firstStoredID.set(id, row.id);
    result.push({ id, enabled: homeModule(id).canHide ? row.enabled : true });
  }
  HOME_MODULES.forEach((module, index) => {
    if (seen.has(module.id)) return;
    seen.add(module.id);
    const setting = { id: module.id, enabled: module.enabledByDefault };
    let at = 0;
    for (let back = index - 1; back >= 0; back -= 1) {
      const predecessor = result.findIndex((row) => row.id === HOME_MODULES[back]!.id);
      if (predecessor >= 0) {
        at = predecessor + 1;
        break;
      }
    }
    result.splice(at, 0, setting);
  });
  // Quick Access spans the Home grid, so it always sits below the columns.
  const recentIndex = result.findIndex((row) => row.id === 'recent');
  if (recentIndex >= 0 && recentIndex !== result.length - 1) {
    result.push(result.splice(recentIndex, 1)[0]!);
  }
  return result;
}

/**
 * The work modules a Home module needs, any one of them (docs/WORK_MODEL.md):
 * Events needs Events, Commercial one of Envisioning's commercial work
 * modules. A module not named here needs none.
 */
export const HOME_MODULE_WORK_MODULES: Readonly<Partial<Record<HomeModuleID, readonly WorkModule[]>>> = {
  events: ['events'],
  commercial: ['offers', 'licenses'],
};

/** The modules a surface draws, in order: on in the layout, and their work modules on in the workspace. */
export function visibleHomeModules(layout: readonly HomeModuleSetting[], workModules: readonly WorkModule[] = WORK_MODULES): HomeModuleID[] {
  return offeredHomeModules(layout, workModules)
    .filter((row) => row.enabled)
    .map((row) => row.id);
}

/** Settings offers every ungated row, including one the person disabled. */
export function offeredHomeModules(layout: readonly HomeModuleSetting[], workModules: readonly WorkModule[] = WORK_MODULES): HomeModuleSetting[] {
  return layout.filter((row) => HOME_MODULE_WORK_MODULES[row.id]?.some((module) => workModules.includes(module)) ?? true);
}

export function homeLayoutEquals(a: readonly HomeModuleSetting[], b: readonly HomeModuleSetting[]): boolean {
  return a.length === b.length && a.every((row, index) => row.id === b[index]!.id && row.enabled === b[index]!.enabled);
}

/** Move one module up or down one place; a move off either end is a no-op. */
export function moveHomeModule(
  layout: readonly HomeModuleSetting[],
  id: HomeModuleID,
  direction: 'up' | 'down',
  workModules: readonly WorkModule[] = WORK_MODULES,
): HomeModuleSetting[] {
  const offered = offeredHomeModules(layout, workModules);
  const at = offered.findIndex((row) => row.id === id);
  const target = offered[direction === 'up' ? at - 1 : at + 1];
  if (at < 0 || id === 'recent' || !target || target.id === 'recent') return [...layout];
  const from = layout.findIndex((row) => row.id === id);
  const to = layout.findIndex((row) => row.id === target.id);
  const next = [...layout];
  // Only offered positions change: turning a work module back on restores its saved row.
  [next[from], next[to]] = [next[to]!, next[from]!];
  return next;
}
