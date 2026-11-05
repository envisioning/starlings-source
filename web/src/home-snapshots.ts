// What Home's calendar cards keep between visits (docs/CACHING.md): the last
// answer of each read, so a card draws on the first frame and the live read
// replaces it in place. The same names the phone keeps them under. Separate
// from `owner-agenda.ts`, which the Worker's tests import and which must not
// reach the browser-only snapshot store.

export const HOME_SNAPSHOT = {
  upcoming: 'calendar/upcoming',
  preferences: 'calendar/preferences',
  publicEvents: 'public/events',
} as const;
