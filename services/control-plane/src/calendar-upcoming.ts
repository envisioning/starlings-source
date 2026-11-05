import type { CalendarEventSummary, SubscriptionEventSummary } from '@starlings/contracts/calendar';
import { SUBSCRIBED_ACCOUNT_KEY, subscriptionCalendarKey } from '@starlings/contracts/calendar-keys';
import { parsePublicRoomPath, type OwnerSession } from './contracts';
import { listSubscriptions, subscriptionEvents } from './calendar-subscriptions';
import {
  CalendarError,
  detectConference,
  getCalendarPreferences,
  isDisplayableUpcomingEvent,
  listUpcomingCalendarEvents,
} from './calendar';
import { UPCOMING_CONFIG, upcomingRequestHours } from '@starlings/contracts/upcoming';
import { workspacePublicOrigin } from './workspace-origins';

/**
 * Home's single agenda combines owner-selected Google calendars with
 * owner-selected .ics subscriptions. EventKit stays device-local and does not
 * enter the shared feed.
 */
export async function listHomeUpcomingCalendarEvents(
  env: Env,
  owner: OwnerSession,
  hours?: number,
): Promise<CalendarEventSummary[]> {
  const [preferences, subscriptions] = await Promise.all([
    getCalendarPreferences(env, owner),
    listSubscriptions(env, owner),
  ]);
  const excluded = new Set(preferences.upcomingExcludedSubscriptionIds);
  const disabled = new Set(preferences.disabledCalendarKeys);
  const includeAllSubscriptions = !disabled.has(SUBSCRIBED_ACCOUNT_KEY);
  const upcomingSubscriptions = subscriptions.filter((subscription) =>
    includeAllSubscriptions
      && !excluded.has(subscription.id)
      && !disabled.has(subscriptionCalendarKey(subscription.id)));
  const subscriptionIDs = new Set(upcomingSubscriptions.map(({ id }) => id));

  let googleEvents: CalendarEventSummary[];
  try {
    googleEvents = await listUpcomingCalendarEvents(env, owner, hours);
  } catch (error) {
    // A shared subscription can be useful even before Google Calendar is
    // connected. Other failures still surface so Home can show its retry state.
    if (
      error instanceof CalendarError
      && error.code === 'calendar_not_connected'
      && upcomingSubscriptions.length > 0
    ) {
      googleEvents = [];
    } else {
      throw error;
    }
  }

  const now = new Date();
  const timeMin = new Date(now.getTime() - 36 * 3_600_000);
  const requestedHours = Math.max(hours ?? 0, upcomingRequestHours(preferences.upcoming));
  const timeMax = new Date(now.getTime() + Math.max(1, Math.min(requestedHours, 24 * 100)) * 3_600_000);
  const feedEvents = subscriptionIDs.size > 0
    ? await subscriptionEvents(env, owner, timeMin, timeMax, subscriptionIDs)
    : [];
  const titles = new Map(upcomingSubscriptions.map(({ id, title }) => [id, title]));

  return [
    ...googleEvents,
    ...feedEvents.map((event) => summarizeUpcomingSubscription(event, titles.get(event.subscriptionId) ?? '', preferences, [env.WEB_ORIGIN, workspacePublicOrigin(env)])),
  ]
    .filter((event) => isDisplayableUpcomingEvent(event, now.getTime()))
    .sort((left, right) => Date.parse(left.start) - Date.parse(right.start))
    .slice(0, UPCOMING_CONFIG.maxAgendaEvents);
}

function summarizeUpcomingSubscription(
  event: SubscriptionEventSummary,
  calendarSummary: string,
  preferences: Awaited<ReturnType<typeof getCalendarPreferences>>,
  [webOrigin, publicOrigin]: [string, string],
): CalendarEventSummary {
  const calendarId = `sub:${event.subscriptionId}`;
  const url = /^https?:\/\//iu.test(event.url) ? event.url : '';
  const conference = detectConference({
    location: event.location,
    description: event.description,
    hangoutLink: url,
  }, { envisioningJoinUrl: '', webOrigin, publicOrigin });
  const launchUrl = url || conference.url;
  let roomSlug = '';
  if (launchUrl && conference.platform === 'starlings') {
    try {
      roomSlug = parsePublicRoomPath(new URL(launchUrl).pathname)?.slug ?? '';
    } catch {
      roomSlug = '';
    }
  }
  const eventKey = `event:${event.id}`;
  return {
    id: event.id,
    calendarId,
    calendarSummary,
    htmlLink: '',
    title: event.title,
    start: event.start,
    end: event.end,
    joinUrl: launchUrl,
    roomSlug,
    isMeetEvent: roomSlug.length > 0,
    attendees: [],
    organizerSelf: true,
    platform: roomSlug ? 'starlings' : conference.platform,
    conferenceUrl: launchUrl,
    allDay: event.allDay,
    recurringEventId: '',
    recurring: event.recurring,
    description: event.description,
    location: event.location,
    travelTimeMinutes: null,
    demoted: preferences.demotedEventKeys.includes(eventKey),
    calendarRole: 'ordinary',
    subject: preferences.eventSubjects[eventKey] ?? null,
  };
}
