// Guarded localStorage: Safari's "Block all cookies" and some embedded
// webviews make every localStorage touch throw SecurityError, which used to
// take down the whole join screen from a useState initializer. Failures fall
// back to per-session memory.
const memory = new Map<string, string>();

export const StorageKeys = {
  name: 'meet-name',
  email: 'meet-email',
  title: 'meet-title',
  organization: 'meet-organization',
  media: 'meet-media',
  transcriptPanel: 'meet-transcript-panel',
  selfViewSize: 'meet-self-view-size',
  /** Screen-share camera layout choice on this browser. */
  screenShareLayout: 'meet-screen-share-layout',
  /** '1' while your own camera tile sits in the grid with everyone instead of floating over the stage. */
  selfViewDocked: 'meet-self-view-docked',
  /** Prefix: `meet-rail-fold.<surface>.<block>` is '1' while that rail block is folded shut (SurfaceShell). */
  railFold: 'meet-rail-fold.',
  /** Prefix: `meet-right-sidebar.<surface>` is '1' while a surface's right sidebar is open. */
  rightSidebar: 'meet-right-sidebar.',
  /** '1' while Docs shows the document alone, the rail and the list put away. */
  docsFocus: 'meet-docs-focus',
  /** The last Home layout this browser read — a cache of the owner-synced value, for the first paint. */
  homeLayout: 'meet-home-layout',
  /** '1' or '0': whether the member had a calendar source when this browser last asked — the first frame's nav (calendar-sources.ts). */
  calendarSources: 'meet-calendar-sources',
  /** The last language choice this browser read — a cache of the owner-synced value. */
  language: 'meet-language',
  /** The last `?lang=` a guest opened this browser with ( step 7). */
  guestLanguage: 'meet-guest-language',
  /** The last hits opened from ⌘K, newest first, as rows — this device's only. */
  searchRecents: 'meet-search-recents',
  /** The calendar new events go on, from the last event made here. This browser only (the native clients keep their own). */
  calendarWriteTarget: 'meet-calendar-write-target',
  /** '1' while hidden ("Hide from Next") events are drawn faded on the calendar; off by default. This browser only. */
  calendarShowHidden: 'meet-calendar-show-hidden',
  /** The last contextual MINE filter on this browser. */
  workMineFilter: 'meet-work-mine-filter',
  /** '1' while an organization's Tasks pane groups By project. This browser only. */
  workOrganizationByProject: 'meet-work-organization-by-project',
  /** UNOWNED's type filter on this browser: `all`, `task` or `issue`. */
  workUnownedFilter: 'meet-work-unowned-filter',
  /** UNOWNED's hidden subjects on this browser, as `kind:id` keys (JSON array). */
  workUnownedHiddenSubjects: 'meet-work-unowned-hidden-subjects',
  /** Browse's Leads group, narrowed to a product. This browser only. */
  workLeadSource: 'meet-work-lead-source',
  /** The last contextual INBOX filter on this browser. */
  workInboxFilter: 'meet-work-inbox-filter',
  /** '1' while this browser was last signed in as a member: the first frame's header guess (owner-session.ts). */
  memberHint: 'meet-member-hint',
  /** The last owner session answer (who, and which room): the first frame's head start (owner-session.ts). */
  ownerSession: 'meet-owner-session',
  /** Prefix: `meet-setup-done.<sub>` is '1' once Home said "You're set up" to that person on this browser. */
  setupDone: 'meet-setup-done.',
} as const;

export function readStored(key: string): string {
  try {
    return localStorage.getItem(key) ?? memory.get(key) ?? '';
  } catch {
    return memory.get(key) ?? '';
  }
}

export function removeStored(key: string): void {
  memory.delete(key);
  try {
    localStorage.removeItem(key);
  } catch {
    // Storage blocked; memory was the only tier and it is clear.
  }
}

/** Every key under `prefix`, in both tiers — a purge, not a single forget. */
export function removeStoredWithPrefix(prefix: string): void {
  for (const key of [...memory.keys()]) {
    if (key.startsWith(prefix)) memory.delete(key);
  }
  try {
    const doomed: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(prefix)) doomed.push(key);
    }
    for (const key of doomed) localStorage.removeItem(key);
  } catch {
    // Storage blocked; memory was the only tier and it is clear.
  }
}

export function writeStored(key: string, value: string): void {
  memory.set(key, value);
  try {
    localStorage.setItem(key, value);
  } catch {
    // Memory fallback already holds it for this session.
  }
}
