/**
 * The pages of Settings, their groups and order, and which client shows each,
 * decided once.
 *
 * The native apps kept this as a Swift registry (`StarlingsSettingsRegistry`). The
 * web drew its cards by hand in an order of its own (Calendar before Home, Work
 * after it), and nothing tied the two together. This table is that decision,
 * in the native order. It is rule input, not a wire shape: Swift's registry
 * takes its pages, groups, order and surfaces from the table generated out of
 * this module (`Sources/Generated/SettingsPagesRegistry.swift`), and
 * `fixtures/settings-pages.json` is generated from it too.
 *
 * The groups are the headings every client draws the list under: the Mac's
 * sidebar, the iPhone's and iPad's list, the web's list. Page titles,
 * controls and what a page holds stay with each client. Devices,
 * Connected agents and Gmail and Drive are cards within Account on the web, as
 * they are sections of Account on the Mac; Language is within Appearance.
 */

export const SETTINGS_CLIENTS = ['mac', 'ios', 'web'] as const;
export type SettingsClient = (typeof SETTINGS_CLIENTS)[number];

/** The headings the page list is drawn under, in order, on every client. */
export const SETTINGS_GROUPS = ['account', 'preferences', 'security', 'system'] as const;
export type SettingsGroup = (typeof SETTINGS_GROUPS)[number];

export const SETTINGS_GROUP_TITLES: Record<SettingsGroup, string> = {
  account: 'Account',
  preferences: 'Preferences',
  security: 'Security',
  system: 'System',
};

export interface SettingsPage {
  id: string;
  group: SettingsGroup;
  clients: readonly SettingsClient[];
  /** iOS also reaches this page from the Calendar tab's own settings sheet. */
  iosCalendarSettings?: true;
}

const ALL = ['mac', 'ios', 'web'] as const;
const NATIVE = ['mac', 'ios'] as const;

/** Top to bottom: the order every client lists them in. */
export const SETTINGS_PAGES = [
  { id: 'account', group: 'account', clients: ALL },
  { id: 'home', group: 'preferences', clients: ALL },
  { id: 'work', group: 'preferences', clients: ALL },
  { id: 'calendar', group: 'preferences', clients: ALL, iosCalendarSettings: true },
  { id: 'video', group: 'preferences', clients: ['mac'] },
  { id: 'audio', group: 'preferences', clients: ['mac'] },
  { id: 'captions', group: 'preferences', clients: NATIVE },
  { id: 'meetings', group: 'preferences', clients: ['mac'] },
  { id: 'room', group: 'preferences', clients: NATIVE },
  { id: 'notifications', group: 'preferences', clients: NATIVE },
  { id: 'calls', group: 'preferences', clients: ['ios'] },
  { id: 'appearance', group: 'preferences', clients: ALL },
  { id: 'appLock', group: 'security', clients: ['ios'] },
  { id: 'about', group: 'system', clients: ALL },
  { id: 'developmentServer', group: 'system', clients: ['ios'] },
] as const satisfies readonly SettingsPage[];

/** The groups one client draws, each with its pages in order; a group with no page is left out. */
export function settingsGroups(client: SettingsClient): Array<{ group: SettingsGroup; title: string; pages: SettingsPage[] }> {
  const pages = settingsPages(client);
  return SETTINGS_GROUPS
    .map((group) => ({ group, title: SETTINGS_GROUP_TITLES[group], pages: pages.filter((page) => page.group === group) }))
    .filter((row) => row.pages.length > 0);
}

/** The pages one client lists, in order. */
export function settingsPages(client: SettingsClient): SettingsPage[] {
  return SETTINGS_PAGES.filter((page) => (page.clients as readonly SettingsClient[]).includes(client));
}

/** The id of a page every client lists. */
export type SettingsPageEverywhere = Extract<(typeof SETTINGS_PAGES)[number], { clients: typeof ALL }>['id'];

/**
 * The pages every client lists, in order. A door that opens a Settings page
 * (the search palette's) has to open wherever it is drawn, so these are the
 * pages it may name; `SEARCH_SETTINGS_PAGES` is this list.
 */
export const SETTINGS_PAGES_EVERYWHERE: readonly SettingsPageEverywhere[] = SETTINGS_PAGES
  .filter((page) => SETTINGS_CLIENTS.every((client) => (page.clients as readonly SettingsClient[]).includes(client)))
  .map((page) => page.id as SettingsPageEverywhere);
