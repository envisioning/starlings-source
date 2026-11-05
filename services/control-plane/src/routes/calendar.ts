import { permanentRoomFor } from '../room-access';
import { readBookingSettings, writeBookingSettings } from '../booking-settings';
import { ownBookableBlocks } from '../booking-public';
import { bookingStore } from '../work-store';
import { getCalendarStatusWithSources } from '../calendar-sources';
import { subjectAccessFor, taskKey } from '../subject-access';
import {
  androidCalendarClient,
  attachMeetBooking,
  completeCentralCalendarConnect,
  completeWebCalendarConnect,
  connectAdditionalAndroidCalendarAccount,
  connectAdditionalCalendarAccount,
  createCalendarEvent,
  deleteCalendarEvent,
  disconnectCalendar,
  exchangeAndroidCalendarCode,
  exchangeNativeCalendarCode,
  fetchCalendarFreeBusy,
  getCalendarPreferences,
  listCalendarAccounts,
  listCalendarEventsInRange,
  listCalendarInvitations,
  listGoogleCalendars,
  moveCalendarEvent,
  patchCalendarEvent,
  removeCalendarAccount,
  respondToCalendarEvent,
  setCalendarPreferences,
  startWebCalendarConnect,
} from '../calendar';
import { quickAddDraft } from '../calendar-quick-add';
import { addSubscription, listSubscriptions, removeSubscription, subscriptionEvents } from '../calendar-subscriptions';
import { listHomeUpcomingCalendarEvents } from '../calendar-upcoming';
import {
  type CalendarQuickAddResponse,
  type OkResponse,
  type PendingCalendarEventsResponse,
  calendarAvailabilityQuerySchema,
  type CalendarAndroidClient,
  calendarAndroidExchangeSchema,
  calendarBookingMintSchema,
  calendarConnectExchangeSchema,
  calendarEventCreateSchema,
  calendarEventDeleteSchema,
  calendarEventMoveSchema,
  calendarEventPatchSchema,
  calendarEventRespondSchema,
  calendarEventsQuerySchema,
  calendarFreeBusySchema,
  calendarPreferencesSchema,
  calendarQuickAddSchema,
  calendarSubscriptionCreateSchema,
  calendarUpcomingQuerySchema,
  calendarWorkItemsQuerySchema,
  pendingCalendarEventAddSchema,
  rawCalendarEventId,
} from '../contracts';
import { fetchCrmWorkItems, markOwnWorkItems } from '../crm';
import { json, readBoundedJSON } from '../http';
import { addPendingEvent, discardPendingEvent, listPendingEvents } from '../pending-calendar-events';
import { fetchAvailabilityBlocks } from '../schedule-proxy';
import { announceCalendarFilings } from '../threads';
import type {
  CalendarAccountListResponse,
  CalendarAccountResponse,
  CalendarAvailabilityResponse,
  CalendarBookingMintResponse,
  CalendarEventResponse,
  CalendarEventsResponse,
  CalendarFreeBusyResponse,
  CalendarPreferencesResponse,
  CalendarStatus,
  CalendarSubscriptionListResponse,
  CalendarSubscriptionResponse,
  GoogleCalendarListResponse,
  SubscriptionEventsResponse,
} from '@starlings/contracts/calendar';
import type { CalendarWorkItemsResponse } from '@starlings/contracts/crm';
import { bookingSettingsUpdateSchema, type BookingSettingsResponse } from '@starlings/contracts/booking-settings';
import { PARAMS, defineRoute, type Route } from '../route-types';

