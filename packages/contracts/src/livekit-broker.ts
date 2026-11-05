/**
 * The LiveKit token broker (docs/CENTRAL_AUTH.md "The LiveKit
 * broker"). Every workspace but Envisioning calls on Envisioning's LiveKit
 * project, and none of them holds its key. The key is in one Worker,
 * `starlings-auth`, which answers a workspace over a service binding named
 * `LIVEKIT` (entrypoint `LiveKitService`). The binding's `props.origin`
 * names the workspace, as the `AUTH` binding's does; no argument can. The
 * broker signs only for rooms under that workspace's prefix, so one
 * workspace cannot join or administer another's rooms, nor Envisioning's.
 *
 * LiveKit has no API that makes a project or a key pair (2026-10-15), so a
 * project per workspace would be a step by hand at every signup. The broker
 * makes a new workspace need nothing.
 *
 * `zod/mini` and no import from the contracts index: the auth Worker bundles
 * this file (see browser-auth.ts).
 */
import * as z from 'zod/mini';

/**
 * The broker handoff version (docs/DEPLOY_STRATEGY.md rule 6). The auth
 * Worker deploys first, so when this moves to 2 it accepts 1 and 2 for one
 * release.
 */
export const LIVEKIT_BROKER_VERSION = 1;
const brokerVersion = z.literal(LIVEKIT_BROKER_VERSION);

/** A room JWT lives this long. Long enough for 1h+ meetings; clients refresh before it ends. */
export const LIVEKIT_PARTICIPANT_TTL_SECONDS = 7_200;
/** A RoomService call's admin token: one room, one minute. */
export const LIVEKIT_ADMIN_TTL_SECONDS = 60;

/**
 * The prefix of every room a brokered workspace makes. Envisioning's rooms
 * start with `meet-`, and a workspace slug has no dot, so no prefix covers
 * another workspace's rooms or Envisioning's.
 */
export function liveKitRoomPrefix(workspace: string): string {
  return `ws.${workspace}.`;
}

/** What the `LIVEKIT` binding carries as `props`: the workspace origin alone. */
export const liveKitBindingPropsSchema = z.strictObject({ origin: z.string().check(z.minLength(8), z.maxLength(300)) });
export type LiveKitBindingProps = z.infer<typeof liveKitBindingPropsSchema>;

const roomName = z.string().check(z.minLength(1), z.maxLength(200));

/** `participant`: a token to join one room. The grants are the broker's, fixed; the workspace names who and where. */
export const liveKitParticipantInputSchema = z.strictObject({
  v: brokerVersion,
  room: roomName,
  identity: z.string().check(z.minLength(1), z.maxLength(200)),
  name: z.string().check(z.maxLength(200)),
  /** `ParticipantMetadata` as JSON. Read-only in the room: the token does not let the participant change it. */
  metadata: z.string().check(z.maxLength(4000)),
});
export type LiveKitParticipantInput = z.infer<typeof liveKitParticipantInputSchema>;

/** `admin`: a one-minute RoomService token for one room. */
export const liveKitAdminInputSchema = z.strictObject({ v: brokerVersion, room: roomName });
export type LiveKitAdminInput = z.infer<typeof liveKitAdminInputSchema>;

export const LIVEKIT_BROKER_REFUSALS = ['origin_refused', 'invalid_request', 'room_refused', 'not_configured'] as const;

export const liveKitTokenResultSchema = z.union([
  z.object({ ok: z.literal(true), token: z.string().check(z.minLength(1)), expiresAt: z.number() }),
  z.object({ ok: z.literal(false), reason: z.enum(LIVEKIT_BROKER_REFUSALS) }),
]);
export type LiveKitTokenResult = z.infer<typeof liveKitTokenResultSchema>;
