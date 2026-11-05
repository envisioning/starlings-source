import { json } from '../http';
import { defineRoute, type Param, type Route } from '../route-types';
import { cancelManagedBooking, readManagedBooking } from '../booking-public';
import { routeBookingRoomProxy, routePublicEventsProxy, routeScheduleProxy } from '../schedule-proxy';

// The proxies match their own path and method; each row is the door to one of
// them, and the shape of the path says which. A request the row takes the
// proxy always answers, so the 404 here is for a shape the proxy would not.
const NOT_FOUND = () => json({ error: 'Not found.' }, 404);

const SLUG: Param = { re: '[a-z0-9-]{2,40}', sample: 'gates-room' };
const MANAGE_TOKEN: Param = { re: '[A-Za-z0-9_-]{16,128}', sample: 'manage_token_0001' };

/**
 * A guest's booking, read and made without an account (docs/ROOM_ENTRY.md).
 * Core's public projection is what answers; Meet adds the room check and, on
 * the one write, the web origin, a bounded body and Turnstile.
 */
export const bookingRoutes: readonly Route[] = [
  defineRoute({
    method: 'GET',
    path: '/api/schedule/:slug/:action',
    // The row's own `re:` text is what the route inventory reads.
    params: { slug: SLUG, action: { re: 'info|availability|availability-calendar|availability-blocks|events', sample: 'info' } },
    gate: { kind: 'public', reason: 'a room\'s public availability, a projection Core already publishes; only rooms Meet serves answer' },
    handler: async ({ request, env, url }) => (await routeScheduleProxy(request, env, url.pathname)) ?? NOT_FOUND(),
  }),

  defineRoute({
    method: 'POST',
    path: '/api/schedule/:slug/book',
    params: { slug: SLUG },
    gate: { kind: 'public', reason: 'a guest books a slot: web origin, a bounded body and Turnstile, checked in the proxy', origin: 'web' },
    handler: async ({ request, env, url }) => (await routeScheduleProxy(request, env, url.pathname)) ?? NOT_FOUND(),
  }),

  // A guest's own booking, by the manage link in their invite and join card.
  // Booking-page bookings in D1 only; Core keeps its own cancel pages.
  defineRoute({
    method: 'GET',
    path: '/api/schedule/:slug/booking/:token',
    params: { slug: SLUG, token: MANAGE_TOKEN },
    gate: { kind: 'public', reason: 'the manage token is the capability; it answers with that booking\'s window and the guest\'s own name' },
    // By the row, not the store: a D1 booking's link keeps working if the
    // workspace goes back to Core (docs/CORE_FOLD_PLAN.md §Phase 3d rollback).
    handler: async ({ env, params }) => readManagedBooking(env, params.slug!, params.token!),
  }),

  defineRoute({
    method: 'POST',
    path: '/api/schedule/:slug/booking/:token/cancel',
    params: { slug: SLUG, token: MANAGE_TOKEN },
    gate: { kind: 'public', reason: 'the manage token is the capability; the web origin only', origin: 'web' },
    handler: async ({ env, params }) => cancelManagedBooking(env, params.slug!, params.token!),
  }),

  defineRoute({
    method: 'GET',
    path: '/api/public/events',
    gate: { kind: 'public', reason: 'the published Envisioning events, a projection Core already publishes' },
    handler: async ({ request, env, url }) => (await routePublicEventsProxy(request, env, url.pathname)) ?? NOT_FOUND(),
  }),

  defineRoute({
    method: 'GET',
    path: '/api/bookings/:token/room',
    params: { token: { re: '[A-Za-z0-9_-]{8,128}', sample: 'booking_token' } },
    gate: { kind: 'public', reason: 'the booking token is the capability; it answers only with a room slug Meet serves' },
    handler: async ({ request, env, url }) => (await routeBookingRoomProxy(request, env, url.pathname)) ?? NOT_FOUND(),
  }),
];
