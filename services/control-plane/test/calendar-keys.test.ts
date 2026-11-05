import { describe, expect, it } from 'vitest';
import {
  CALENDAR_KEY_FORMATS,
  SUBSCRIBED_ACCOUNT_KEY,
  accountKey,
  eventDemotionKey,
  eventKitCalendarKey,
  googleAccountTitle,
  googleCalendarKey,
  subscriptionCalendarKey,
  withAccountHidden,
  withCalendarHidden,
} from '@starlings/contracts/calendar-keys';
import fixture from '../../../fixtures/calendar-keys.json';

describe('calendar keys', () => {
  it('builds the keys in fixtures/calendar-keys.json, the table the Swift mirror pins', () => {
    expect(SUBSCRIBED_ACCOUNT_KEY).toBe(fixture.subscribedAccountKey);
    expect(fixture.formats).toEqual(CALENDAR_KEY_FORMATS);
    for (const row of fixture.google) expect(googleCalendarKey(row.id)).toBe(row.out);
    for (const row of fixture.subscription) expect(subscriptionCalendarKey(row.id)).toBe(row.out);
    for (const row of fixture.eventKit) expect(eventKitCalendarKey(row.account, row.title)).toBe(row.out);
    for (const row of fixture.account) expect(accountKey(row.title)).toBe(row.out);
    for (const row of fixture.accountTitle) expect(googleAccountTitle(row.email, row.namesAccounts)).toBe(row.out);
    for (const row of fixture.demotion) expect(eventDemotionKey(row.isSubscription, row.eventId)).toBe(row.out);
  });

  it('applies the hide and show rules in the fixture', () => {
    for (const row of fixture.hide) expect(withCalendarHidden(row.keys, row.calendar, row.hidden), row.name).toEqual(row.out);
    for (const row of fixture.hideAccount) expect(withAccountHidden(row.keys, row.account, row.hidden), row.name).toEqual(row.out);
  });
});
