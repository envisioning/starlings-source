import { describe, expect, it } from 'vitest';
import { getCalendarPreferences, setCalendarPreferences } from '../src/calendar';
import { calendarPreferencesSchema } from '@starlings/contracts';

// Only the two KV methods the preference paths touch.
function fakeEnv(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  const env = {
    CALENDAR_TOKENS: {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => { store.set(key, value); },
    },
  } as never;
  return { env, store };
}

const owner = { sub: 'owner-1', email: 'rosa@example.com' } as never;
const key = 'calendar:prefs:owner-1';

describe('calendar preferences', () => {
  it('reads a pre-hidden-keys blob as nothing hidden', async () => {
    const { env } = fakeEnv({ [key]: JSON.stringify({ selectedCalendarIds: ['primary'] }) });
    expect(await getCalendarPreferences(env, owner)).toEqual({
      selectedCalendarIds: ['primary'],
      upcomingExcludedSubscriptionIds: [],
      hiddenCalendarKeys: [],
      disabledCalendarKeys: [],
      demotedEventKeys: [],
      includesLocalCalendars: false,
      eventSubjects: {},
      upcoming: {
        horizonDays: 2,
        homeFollowingRows: 2,
        showTomorrow: true,
      },
    });
  });

  it('files an event under a subject for both devices, and drops what is not a subject', async () => {
    const { env } = fakeEnv({ [key]: JSON.stringify({ selectedCalendarIds: ['primary'] }) });
    const project = { kind: 'project' as const, id: '3f6c1f52-0a1b-4c2d-8e3f-0a1b2c3d4e5f', title: 'Acme rollout' };
    const saved = await setCalendarPreferences(env, owner, {
      eventSubjects: {
        'event:g:primary:kickoff': project,
        'event:g:primary:broken': { kind: 'meeting', id: 'x', title: 'no' } as never,
        '   ': project,
      },
    });
    expect(saved.eventSubjects).toEqual({ 'event:g:primary:kickoff': project });
    // Read back the same way a phone would, untouched by the other fields.
    expect((await getCalendarPreferences(env, owner)).eventSubjects).toEqual({ 'event:g:primary:kickoff': project });
    expect(saved.selectedCalendarIds).toEqual(['primary']);
    // Writing the map whole is how an entry is removed.
    const cleared = await setCalendarPreferences(env, owner, { eventSubjects: {} });
    expect(cleared.eventSubjects).toEqual({});
  });

  it('files an event under a partner, and refuses an event subject', async () => {
    const { env } = fakeEnv({ [key]: JSON.stringify({ selectedCalendarIds: ['primary'] }) });
    const partner = { kind: 'organization' as const, id: '3f6c1f52-0a1b-4c2d-8e3f-0a1b2c3d4e5f', title: 'Acme' };
    const saved = await setCalendarPreferences(env, owner, {
      eventSubjects: {
        'event:g:primary:qbr': partner,
        'event:g:primary:talk': { kind: 'event', id: partner.id, title: 'Talk' } as never,
      },
    });
    expect(saved.eventSubjects).toEqual({ 'event:g:primary:qbr': partner });
    expect(calendarPreferencesSchema.safeParse({ event_subjects: { k: partner } }).success).toBe(true);
    expect(calendarPreferencesSchema.safeParse({ event_subjects: { k: { ...partner, kind: 'event' } } }).success).toBe(false);
  });

  it('accepts event subjects on the wire and refuses a subject that is not one', () => {
    expect(calendarPreferencesSchema.safeParse({
      event_subjects: { 'event:g:primary:kickoff': { kind: 'lead', id: '3f6c1f52-0a1b-4c2d-8e3f-0a1b2c3d4e5f', title: 'Acme' } },
    }).success).toBe(true);
    expect(calendarPreferencesSchema.safeParse({
      event_subjects: { 'event:g:primary:kickoff': { kind: 'status', id: 'x', title: 'Acme' } },
    }).success).toBe(false);
    expect(calendarPreferencesSchema.safeParse({
      upcoming: { horizon_days: 14, home_following_rows: 3, show_tomorrow: false },
    }).success).toBe(true);
    expect(calendarPreferencesSchema.safeParse({
      upcoming: { horizon_days: 31, home_following_rows: 3, show_tomorrow: false },
    }).success).toBe(false);
  });

  it('keeps the calendar selection when only hidden keys are written', async () => {
    const { env } = fakeEnv({ [key]: JSON.stringify({ selectedCalendarIds: ['primary', 'team@example.com'] }) });
    const saved = await setCalendarPreferences(env, owner, { hiddenCalendarKeys: ['account:envisioning'] });
    expect(saved.selectedCalendarIds).toEqual(['primary', 'team@example.com']);
    expect(saved.hiddenCalendarKeys).toEqual(['account:envisioning']);
  });

  it('keeps hidden keys when only the selection is written', async () => {
    const { env } = fakeEnv({
      [key]: JSON.stringify({ selectedCalendarIds: ['primary'], hiddenCalendarKeys: ['ek:icloud/home'] }),
    });
    const saved = await setCalendarPreferences(env, owner, { selectedCalendarIds: ['primary', 'other'] });
    expect(saved.hiddenCalendarKeys).toEqual(['ek:icloud/home']);
  });

  it('lets every calendar be shown again, but never leaves the selection empty', async () => {
    const { env } = fakeEnv();
    expect((await setCalendarPreferences(env, owner, { hiddenCalendarKeys: [] })).hiddenCalendarKeys).toEqual([]);
    await expect(setCalendarPreferences(env, owner, { selectedCalendarIds: [] })).rejects.toThrow();
  });

  it('keeps disabling apart from hiding', async () => {
    const { env } = fakeEnv({
      [key]: JSON.stringify({ selectedCalendarIds: ['primary'], hiddenCalendarKeys: ['ek:icloud/home'] }),
    });
    const saved = await setCalendarPreferences(env, owner, {
      disabledCalendarKeys: ['account:on my mac', 'ek:icloud/siri suggestions'],
    });
    // Hiding is a checkbox; disabling takes the calendar out of the app. One
    // must never quietly become the other.
    expect(saved.hiddenCalendarKeys).toEqual(['ek:icloud/home']);
    expect(saved.disabledCalendarKeys).toEqual(['account:on my mac', 'ek:icloud/siri suggestions']);
    expect((await getCalendarPreferences(env, owner)).disabledCalendarKeys)
      .toEqual(['account:on my mac', 'ek:icloud/siri suggestions']);
  });

  it('reads a pre-disabled-keys blob as nothing disabled, and can empty the list again', async () => {
    const { env } = fakeEnv({
      [key]: JSON.stringify({ selectedCalendarIds: ['primary'], hiddenCalendarKeys: [] }),
    });
    expect((await getCalendarPreferences(env, owner)).disabledCalendarKeys).toEqual([]);
    await setCalendarPreferences(env, owner, { disabledCalendarKeys: ['account:icloud'] });
    expect((await setCalendarPreferences(env, owner, { disabledCalendarKeys: [] })).disabledCalendarKeys).toEqual([]);
  });

  it('shares event demotion and the local-calendar gate without touching source choices', async () => {
    const { env } = fakeEnv({
      [key]: JSON.stringify({ selectedCalendarIds: ['primary'], hiddenCalendarKeys: ['g:private'] }),
    });
    const saved = await setCalendarPreferences(env, owner, {
      demotedEventKeys: ['event:g:primary:flight-1'],
      includesLocalCalendars: true,
    });
    expect(saved.demotedEventKeys).toEqual(['event:g:primary:flight-1']);
    expect(saved.includesLocalCalendars).toBe(true);
    expect(saved.hiddenCalendarKeys).toEqual(['g:private']);
    expect(saved.selectedCalendarIds).toEqual(['primary']);
  });

  it('requires the request to carry at least one field', () => {
    expect(calendarPreferencesSchema.safeParse({}).success).toBe(false);
    expect(calendarPreferencesSchema.safeParse({ hidden_calendar_keys: [] }).success).toBe(true);
    expect(calendarPreferencesSchema.safeParse({ selected_calendar_ids: ['primary'] }).success).toBe(true);
    expect(calendarPreferencesSchema.safeParse({ disabled_calendar_keys: ['account:icloud'] }).success).toBe(true);
    expect(calendarPreferencesSchema.safeParse({ demoted_event_keys: ['event:g:primary:flight-1'] }).success).toBe(true);
    expect(calendarPreferencesSchema.safeParse({ includes_local_calendars: false }).success).toBe(true);
    expect(calendarPreferencesSchema.safeParse({ upcoming: { horizon_days: 14, home_following_rows: 3, show_tomorrow: false } }).success).toBe(true);
  });

  it('stores the Upcoming display policy without touching calendar sources', async () => {
    const { env } = fakeEnv({ [key]: JSON.stringify({ selectedCalendarIds: ['primary'], hiddenCalendarKeys: ['g:private'] }) });
    const saved = await setCalendarPreferences(env, owner, {
      upcoming: { horizonDays: 14, homeFollowingRows: 3, showTomorrow: false },
    });
    expect(saved.upcoming).toEqual({ horizonDays: 2, homeFollowingRows: 3, showTomorrow: true });
    expect(saved.selectedCalendarIds).toEqual(['primary']);
    expect(saved.hiddenCalendarKeys).toEqual(['g:private']);
  });
});
