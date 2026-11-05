import { beginOwnerHostSession, ensureOwnerRoom, roomStub } from '../room-access';
import { requestDeviceID } from '../auth';
import {
  type OwnerHeartbeatResponse,
  type OwnerHostSessionResponse,
  type OwnerRoomResponse,
  PEER_HEARTBEAT_INTERVAL_MILLISECONDS,
  hostSessionStartSchema,
  peerHeartbeatSchema,
} from '../contracts';
import { json, readBoundedJSON } from '../http';
import { hostableRoomsFor, permanentRoomFor } from '../room-access';
import { RoomError } from '../room-coordinator';
import { recordOwnerHeartbeat } from '../usage';
import { parseMeetClientVersion } from '../client-version';
import { defineRoute, type Route } from '../route-types';

export const ownerRoutes: readonly Route[] = [
  // "I have the app open." Cheap, idempotent, and the only thing that makes
  // `active` mean active rather than "signed in once, months ago".
  defineRoute({
    method: 'POST',
    path: '/api/owner/heartbeat',
    gate: { kind: 'capability', capability: 'roster', origin: 'trusted' },
    handler: async ({ request, env, owner }) => {
      const body = peerHeartbeatSchema.parse(await readBoundedJSON(request));
      // The browser names its version in the body; the Mac and the phone
      // already send it in `x-meet-client` on every request.
      const version = body.version ?? parseMeetClientVersion(request.headers.get('x-meet-client'))?.version;
      await recordOwnerHeartbeat(env, owner, body.client ?? 'web', Date.now(), body.timezone, version);
      return json({ ok: true, renew_after_ms: PEER_HEARTBEAT_INTERVAL_MILLISECONDS } satisfies OwnerHeartbeatResponse);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/owner/room',
    gate: { kind: 'capability', capability: 'hosting' },
    handler: async ({ env, owner }) => {
      const slug = await permanentRoomFor(owner, env);
      if (!slug) throw new RoomError('No permanent room is configured for this owner.', 404, 'room_not_found');
      const configuration = await ensureOwnerRoom(env, slug, owner, 'permanent');
      if (configuration.kind !== 'permanent' || configuration.expiresAt !== null) {
        throw new Error('Owner room configuration was not permanent.');
      }
      const room: OwnerRoomResponse['room'] = {
        slug: configuration.slug,
        ownerSub: configuration.ownerSub,
        ownerEmail: configuration.ownerEmail,
        ownerName: configuration.ownerName,
        kind: 'permanent',
        expiresAt: null,
      };
      return json({ room } satisfies OwnerRoomResponse);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/owner/host-session',
    gate: { kind: 'capability', capability: 'hosting', origin: 'trusted' },
    handler: async ({ request, env, ctx, owner }) => {
      const body = hostSessionStartSchema.parse(await readBoundedJSON(request));
      const installID = await requestDeviceID(request, env);
      if (body.room) {
        // A named room: the internal room from Team, on the phone. Any room the
        // owner may host by name is allowed; anything else gets the same 404 an
        // unknown slug gets, so the request cannot probe for rooms.
        // A member offered the host of a colleague's meeting joins it this way
        // too; the Durable Object holds that grant.
        const hostable = (await hostableRoomsFor(owner, env)).has(body.room);
        const hostMember = !hostable && await (await roomStub(env, body.room)).isHostMember(owner.sub);
        if (!hostable && !hostMember) {
          throw new RoomError('Room not found.', 404, 'room_not_found');
        }
        if (!hostMember) await ensureOwnerRoom(env, body.room, owner);
        return json(await beginOwnerHostSession(env, ctx, body.room, owner, body.device, installID) satisfies OwnerHostSessionResponse);
      }
      const slug = await permanentRoomFor(owner, env);
      if (!slug) throw new RoomError('No permanent room is configured for this owner.', 404, 'room_not_found');
      await ensureOwnerRoom(env, slug, owner, 'permanent');
      return json(await beginOwnerHostSession(env, ctx, slug, owner, body.device, installID) satisfies OwnerHostSessionResponse);
    },
  }),
];
