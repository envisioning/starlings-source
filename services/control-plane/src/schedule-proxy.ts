import type { CalendarAvailabilityBlock, StarlingsMintedBookingProjection } from '@starlings/contracts/calendar';
import { roomSlugSchema } from './contracts';
import { isPublicRoom } from './member-rooms';
import { assertWebOrigin, readBoundedText } from './http';
import { assertHumanJsonBody } from './turnstile';
import { loadMeetMintedBooking, meetMintedBookingSlug } from './calendar';
import { bookingStore, coreApiOrigin, usesCore } from './work-store';
import { mergeSlotsIntoBlocks } from './booking-slots';
import { readWorkspaceDefaults, workspaceDefaults } from './workspace-defaults';
import { publicEventsFeedSchema } from '@starlings/contracts/workspace-defaults';
import { routeD1Schedule } from './booking-public';
import { workModelEnabled } from './crm';
import { resolveSessionToken, sessionEventById } from './event-signups';

type CoreJson = Record<string, unknown>;

/**
 * Every request below is unsigned, so the workspace check is the only thing
 * between another workspace and Envisioning's Core ( audit). Each
 * route answers from D1 or says not found before it gets here; this throw is
 * the backstop.
 */
function coreOrigin(env: Env): string {
  return coreApiOrigin(env);
}

/** On-the-hour slots only (matches the organisation's site meet filter). */
export function filterOnTheHourSlots<T extends { start: string }>(
  slots: T[],
  timezone?: string | null,
): T[] {
  return filterBookingSlots(slots, timezone, 60);
}

export function filterBookingSlots<T extends { start: string }>(slots: T[], timezone: string | null | undefined, step: number): T[] {
  return slots.filter(slot => isOnBookingGrid(slot.start, timezone, step));
}

function isOnBookingGrid(iso: string, timezone: string | null | undefined, step: number): boolean {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return false;
  if (!timezone) {
    return (date.getUTCHours() * 60 + date.getUTCMinutes()) % step === 0 && date.getUTCSeconds() === 0;
  }
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(date);
    const hour = Number(parts.find((part) => part.type === 'hour')?.value) % 24;
    const minute = Number(parts.find((part) => part.type === 'minute')?.value);
    const second = Number(parts.find((part) => part.type === 'second')?.value);
    return (hour * 60 + minute) % step === 0 && second === 0;
  } catch {
    return (date.getUTCHours() * 60 + date.getUTCMinutes()) % step === 0 && date.getUTCSeconds() === 0;
  }
}

/**
 * Proxy public CRM scheduling APIs from the Core host for mapped Meet slugs.
 * Paths: /api/schedule/:slug/(info|availability|availability-calendar|book|events)
 *
 * `events` is the shared public-events projection Core also embeds in
 * `availability-calendar`; Meet's Schedule screen reads the embedded copy, so
 * the standalone route exists for clients that want events without availability.
 */
export async function routeScheduleProxy(
  request: Request,
  env: Env,
  path: string,
): Promise<Response | null> {
  const match = path.match(
    /^\/api\/schedule\/([a-z0-9-]{2,40})\/(info|availability|availability-calendar|availability-blocks|book|events)\/?$/u,
  );
  if (!match) return null;

  const slug = roomSlugSchema.parse(match[1]);
  const action = match[2];
  // Envisioning books through Core until BOOKING_STORE flips it; every other
  // workspace answers from D1 (booking-public.ts), where the room comes from
  // the member's `people` row.
  if (bookingStore(env) === 'd1') return routeD1Schedule(request, env, slug, action ?? '');
  if (!(await isPublicRoom(env, slug))) {
    return jsonError('Not found.', 404);
  }

  const incoming = new URL(request.url);
  const target = new URL(`${coreOrigin(env)}/api/meet/${slug}/${action}`);
  for (const [key, value] of incoming.searchParams) {
    target.searchParams.set(key, value);
  }

  if (action === 'book') {
    if (request.method !== 'POST') return jsonError('Method not allowed.', 405);
    // Unauthenticated POST: origin, bound body, then the same Turnstile gate
    // as join/feedback. Strip the token before Core — it is a Meet field.
    assertWebOrigin(request, env);
    const body = await assertHumanJsonBody(request, env, await readBoundedText(request));
    const upstream = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body,
    });
    return forwardJson(upstream);
  }

  if (request.method !== 'GET') return jsonError('Method not allowed.', 405);

  const upstream = await fetch(target, {
    method: 'GET',
    headers: { accept: 'application/json' },
  });

  if (action === 'availability' && upstream.ok) {
    const data = (await upstream.json()) as CoreJson & { slots?: Array<{ start: string; end: string }> };
    const timezone = incoming.searchParams.get('timezone');
    if (Array.isArray(data.slots)) {
      data.slots = filterBookingSlots(data.slots, timezone, (await workspaceDefaults(env)).booking_slot_minutes ?? 60);
    }
    return Response.json(data, {
      status: upstream.status,
      headers: { 'cache-control': 'no-store' },
    });
  }

  return forwardJson(upstream);
}

