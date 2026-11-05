import type { CalendarAccount, CalendarStatus, CalendarSubscription } from '@starlings/contracts/calendar';
import type { OwnerSession } from './contracts';
import { getCalendarStatus, listCalendarAccounts } from './calendar';
import { listSubscriptions } from './calendar-subscriptions';

/**
 * `GET /api/calendar/status`: the primary Google connection, and whether the
 * member has any calendar the server can read. The Calendar tab shows by
 * `sources`. EventKit stays on the device, so a client adds it.
 */
export async function getCalendarStatusWithSources(env: Env, owner: OwnerSession): Promise<CalendarStatus> {
  const status = await getCalendarStatus(env, owner);
  if (status.connected) return { ...status, sources: true };
  const [accounts, subscriptions] = await Promise.all([
    listCalendarAccounts(env, owner),
    listSubscriptions(env, owner),
  ]);
  return { ...status, sources: hasCalendarSource(accounts, subscriptions) };
}

/** A connected Google account of any kind, or any `.ics` subscription. */
export function hasCalendarSource(
  accounts: readonly Pick<CalendarAccount, 'connected'>[],
  subscriptions: readonly Pick<CalendarSubscription, 'id'>[],
): boolean {
  return accounts.some(({ connected }) => connected) || subscriptions.length > 0;
}
