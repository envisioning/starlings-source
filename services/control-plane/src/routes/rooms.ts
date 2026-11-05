import type { StarlingsMintedBookingProjection } from '@starlings/contracts/calendar';
import { AuthError, bearerToken, requestDeviceID } from '../auth';
import { optionalSession } from '../capabilities';
import {
  type ConnectionDetails,
  type GuestPresenceRemoveResponse,
  type JoinRequestReceipt,
  type JoinStatusResponse,
  type LobbyDecisionResponse,
  type LobbySnapshotResponse,
  type OkResponse,
  type PublicRoomResponse,
  type RoomSettings,
  decisionSchema,
  guestPresenceSchema,
  hostSessionStartSchema,
  joinRequestSchema,
  lobbyExchangeSchema,
  lobbySocketQuerySchema,
  roomSettingsUpdateSchema,
  roomSlugSchema,
} from '../contracts';
import { assertUnderRateLimit, json, readBoundedJSON } from '../http';
import { isInternalRoomSlug } from '../internal-rooms';
import { isPublicRoom } from '../member-rooms';
import { eventCountry, recordUsageEvent } from '../ledger';
import { defineRoute, PARAMS, type Param, type Route } from '../route-types';
import { parseQuery } from '../route-util';
import { beginOwnerHostSession, ensureOwnerRoom, issueConnection, roomStub } from '../room-access';
import { fetchPublicBookingProjection } from '../schedule-proxy';
import { refreshRosterBeforeKnock } from '../session-arming';
import type { SessionDoorResponse } from '@starlings/contracts';
import { assertHuman } from '../turnstile';

/** The room a path names. The slug is checked against the contract here, as it was when the room router read it. */
export async function roomOf(env: Env, params: Readonly<Record<string, string>>) {
  const slug = roomSlugSchema.parse(params.slug);
  return { slug, room: await roomStub(env, slug) };
}

export const ROOM_SLUG: Param = { re: '[a-z0-9-]{2,40}', sample: 'gates-room' };

/**
 * Entering a room, the lobby, and the host's own controls over it
 * (docs/ROOM_ENTRY.md). A guest's doors say what proves them; the host's and
 * the owner's rows name the gate that checks the session and the room.
 */