/** One stretch of the owner's open time, as Core computes it. */
export type AvailabilityBlock = CalendarAvailabilityBlock;

/**
 * The owner's bookable time in a date range, for their own calendar. Core has
 * no ranged "give me blocks" route — only the per-day `availability` route
 * the public booking page itself calls — so this asks it once per day in the
 * range and unions the discrete slots it gets back into contiguous blocks.
 * Unsigned, like the schedule proxy above: the slug is the Worker's to pick,
 * never the client's.
 */
export async function fetchAvailabilityBlocks(
  env: Env,
  slug: string,
  range: { start: string; end: string },
): Promise<AvailabilityBlock[]> {
  if (!usesCore(env)) return [];
  const days = datesInRange(range.start, range.end);
  const perDay = await Promise.all(days.map((date) => fetchDaySlots(env, slug, date)));
  return mergeSlotsIntoBlocks(perDay.flat());
}

async function fetchDaySlots(env: Env, slug: string, date: string): Promise<AvailabilityBlock[]> {
  const target = new URL(`${coreOrigin(env)}/api/meet/${slug}/availability`);
  target.searchParams.set('date', date);
  const upstream = await fetch(target, {
    method: 'GET',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!upstream.ok) {
    throw new Error(`Core availability answered ${upstream.status} for ${date}.`);
  }
  const data = (await upstream.json()) as CoreJson & { slots?: unknown };
  if (!Array.isArray(data.slots)) return [];
  return data.slots.filter(isAvailabilityBlock);
}

/** `YYYY-MM-DD` strings, both ends inclusive. Plain calendar dates — no
 * timezone in play, so this stays UTC-noon-of-nothing simple. */
function datesInRange(start: string, end: string): string[] {
  const dates: string[] = [];
  let cursor = Date.parse(`${start}T00:00:00Z`);
  const last = Date.parse(`${end}T00:00:00Z`);
  while (cursor <= last) {
    dates.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += 24 * 60 * 60 * 1000;
  }
  return dates;
}

function isAvailabilityBlock(value: unknown): value is AvailabilityBlock {
  return typeof value === 'object'
    && value !== null
    && typeof (value as AvailabilityBlock).start === 'string'
    && typeof (value as AvailabilityBlock).end === 'string';
}

/**
 * Guest-safe slice of a booking, shown on the join card behind an invite
 * token: `meetMintedBookingProjectionSchema`
 * in the contracts, the one shape the web, Mac and iPhone decode.
 */
export type PublicBookingProjection = StarlingsMintedBookingProjection;

/**
 * Where Core serves its guest-facing pages. Same host as the API by default,
 * which is the deployed shape; set it when pages and API are split so the join
 * card links somewhere a guest can actually load.
 */
function coreWebOrigin(env: Env): string {
  return (env.CORE_WEB_ORIGIN || coreOrigin(env)).replace(/\/$/, '');
}

/**
 * `unknown` is a token Core does not recognize (or one minted for another
 * room); `unavailable` is Core being unreachable or malformed. The join card
 * treats the first as an expired link and the second as no card at all — a
 * Core outage must never read to the guest as "your invite was cancelled".
 */
export type BookingLookup =
  | { outcome: 'found'; projection: PublicBookingProjection }
  | { outcome: 'unknown' }
  | { outcome: 'unavailable' };

/**
 * Resolve an invite token to its public projection. Meet re-projects the
 * upstream body field by field rather than forwarding it, so a column added to
 * Core's response later cannot reach a guest through this door.
 */
export async function fetchPublicBookingProjection(
  env: Env,
  slug: string,
  token: string,
): Promise<BookingLookup> {
  if (!usesCore(env)) return mintedBookingLookup(env, slug, token);
  // A token Meet minted answers from Meet first, so a booking made in D1
  // opens its card while Core is down. Core never issues Meet's tokens.
  const minted = await loadMeetMintedBooking(env, slug, token);
  if (minted) return { outcome: 'found', projection: minted };
  const target = `${coreOrigin(env)}/api/meet/${slug}/booking/${encodeURIComponent(token)}/public`;
  let upstream: Response;
  try {
    upstream = await fetch(target, { method: 'GET', headers: { accept: 'application/json' } });
  } catch {
    return { outcome: 'unavailable' };
  }
  if (upstream.status === 404) return mintedBookingLookup(env, slug, token);
  if (!upstream.ok) return { outcome: 'unavailable' };

  const body = (await upstream.json().catch(() => null)) as { booking?: unknown } | null;
  const projection = readProjection(body?.booking, coreWebOrigin(env));
  return projection ? { outcome: 'found', projection } : { outcome: 'unavailable' };
}

function readProjection(value: unknown, webOrigin: string): PublicBookingProjection | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Record<string, unknown>;
  const status = row.status;
  if (status !== 'scheduled' && status !== 'cancelled') return null;
  return {
    title: stringOrNull(row.title),
    subject: stringOrNull(row.subject),
    starts_at: stringOrNull(row.starts_at),
    ends_at: stringOrNull(row.ends_at),
    status,
    reschedule_url: coreLink(row.reschedule_path, webOrigin),
    cancel_url: coreLink(row.cancel_path, webOrigin),
    // Core does not project these yet; null until it does.
    guest_name: stringOrNull(row.guest_name),
    guest_email: stringOrNull(row.guest_email),
  };
}