// The member's calendar is "Only you": every row refuses an agent acting
// as the member (agent-boundary.ts). Their own Connected Claude reads it.
export const calendarRoutes: readonly Route[] = [
  defineRoute({
    method: 'GET',
    path: '/api/calendar/status',
    gate: { kind: 'capability', capability: 'calendar', agents: 'refuse' },
    handler: async ({ env, owner }) => json(await getCalendarStatusWithSources(env, owner) satisfies CalendarStatus),
  }),

  defineRoute({
    method: 'GET',
    path: '/api/calendar/connect/start',
    gate: { kind: 'capability', capability: 'calendar', agents: 'refuse' },
    handler: async ({ request, env, owner }) => startWebCalendarConnect(request, env, owner),
  }),

  defineRoute({
    method: 'GET',
    path: '/api/calendar/connect/callback',
    gate: { kind: 'capability', capability: 'calendar', agents: 'refuse' },
    handler: async ({ request, env, owner }) => completeWebCalendarConnect(request, env, owner),
  }),

  defineRoute({
    method: 'GET',
    path: '/api/calendar/connect/complete',
    gate: { kind: 'capability', capability: 'calendar', agents: 'refuse' },
    handler: async ({ request, env, owner }) => completeCentralCalendarConnect(request, env, owner),
  }),

  defineRoute({
    method: 'POST',
    path: '/api/calendar/connect/exchange',
    gate: { kind: 'capability', capability: 'calendar', origin: 'trusted', agents: 'refuse' },
    handler: async ({ request, env, owner }) => {
      const body = calendarConnectExchangeSchema.parse(await readBoundedJSON(request));
      const status = await exchangeNativeCalendarCode(env, owner, {
        code: body.code,
        codeVerifier: body.code_verifier,
        redirectURI: body.redirect_uri,
        nonce: body.nonce,
      });
      return json(status satisfies CalendarStatus);
    },
  }),

  // Android (docs/agents/areas/android.md, "Calendar"): Google's
  // AuthorizationClient issues a one-time code to the client named here, and
  // the Worker redeems it with that client's secret.
  defineRoute({
    method: 'GET',
    path: '/api/calendar/connect/android',
    gate: { kind: 'capability', capability: 'calendar', agents: 'refuse' },
    handler: async ({ env }) => json(await androidCalendarClient(env) satisfies CalendarAndroidClient),
  }),

  defineRoute({
    method: 'POST',
    path: '/api/calendar/connect/android',
    gate: { kind: 'capability', capability: 'calendar', origin: 'trusted', agents: 'refuse' },
    handler: async ({ request, env, owner }) => {
      const body = calendarAndroidExchangeSchema.parse(await readBoundedJSON(request));
      return json(await exchangeAndroidCalendarCode(env, owner, body.server_auth_code) satisfies CalendarStatus);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/calendar/disconnect',
    gate: { kind: 'capability', capability: 'calendar', origin: 'trusted', agents: 'refuse' },
    handler: async ({ env, owner }) => {
      await disconnectCalendar(env, owner);
      return json({ connected: false } satisfies CalendarStatus);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/calendar/events',
    gate: { kind: 'capability', capability: 'calendar', origin: 'trusted', agents: 'refuse' },
    handler: async ({ request, env, owner }) => {
      const body = calendarEventCreateSchema.parse(await readBoundedJSON(request));
      const event = await createCalendarEvent(env, owner, {
        title: body.title,
        start: body.start,
        end: body.end,
        attendees: body.attendees,
        ...(body.join_url !== undefined ? { joinUrl: body.join_url } : {}),
        ...(body.room_slug !== undefined ? { roomSlug: body.room_slug } : {}),
        ...(body.calendar_id !== undefined ? { calendarId: body.calendar_id } : {}),
        ...(body.all_day !== undefined ? { allDay: body.all_day } : {}),
        ...(body.travel_time_minutes !== undefined ? { travelTimeMinutes: body.travel_time_minutes } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.location !== undefined ? { location: body.location } : {}),
        ...(body.time_zone !== undefined ? { timeZone: body.time_zone } : {}),
      });
      return json({ event } satisfies CalendarEventResponse, 201);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/calendar/booking-token',
    gate: { kind: 'capability', capability: 'calendar', origin: 'trusted', agents: 'refuse' },
    handler: async ({ request, env, owner }) => {
      const body = calendarBookingMintSchema.parse(await readBoundedJSON(request));
      const minted = await attachMeetBooking(env, owner, {
        title: body.title,
        ...(body.start !== undefined ? { start: body.start } : {}),
        ...(body.end !== undefined ? { end: body.end } : {}),
        roomSlug: body.room_slug,
        ...(body.join_url !== undefined ? { joinUrl: body.join_url } : {}),
        ...(body.guest_name !== undefined ? { guestName: body.guest_name } : {}),
        ...(body.guest_email !== undefined ? { guestEmail: body.guest_email } : {}),
      });
      return json({ token: minted.token, join_url: minted.joinUrl } satisfies CalendarBookingMintResponse, 201);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/calendar/events',
    gate: { kind: 'capability', capability: 'calendar', agents: 'refuse' },
    handler: async ({ env, url, owner }) => {
      const query = calendarEventsQuerySchema.parse({
        time_min: url.searchParams.get('time_min') ?? undefined,
        time_max: url.searchParams.get('time_max') ?? undefined,
      });
      return json({ events: await listCalendarEventsInRange(env, owner, query.time_min, query.time_max) } satisfies CalendarEventsResponse);
    },
  }),

  // Quick add: a sentence to a draft, for the web. The native
  // clients run the grammar themselves and come here only for the model.
  defineRoute({
    method: 'POST',
    path: '/api/calendar/quick-add',
    gate: { kind: 'capability', capability: 'calendar', origin: 'trusted', agents: 'refuse' },
    handler: async ({ request, env }) => {
      const body = calendarQuickAddSchema.parse(await readBoundedJSON(request));
      return json(await quickAddDraft(env, {
        sentence: body.sentence,
        now: body.now,
        timeZone: body.time_zone,
        defaultDurationMinutes: body.default_duration_minutes,
        allowModel: body.allow_model,
      }) satisfies CalendarQuickAddResponse);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/calendar/invitations',
    gate: { kind: 'capability', capability: 'calendar', agents: 'refuse' },
    handler: async ({ env, owner }) => json({ events: await listCalendarInvitations(env, owner) } satisfies CalendarEventsResponse),
  }),

  // Events proposed from mail forwarded to calendar@: the owner's
  // rows, then one Add or Discard per row.
  defineRoute({
    method: 'GET',
    path: '/api/calendar/pending',
    gate: { kind: 'capability', capability: 'calendar', agents: 'refuse' },
    handler: async ({ env, owner }) => json({ events: await listPendingEvents(env, owner.sub) } satisfies PendingCalendarEventsResponse),
  }),

  defineRoute({
    method: 'PATCH',
    path: '/api/calendar/event',
    gate: { kind: 'capability', capability: 'calendar', origin: 'trusted', agents: 'refuse' },
    handler: async ({ request, env, owner }) => {
      const body = calendarEventPatchSchema.parse(await readBoundedJSON(request));
      const event = await patchCalendarEvent(env, owner, {
        calendarId: body.calendar_id,
        eventId: rawCalendarEventId(body.calendar_id, body.event_id),
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.start !== undefined ? { start: body.start } : {}),
        ...(body.end !== undefined ? { end: body.end } : {}),
        ...(body.all_day !== undefined ? { allDay: body.all_day } : {}),
        ...(body.travel_time_minutes !== undefined ? { travelTimeMinutes: body.travel_time_minutes } : {}),
        ...(body.attendees !== undefined ? { attendees: body.attendees } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.location !== undefined ? { location: body.location } : {}),
        ...(body.time_zone !== undefined ? { timeZone: body.time_zone } : {}),
        ...(body.join_url !== undefined ? { joinUrl: body.join_url } : {}),
        ...(body.room_slug !== undefined ? { roomSlug: body.room_slug } : {}),
      });
      return json({ event } satisfies CalendarEventResponse);
    },
  }),

  defineRoute({
    method: 'DELETE',
    path: '/api/calendar/event',
    gate: { kind: 'capability', capability: 'calendar', origin: 'trusted', agents: 'refuse' },
    handler: async ({ request, env, owner }) => {
      const body = calendarEventDeleteSchema.parse(await readBoundedJSON(request));
      await deleteCalendarEvent(env, owner, { calendarId: body.calendar_id, eventId: rawCalendarEventId(body.calendar_id, body.event_id) });
      return json({ ok: true } satisfies OkResponse);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/calendar/work-items',
    gate: { kind: 'capability', capability: 'calendar', agents: 'refuse' },
    handler: async ({ env, url, owner }) => {
      const query = calendarWorkItemsQuerySchema.parse({
        start: url.searchParams.get('start') ?? undefined,
        end: url.searchParams.get('end') ?? undefined,
        include_done: url.searchParams.get('include_done') ?? undefined,
      });
      // Tasks and milestones are Envisioning-internal, so a failure here must not
      // take the calendar down with it — the events still matter.
      try {
        const items = await fetchCrmWorkItems(env, {
          start: query.start,
          end: query.end,
          includeDone: query.include_done,
        });
        const access = await subjectAccessFor(env, owner);
        return json({ items: markOwnWorkItems(access.filter(items, taskKey), owner.email) } satisfies CalendarWorkItemsResponse);
      } catch {
        return json({ items: [], degraded: true } satisfies CalendarWorkItemsResponse);
      }
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/calendar/availability',
    gate: { kind: 'capability', capability: 'calendar', agents: 'refuse' },
    handler: async ({ env, url, owner }) => {
      const query = calendarAvailabilityQuerySchema.parse({
        start: url.searchParams.get('start') ?? undefined,
        end: url.searchParams.get('end') ?? undefined,
      });
      // The Worker picks the owner's room (member-rooms.ts); an owner without a
      // permanent room has no booking page, so there is nothing to draw.
      const slug = await permanentRoomFor(owner, env);
      if (!slug) return json({ blocks: [] } satisfies CalendarAvailabilityResponse);
      // Core being down must not take the calendar down — same rule as work items.
      try {
        // Booking from Core until BOOKING_STORE flips it; from D1 on every other workspace.
        const blocks = bookingStore(env) === 'core'
          ? await fetchAvailabilityBlocks(env, slug, query)
          : await ownBookableBlocks(env, owner, query);
        return json({ blocks } satisfies CalendarAvailabilityResponse);
      } catch {
        return json({ blocks: [], degraded: true } satisfies CalendarAvailabilityResponse);
      }
    },
  }),

  // How other people book a time with you: the booking fields, plus your
  // profile hours and zone (docs/CORE_FOLD_PLAN.md §Phase 3d).
  defineRoute({
    method: 'GET',
    path: '/api/calendar/booking-settings',
    gate: { kind: 'capability', capability: 'calendar', agents: 'refuse' },
    handler: async ({ env, owner }) => json(await readBookingSettings(owner, env) satisfies BookingSettingsResponse),
  }),

  defineRoute({
    method: 'PUT',
    path: '/api/calendar/booking-settings',
    gate: { kind: 'capability', capability: 'calendar', origin: 'trusted', agents: 'refuse' },
    handler: async ({ request, env, owner }) => {
      const body = bookingSettingsUpdateSchema.parse(await readBoundedJSON(request));
      return json(await writeBookingSettings(owner, env, body) satisfies BookingSettingsResponse);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/calendar/free-busy',
    gate: { kind: 'capability', capability: 'calendar', origin: 'trusted', agents: 'refuse' },
    handler: async ({ request, env, owner }) => {
      const body = calendarFreeBusySchema.parse(await readBoundedJSON(request));
      return json({
        people: await fetchCalendarFreeBusy(env, owner, {
          timeMin: body.time_min,
          timeMax: body.time_max,
          emails: body.emails,
        }),
      } satisfies CalendarFreeBusyResponse);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/calendar/event/move',
    gate: { kind: 'capability', capability: 'calendar', origin: 'trusted', agents: 'refuse' },
    handler: async ({ request, env, owner }) => {
      const body = calendarEventMoveSchema.parse(await readBoundedJSON(request));
      const event = await moveCalendarEvent(env, owner, {
        calendarId: body.calendar_id,
        eventId: rawCalendarEventId(body.calendar_id, body.event_id),
        destinationId: body.destination_id,
      });
      return json({ event } satisfies CalendarEventResponse);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/calendar/event/respond',
    gate: { kind: 'capability', capability: 'calendar', origin: 'trusted', agents: 'refuse' },
    handler: async ({ request, env, owner }) => {
      const body = calendarEventRespondSchema.parse(await readBoundedJSON(request));
      const event = await respondToCalendarEvent(env, owner, {
        calendarId: body.calendar_id,
        eventId: rawCalendarEventId(body.calendar_id, body.event_id),
        response: body.response,
      });
      return json({ event } satisfies CalendarEventResponse);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/calendar/upcoming',
    gate: { kind: 'capability', capability: 'calendar', agents: 'refuse' },
    handler: async ({ env, url, owner }) => {
      const query = calendarUpcomingQuerySchema.parse({
        hours: url.searchParams.get('hours') ?? undefined,
      });
      return json({ events: await listHomeUpcomingCalendarEvents(env, owner, query.hours) } satisfies CalendarEventsResponse);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/calendar/calendars',
    gate: { kind: 'capability', capability: 'calendar', agents: 'refuse' },
    handler: async ({ env, owner }) => json({ calendars: await listGoogleCalendars(env, owner) } satisfies GoogleCalendarListResponse),
  }),

  defineRoute({
    method: 'GET',
    path: '/api/calendar/preferences',
    gate: { kind: 'capability', capability: 'calendar', agents: 'refuse' },
    handler: async ({ env, owner }) => {
      const prefs = await getCalendarPreferences(env, owner);
      return json({
        selected_calendar_ids: prefs.selectedCalendarIds,
        upcoming_excluded_subscription_ids: prefs.upcomingExcludedSubscriptionIds,
        hidden_calendar_keys: prefs.hiddenCalendarKeys,
        disabled_calendar_keys: prefs.disabledCalendarKeys,
        demoted_event_keys: prefs.demotedEventKeys,
        includes_local_calendars: prefs.includesLocalCalendars,
        event_subjects: prefs.eventSubjects,
        upcoming: {
          horizon_days: prefs.upcoming.horizonDays,
          home_following_rows: prefs.upcoming.homeFollowingRows,
          show_tomorrow: prefs.upcoming.showTomorrow,
        },
      } satisfies CalendarPreferencesResponse);
    },
  }),

  defineRoute({
    method: 'PUT',
    path: '/api/calendar/preferences',
    gate: { kind: 'capability', capability: 'calendar', origin: 'trusted', agents: 'refuse' },
    handler: async ({ request, env, ctx, owner }) => {
      const body = calendarPreferencesSchema.parse(await readBoundedJSON(request));
      // This route writes the whole `event_subjects` map, sent as one blob —
      // there is no dedicated "file this event" route (WORK.md step 5). The
      // only way to know a filing just happened, rather than an unrelated
      // preference changing, is to diff against what was stored a moment ago.
      const before = body.event_subjects !== undefined ? await getCalendarPreferences(env, owner) : null;
      // Filing an event on a subject posts in its channel: a write there
      // (docs/ACCESS.md). Only the filings this request changes are checked.
      if (before && body.event_subjects) {
        const access = await subjectAccessFor(env, owner);
        for (const [key, subject] of Object.entries(body.event_subjects)) {
          const was = before.eventSubjects[key];
          if (was?.kind === subject.kind && was.id === subject.id) continue;
          access.requireWrite(subject.kind, subject.id);
        }
      }
      const prefs = await setCalendarPreferences(env, owner, {
        selectedCalendarIds: body.selected_calendar_ids,
        upcomingExcludedSubscriptionIds: body.upcoming_excluded_subscription_ids,
        hiddenCalendarKeys: body.hidden_calendar_keys,
        disabledCalendarKeys: body.disabled_calendar_keys,
        demotedEventKeys: body.demoted_event_keys,
        includesLocalCalendars: body.includes_local_calendars,
        eventSubjects: body.event_subjects,
        upcoming: body.upcoming
          ? {
              horizonDays: body.upcoming.horizon_days,
              homeFollowingRows: body.upcoming.home_following_rows,
              showTomorrow: body.upcoming.show_tomorrow,
            }
          : undefined,
      });
      if (before) {
        ctx.waitUntil(announceCalendarFilings(env, owner, before.eventSubjects, prefs.eventSubjects));
      }
      return json({
        selected_calendar_ids: prefs.selectedCalendarIds,
        upcoming_excluded_subscription_ids: prefs.upcomingExcludedSubscriptionIds,
        hidden_calendar_keys: prefs.hiddenCalendarKeys,
        disabled_calendar_keys: prefs.disabledCalendarKeys,
        demoted_event_keys: prefs.demotedEventKeys,
        includes_local_calendars: prefs.includesLocalCalendars,
        event_subjects: prefs.eventSubjects,
        upcoming: {
          horizon_days: prefs.upcoming.horizonDays,
          home_following_rows: prefs.upcoming.homeFollowingRows,
          show_tomorrow: prefs.upcoming.showTomorrow,
        },
      } satisfies CalendarPreferencesResponse);
    },
  }),

  // Events proposed from mail forwarded to calendar@: the owner's
  // rows, then one Add or Discard per row.
  defineRoute({
    method: 'POST',
    path: '/api/calendar/pending/:id/add',
    gate: { kind: 'capability', capability: 'calendar', origin: 'trusted', agents: 'refuse' },
    handler: async ({ request, env, owner, params }) => {
      const body = pendingCalendarEventAddSchema.parse(await readBoundedJSON(request).catch(() => ({})));
      const event = await addPendingEvent(env, owner, decodeURIComponent(params.id!), body.calendar_id);
      return json({ event } satisfies CalendarEventResponse, 201);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/calendar/pending/:id/discard',
    gate: { kind: 'capability', capability: 'calendar', origin: 'trusted', agents: 'refuse' },
    handler: async ({ env, owner, params }) => {
      await discardPendingEvent(env, owner.sub, decodeURIComponent(params.id!));
      return json({ ok: true } satisfies OkResponse);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/calendar/accounts',
    gate: { kind: 'capability', capability: 'calendar', agents: 'refuse' },
    handler: async ({ env, owner }) => json({ accounts: await listCalendarAccounts(env, owner) } satisfies CalendarAccountListResponse),
  }),

  // Attaching a calendar account, never a sign-in: the owner session that
  // authorised this request is the one that stays in force.
  defineRoute({
    method: 'POST',
    path: '/api/calendar/accounts/connect/exchange',
    gate: { kind: 'capability', capability: 'calendar', origin: 'trusted', agents: 'refuse' },
    handler: async ({ request, env, owner }) => {
      const body = calendarConnectExchangeSchema.parse(await readBoundedJSON(request));
      return json(await connectAdditionalCalendarAccount(env, owner, {
        code: body.code,
        codeVerifier: body.code_verifier,
        redirectURI: body.redirect_uri,
        nonce: body.nonce,
      }) satisfies CalendarAccountResponse);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/calendar/accounts/connect/android',
    gate: { kind: 'capability', capability: 'calendar', origin: 'trusted', agents: 'refuse' },
    handler: async ({ request, env, owner }) => {
      const body = calendarAndroidExchangeSchema.parse(await readBoundedJSON(request));
      return json(await connectAdditionalAndroidCalendarAccount(env, owner, body.server_auth_code) satisfies CalendarAccountResponse);
    },
  }),

  // The account id is the rest of the path, as the branch it replaced read it.
  defineRoute({
    method: 'DELETE',
    path: '/api/calendar/accounts/:id',
    params: { id: PARAMS.rest },
    gate: { kind: 'capability', capability: 'calendar', origin: 'trusted', agents: 'refuse' },
    handler: async ({ env, owner, params }) => {
      await removeCalendarAccount(env, owner, decodeURIComponent(params.id!));
      return json({ ok: true } satisfies OkResponse);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/calendar/subscriptions',
    gate: { kind: 'capability', capability: 'calendar', agents: 'refuse' },
    handler: async ({ env, owner }) => json({ subscriptions: await listSubscriptions(env, owner) } satisfies CalendarSubscriptionListResponse),
  }),

  defineRoute({
    method: 'POST',
    path: '/api/calendar/subscriptions',
    gate: { kind: 'capability', capability: 'calendar', origin: 'trusted', agents: 'refuse' },
    handler: async ({ request, env, owner }) => {
      const body = calendarSubscriptionCreateSchema.parse(await readBoundedJSON(request));
      return json({ subscription: await addSubscription(env, owner, body) } satisfies CalendarSubscriptionResponse);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/calendar/subscriptions/events',
    gate: { kind: 'capability', capability: 'calendar', agents: 'refuse' },
    handler: async ({ env, owner, url }) => {
      const query = calendarEventsQuerySchema.parse({
        time_min: url.searchParams.get('time_min') ?? undefined,
        time_max: url.searchParams.get('time_max') ?? undefined,
      });
      return json({
        events: await subscriptionEvents(env, owner, new Date(query.time_min), new Date(query.time_max)),
      } satisfies SubscriptionEventsResponse);
    },
  }),

  defineRoute({
    method: 'DELETE',
    path: '/api/calendar/subscriptions/:id',
    params: { id: PARAMS.rest },
    gate: { kind: 'capability', capability: 'calendar', origin: 'trusted', agents: 'refuse' },
    handler: async ({ env, owner, params }) => {
      await removeSubscription(env, owner, decodeURIComponent(params.id!));
      return json({ ok: true } satisfies OkResponse);
    },
  }),
];