export const roomsRoutes: readonly Route[] = [
  defineRoute({
    method: 'GET',
    path: '/api/rooms/:slug',
    params: { slug: ROOM_SLUG },
    gate: { kind: 'public', reason: 'the first request every guest and member makes: the owner\'s display name only, never an email or whether they are online' },
    handler: async ({ request, env, params }) => {
      const { slug, room } = await roomOf(env, params);
      // The internal room answers members and nobody else, with the same 404 an
      // unconfigured slug gets — a 403 here would confirm the room exists, which
      // is the one fact it is keeping. `internal` lets the client drop the parts
      // of Room entry that only make sense for a visitor.
      if (isInternalRoomSlug(env, slug)) {
        const member = await optionalSession(request, env, 'hosting');
        if (!member) return json({ error: 'Not found.' }, 404);
        const internalConfiguration = await room.roomConfiguration();
        // `you` is what removes the song and dance: the member is already
        // identified by the session that got them this far, so Room entry has
        // nothing left to ask them. It is their own identity echoed back, never
        // anybody else's — this route answers one session at a time.
        return json({
          slug,
          kind: 'permanent',
          internal: true,
          owner_name: internalConfiguration?.ownerName ?? null,
          you: { name: member.name, email: member.email },
        } satisfies PublicRoomResponse);
      }
      if (!(await isPublicRoom(env, slug))) {
        return json({ error: 'Not found.' }, 404);
      }
      // The owner's display name only — guests are told whose room they are
      // knocking at, never the owner's email or whether they are online.
      const configuration = await room.roomConfiguration();
      // A signed-in member is already identified, on any room and through any
      // door — bare slug or invite token — so Room entry has nothing to ask
      // them. Their own identity echoed back, never anybody else's.
      const member = await optionalSession(request, env, 'hosting');
      return json({
        slug,
        kind: 'permanent',
        owner_name: configuration?.ownerName ?? null,
        ...(member ? { you: { name: member.name, email: member.email } } : {}),
      } satisfies PublicRoomResponse);
    },
  }),

  // Public, unauthenticated: the invite token *is* the capability. Holding it
  // reveals that booking's title and window; the bare slug above reveals
  // neither, even while a titled meeting is live. See docs/ROOM_ENTRY.md.
  defineRoute({
    method: 'GET',
    path: '/api/rooms/:slug/bookings/:token',
    params: { slug: ROOM_SLUG, token: { re: '[A-Za-z0-9_-]{8,128}', sample: 'booking_token' } },
    gate: { kind: 'public', reason: 'the invite token is the capability: holding it reveals that booking\'s title and window, nothing else' },
    handler: async ({ env, params }) => {
      const { slug } = await roomOf(env, params);
      // The internal room has no booking door, so no token can have been minted
      // against it. Stated rather than left to fall out of the narrower set
      // below, because "it 404s because we happen not to widen a Set" is exactly
      // the reasoning that stops being true when somebody widens the Set.
      if (isInternalRoomSlug(env, slug)) return json({ error: 'Not found.' }, 404);
      if (!(await isPublicRoom(env, slug))) {
        return json({ error: 'Not found.' }, 404);
      }
      const lookup = await fetchPublicBookingProjection(env, slug, params.token!);
      if (lookup.outcome === 'unknown') return json({ error: 'Not found.' }, 404);
      // Never fall back to the live meeting's title when Core is unreachable —
      // the guest gets the opaque door instead of someone else's agenda.
      if (lookup.outcome === 'unavailable') return json({ error: 'Booking lookup unavailable.' }, 502);
      return json(lookup.projection satisfies StarlingsMintedBookingProjection);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/rooms/:slug/start',
    params: { slug: ROOM_SLUG },
    gate: { kind: 'room-host', origin: 'trusted' },
    handler: async ({ request, env, ctx, owner, params }) => {
      const { slug } = await roomOf(env, params);
      const body = hostSessionStartSchema.parse(await readBoundedJSON(request));
      const installID = await requestDeviceID(request, env);
      const session = await beginOwnerHostSession(env, ctx, slug, owner, body.device, installID);
      // Preserve the flat macOS response while the mapped owner endpoint exposes
      // the additional lease/caption contract needed by a future iOS host UI.
      return json(session.connection satisfies ConnectionDetails);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/rooms/:slug/lobby',
    params: { slug: ROOM_SLUG },
    gate: { kind: 'room-host' },
    handler: async ({ env, owner, params }) => json(await (await roomOf(env, params)).room.lobbySnapshot(owner.sub) satisfies LobbySnapshotResponse),
  }),

  // The host closes the second door for the rest of an event session
  // (docs/SESSIONS.md §7): registration links stop admitting and knock again.
  defineRoute({
    method: 'POST',
    path: '/api/rooms/:slug/session/door',
    params: { slug: ROOM_SLUG },
    gate: { kind: 'room-host', origin: 'trusted' },
    handler: async ({ env, owner, params }) => json(await (await roomOf(env, params)).room.closeSessionDoor(owner.sub) satisfies SessionDoorResponse),
  }),

  defineRoute({
    method: 'PATCH',
    path: '/api/rooms/:slug/settings',
    params: { slug: ROOM_SLUG },
    gate: { kind: 'room-owner', origin: 'trusted' },
    handler: async ({ request, env, owner, params }) => {
      const body = roomSettingsUpdateSchema.parse(await readBoundedJSON(request));
      return json(await (await roomOf(env, params)).room.setRoomSettings(owner.sub, body) satisfies RoomSettings);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/rooms/:slug/lobby/socket',
    params: { slug: ROOM_SLUG },
    gate: { kind: 'guest', proof: 'a member session, or the lobby token and request id a knock was given' },
    handler: async ({ request, env, url, params }) => {
      const { slug, room } = await roomOf(env, params);
      const headers = new Headers(request.headers);
      const owner = await optionalSession(request, env, 'hosting');
      if (owner) {
        await ensureOwnerRoom(env, slug, owner);
        headers.set('x-meet-role', 'owner');
        headers.set('x-meet-owner-sub', owner.sub);
      } else {
        const query = parseQuery(lobbySocketQuerySchema, url);
        headers.set('x-meet-role', 'guest');
        headers.set('x-meet-request-id', query.request_id);
        headers.set('x-meet-lobby-token', query.token);
      }
      return room.fetch(new Request(request, { headers }));
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/rooms/:slug/join-requests',
    params: { slug: ROOM_SLUG },
    gate: { kind: 'public', origin: 'web', reason: 'a guest knocks: web origin, a per-room rate limit and Turnstile; the owner still admits them' },
    handler: async ({ request, env, ctx, params }) => {
      const { slug, room } = await roomOf(env, params);
      // Membership is the admission on the internal room: a knock from anyone
      // else is refused as not-found before any work is done. A member still goes
      // through `requestJoin` below — `memberAdmission` is what lets them
      // straight in — so there is one admission rule here, not a second one.
      const knocker = await optionalSession(request, env, 'hosting');
      if (isInternalRoomSlug(env, slug) && !knocker) {
        // A bearer that no longer verifies is a member with a stale token, not
        // a stranger: answer `owner_auth_required` so the native clients renew
        // and knock again. Only a knock with no session at all is refused as
        // not-found.
        if (bearerToken(request)) throw new AuthError('Not authenticated.', 401, 'owner_auth_required');
        return json({ error: 'Not found.' }, 404);
      }
      const input = joinRequestSchema.parse(await readBoundedJSON(request));
      // Per room and address: a venue is one address, and a full room's worth
      // of knocks from it in a minute is the case to allow.
      await assertUnderRateLimit(env.JOIN_LIMIT, request, 'join', slug);
      // Browser knocks must solve Turnstile once the secret exists. Native
      // URLSession knocks have no widget and no Fetch Metadata — skip them so
      // flipping the secret does not 403 shipped Mac/iOS builds. See turnstile.ts.
      // Declared notetakers are expected headless browsers. They still pass the
      // room and address rate limits and remain behind owner admission.
      if (!input.recording) await assertHuman(request, env, input.turnstile_token, 'browser');
      // A verified Envisioning member knocking on a colleague's room is not a
      // visitor asking to be let in — both sides are the same org, proved by the
      // same Google identity. Skipping the queue is what makes "Call" a call
      // instead of a request. The room still decides: this is a hint, and the
      // coordinator only honours it while a meeting is actually running.
      let verifiedOnBehalfOf: string | null = null;
      if (input.recording && input.booking_token) {
        const booking = await fetchPublicBookingProjection(env, slug, input.booking_token);
        if (booking.outcome === 'found' && booking.projection.status === 'scheduled') {
          verifiedOnBehalfOf = booking.projection.guest_email;
        }
      }
      // A knock with a token may be an event registration: the room's roster
      // of token hashes is fetched again first when it is a minute old.
      if (input.booking_token && !input.recording) await refreshRosterBeforeKnock(env, slug);
      const receipt = await room.requestJoin(input, knocker?.email ?? null, verifiedOnBehalfOf);
      ctx.waitUntil(recordUsageEvent(env, {
        kind: 'knock',
        room_slug: slug,
        actor_kind: knocker ? 'owner' : 'guest',
        client_app: input.client?.app ?? null,
        country: eventCountry(request),
      }));
      return json(receipt satisfies JoinRequestReceipt, 201);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/rooms/:slug/guest-presence',
    params: { slug: ROOM_SLUG },
    gate: { kind: 'public', origin: 'web', reason: 'a guest\'s 15 s heartbeat before the knock: web origin and a per-room rate limit, never a challenge' },
    handler: async ({ request, env, params }) => {
      const { slug, room } = await roomOf(env, params);
      // No pre-knock presence on the internal room. Nobody reaches its page
      // without a session, so a row here would describe a population that cannot
      // exist — and this table is what the abandon sweep counts, so writing one
      // would put phantom visitors in the funnel as well as on the host's screen.
      if (isInternalRoomSlug(env, slug)) return json({ error: 'Not found.' }, 404);
      const input = guestPresenceSchema.parse(await readBoundedJSON(request));
      // Rate limited but never bot-checked: this is a 15s heartbeat, and a
      // challenge on a heartbeat would fire mid-meeting for no benefit. Per
      // room and address, sized for a full room behind one venue's NAT.
      await assertUnderRateLimit(env.PRESENCE_LIMIT, request, 'presence', slug);
      const cf = request.cf;
      const city = typeof cf?.city === 'string' && cf.city.trim() ? cf.city.trim() : null;
      const country = typeof cf?.country === 'string' && cf.country.trim() ? cf.country.trim() : null;
      await room.upsertGuestPresence({
        presenceId: input.presence_id,
        stage: input.stage,
        name: input.name ?? null,
        city,
        country,
        bookingToken: input.booking_token ?? null,
        client: input.client ?? null,
      });
      return json({ ok: true } satisfies OkResponse);
    },
  }),

  // Host closing a lurker's connection: they have no live socket pre-knock,
  // so this deletes the row and blocks the tab from re-announcing — see
  // `removeGuestPresence` for why that's the whole affordance here.
  defineRoute({
    method: 'POST',
    path: '/api/rooms/:slug/guest-presence/:presenceId/remove',
    params: { slug: ROOM_SLUG, presenceId: PARAMS.uuid },
    gate: { kind: 'room-host', origin: 'trusted' },
    handler: async ({ env, owner, params }) => {
      await (await roomOf(env, params)).room.removeGuestPresence(owner.sub, params.presenceId!);
      return json({ removed: true } satisfies GuestPresenceRemoveResponse);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/rooms/:slug/join-requests/:requestId',
    params: { slug: ROOM_SLUG, requestId: PARAMS.uuid },
    gate: { kind: 'guest', proof: 'the lobby token the knock was given, in the Authorization header or the query' },
    handler: async ({ request, env, url, params }) => {
      // Prefer the Authorization header — URLs land in traces and proxy logs.
      // The query form remains for older clients.
      const token = bearerToken(request) ?? url.searchParams.get('token') ?? '';
      return json(await (await roomOf(env, params)).room.joinStatus(params.requestId!, token) satisfies JoinStatusResponse);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/rooms/:slug/join-requests/:requestId/decision',
    params: { slug: ROOM_SLUG, requestId: PARAMS.uuid },
    gate: { kind: 'room-host', origin: 'trusted' },
    handler: async ({ request, env, ctx, owner, params }) => {
      const { slug, room } = await roomOf(env, params);
      const body = decisionSchema.parse(await readBoundedJSON(request));
      if (body.on_behalf_of && !(await env.USAGE.prepare(
        "SELECT 1 AS found FROM people WHERE lower(email) = lower(?1) AND kind = 'human'",
      ).bind(body.on_behalf_of).first())) {
        throw new AuthError('Choose a person from the team roster.', 400, 'person_not_found');
      }
      const decided = await room.decide(owner.sub, params.requestId!, body.admit, body.on_behalf_of);
      ctx.waitUntil(recordUsageEvent(env, {
        kind: body.admit ? 'admit' : 'reject',
        room_slug: slug,
        actor_kind: 'owner',
      }));
      return json({ request: decided } satisfies LobbyDecisionResponse);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/rooms/:slug/join-requests/:requestId/exchange',
    params: { slug: ROOM_SLUG, requestId: PARAMS.uuid },
    gate: { kind: 'guest', origin: 'web', proof: 'the lobby token the knock was given, checked against the admitted request' },
    handler: async ({ request, env, params }) => {
      const { slug, room } = await roomOf(env, params);
      const body = lobbyExchangeSchema.parse(await readBoundedJSON(request));
      const admission = await room.exchangeAdmission(params.requestId!, body.lobby_token);
      const connection = await issueConnection(env, slug, {
        meetingId: admission.meetingId,
        livekitRoom: admission.livekitRoom,
        startedAt: admission.startedAt,
        role: 'guest',
        participant: {
          identity: admission.identity,
          name: admission.name,
          email: admission.email,
          owner: false,
          client: admission.client,
          on_behalf_of: admission.on_behalf_of,
          recording: admission.recording,
          registered: admission.registered,
        },
      });
      // The session posture rides the connection (docs/SESSIONS.md §8).
      return json({ ...connection, ...(admission.session ? { session: true } : {}) } satisfies ConnectionDetails);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/rooms/:slug/presence',
    params: { slug: ROOM_SLUG },
    gate: { kind: 'room-owner', origin: 'trusted' },
    handler: async ({ env, owner, params }) => {
      await (await roomOf(env, params)).room.touchPresence(owner.sub);
      return json({ ok: true } satisfies OkResponse);
    },
  }),
];