/**
 * Turn a Core-supplied path into a link on Core's own origin. Meet owns the
 * origin, so nothing Core returns can point the join card at another host —
 * `//evil.example` and any absolute URL are rejected rather than resolved.
 */
function coreLink(value: unknown, webOrigin: string): string | null {
  const path = stringOrNull(value);
  if (!path || !path.startsWith('/') || path.startsWith('//')) return null;
  return `${webOrigin}${path}`;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/** A booking Meet minted itself, in D1: what a token resolves to when Core does not know it, or is not used. */
async function mintedBookingLookup(env: Env, slug: string, token: string): Promise<BookingLookup> {
  const minted = await loadMeetMintedBooking(env, slug, token);
  return minted ? { outcome: 'found', projection: minted } : registrationLookup(env, slug, token);
}

/**
 * A token no booking knows may be an event registration (docs/SESSIONS.md §0,
 *). The seam answers on both stores, so a link mailed before the
 * fold resolves the same after it (F4). A cancelled registration, or one for
 * another room, is unknown. The card shows the event's title and window and
 * the registrant's own name, never an address.
 */
async function registrationLookup(env: Env, slug: string, token: string): Promise<BookingLookup> {
  if (!workModelEnabled(env)) return { outcome: 'unknown' };
  try {
    const registration = await resolveSessionToken(env, token);
    if (!registration || registration.status !== 'registered') return { outcome: 'unknown' };
    const event = await sessionEventById(env, registration.event_id);
    if (!event || event.room_slug !== slug) return { outcome: 'unknown' };
    return {
      outcome: 'found',
      projection: {
        title: event.title,
        subject: null,
        starts_at: event.starts_at,
        ends_at: event.ends_at,
        status: 'scheduled',
        reschedule_url: null,
        cancel_url: null,
        guest_name: registration.name || null,
        guest_email: null,
        session: true,
      },
    };
  } catch {
    // The store did not answer: no card at all, never an expired one.
    return { outcome: 'unavailable' };
  }
}

/** The workspace's configured public JSON projection, without a room or owner session. */
export async function routePublicEventsProxy(
  request: Request,
  env: Env,
  path: string,
): Promise<Response | null> {
  if (path !== '/api/public/events' && path !== '/api/public/events/') return null;
  if (request.method !== 'GET') return jsonError('Method not allowed.', 405);
  const settings = await readWorkspaceDefaults(env);
  const feed = settings.defaults.public_events_feed;
  // A deliberate off clears client snapshots; an unconfigured D1 workspace retains its old 404.
  if (!feed) return settings.source === 'settings'
    ? Response.json({ events: [] }, { headers: { 'cache-control': 'no-store' } })
    : jsonError('Not found.', 404);
  const incoming = new URL(request.url);
  const target = new URL(feed);
  for (const key of ['startDate', 'endDate']) {
    const value = incoming.searchParams.get(key);
    if (value) target.searchParams.set(key, value);
  }

  try {
    // Workers fetch throws on redirect: 'error'. 'manual' makes a 3xx not ok, so it answers 502.
    const response = await fetch(target, { method: 'GET', headers: { accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(5000) });
    if (!response.ok) return jsonError('Events are unavailable right now.', 502);
    const data = publicEventsFeedSchema.parse(JSON.parse(await readBoundedText(response, 512 * 1024)));
    return Response.json(data, { headers: { 'cache-control': 'no-store' } });
  } catch {
    return jsonError('Events are unavailable right now.', 502);
  }
}

/**
 * `GET /api/bookings/:token/room` — which room a booking token opens.
 *
 * Lets the join box accept a bare token as a shortcut to the guest's own
 * meeting. Answers only with a slug Meet actually serves: an unmapped room
 * reads as unknown, so this can never point someone at a door that is not
 * ours.
 */
export async function routeBookingRoomProxy(
  request: Request,
  env: Env,
  path: string,
): Promise<Response | null> {
  const match = path.match(/^\/api\/bookings\/([A-Za-z0-9_-]{8,128})\/room\/?$/u);
  if (!match) return null;
  if (request.method !== 'GET') return jsonError('Method not allowed.', 405);

  const token = match[1]!;
  if (!usesCore(env)) return mintedBookingRoom(env, token);
  // Meet's own token first, as for the card: no Core round trip, no Core outage.
  if (await meetMintedBookingSlug(env, token)) return mintedBookingRoom(env, token);
  let upstream: Response;
  try {
    upstream = await fetch(
      `${coreOrigin(env)}/api/public/bookings/${encodeURIComponent(token)}/room`,
      { method: 'GET', headers: { accept: 'application/json' } },
    );
  } catch {
    return jsonError('Booking lookup unavailable.', 502);
  }
  if (upstream.status === 404) return mintedBookingRoom(env, token);
  if (!upstream.ok) return jsonError('Booking lookup unavailable.', 502);

  const body = (await upstream.json().catch(() => null)) as
    | { room?: { username_slug?: unknown } }
    | null;
  const slug = body?.room?.username_slug;
  if (typeof slug !== 'string' || !(await isPublicRoom(env, slug))) {
    return jsonError('Not found.', 404);
  }
  return Response.json({ slug }, { headers: { 'cache-control': 'no-store' } });
}

/** The room of a booking Meet minted itself, when it is one of this workspace's rooms. */
async function mintedBookingRoom(env: Env, token: string): Promise<Response> {
  const mintedSlug = await meetMintedBookingSlug(env, token);
  if (mintedSlug && await isPublicRoom(env, mintedSlug)) {
    return Response.json({ slug: mintedSlug }, { headers: { 'cache-control': 'no-store' } });
  }
  return jsonError('Not found.', 404);
}

async function forwardJson(upstream: Response): Promise<Response> {
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
      'cache-control': 'no-store',
    },
  });
}

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status, headers: { 'cache-control': 'no-store' } });
}
