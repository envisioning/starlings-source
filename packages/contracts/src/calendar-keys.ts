/**
 * The keys calendar choices are stored under, and the two rules that change
 * them, decided once.
 *
 * `hidden_calendar_keys` and `disabled_calendar_keys` are owner-wide and read
 * by every client and the Worker. A key is opaque text with a grammar: `g:<id>`
 * for a Google calendar, `sub:<id>` for a subscribed feed, `ek:<account>/<title>`
 * for an EventKit calendar, `account:<name>` for a whole account, and
 * `event:...` for an event hidden from Next. Each client used to build these
 * strings itself; the Swift side even decided "is this the subscribed group"
 * by comparing a localized word. These functions are the grammar. Swift mirrors
 * the rules (`Sources/CalendarKeys.swift`), reads the prefixes from the table
 * generated out of `CALENDAR_KEY_FORMATS`, and `fixtures/calendar-keys.json`
 * pins the rules.
 */

/**
 * The key grammar as data: the prefix each kind of key starts with. The Swift
 * constants are generated from this table, so a prefix is typed here once.
 */
export const CALENDAR_KEY_FORMATS = {
  googlePrefix: 'g:',
  subscriptionPrefix: 'sub:',
  eventKitPrefix: 'ek:',
  /** Between an EventKit account and a calendar title. */
  eventKitSeparator: '/',
  accountPrefix: 'account:',
  eventPrefix: 'event:',
  googleEventPrefix: 'event:g:',
} as const;

/** Every subscribed feed at once. Not derived from a title: the group's title is localized. */
export const SUBSCRIBED_ACCOUNT_KEY = `${CALENDAR_KEY_FORMATS.accountPrefix}subscribed`;

export const googleCalendarKey = (calendarId: string): string => `${CALENDAR_KEY_FORMATS.googlePrefix}${calendarId}`;
export const subscriptionCalendarKey = (subscriptionId: string): string => `${CALENDAR_KEY_FORMATS.subscriptionPrefix}${subscriptionId}`;
export const eventKitCalendarKey = (account: string, title: string): string =>
  `${CALENDAR_KEY_FORMATS.eventKitPrefix}${account.toLowerCase()}${CALENDAR_KEY_FORMATS.eventKitSeparator}${title.toLowerCase()}`;

/** A whole account, by its heading. Kept as its own key so a calendar added later stays in or out with it. */
export const accountKey = (title: string): string => `${CALENDAR_KEY_FORMATS.accountPrefix}${title.toLowerCase()}`;

/**
 * A Google account's heading: "Google" for one account, its address once there
 * are two or more, as the native sidebars name them.
 */
export function googleAccountTitle(email: string | null | undefined, namesAccounts: boolean): string {
  return namesAccounts && email ? email : 'Google';
}

/** An event hidden from Next: a subscribed feed's row by its own id, a Google row as `event:g:` and the served id. */
export function eventDemotionKey(isSubscription: boolean, eventId: string): string {
  return `${isSubscription ? CALENDAR_KEY_FORMATS.eventPrefix : CALENDAR_KEY_FORMATS.googleEventPrefix}${eventId}`;
}

const sorted = (keys: Set<string>): string[] => [...keys].sort();

/**
 * Show or hide one calendar. Turning one back on inside an account that was
 * hidden wholesale expands the account key into one key per sibling, so the
 * other choices are kept.
 */
export function withCalendarHidden(
  keys: readonly string[],
  calendar: { key: string; accountKey: string; siblingKeys: readonly string[] },
  hidden: boolean,
): string[] {
  const next = new Set(keys);
  if (hidden) {
    next.add(calendar.key);
    return sorted(next);
  }
  if (next.delete(calendar.accountKey)) {
    for (const sibling of calendar.siblingKeys) if (sibling !== calendar.key) next.add(sibling);
  }
  next.delete(calendar.key);
  return sorted(next);
}

/** Show or hide a whole account: its own key stands for every calendar, present and future. */
export function withAccountHidden(
  keys: readonly string[],
  account: { key: string; memberKeys: readonly string[] },
  hidden: boolean,
): string[] {
  const next = new Set(keys);
  for (const member of account.memberKeys) next.delete(member);
  if (hidden) next.add(account.key);
  else next.delete(account.key);
  return sorted(next);
}
