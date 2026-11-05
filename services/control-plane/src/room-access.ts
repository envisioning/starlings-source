import { isSameMember } from './workspace-identity';
import { roomOfMember } from './member-rooms';
import { sessionAgent } from './agent-boundary';
import { roomStub } from './do-jurisdiction';
import { AuthError, getArtifactPrincipal, signArtifactPrincipal } from './auth';
import { type Capability, requireCapability } from './capabilities';
import {
  CAPTION_DATA_TOPIC,
  type ConnectionDetails,
  HOST_HEARTBEAT_INTERVAL_MILLISECONDS,
  type HostDevice,
  type HostMessage,
  type HostMutationResponse,
  type LegacyChairMutationResponse,
  type OwnerHostSessionResponse,
  deviceScopedOwnerIdentity,
  hostDeviceClient,
} from './contracts';
import { syncMeetingLogQuietly } from './crm';
import { armSessionIfDue } from './session-arming';
import { assertTrustedMutation } from './http';
import { isInternalRoomSlug } from './internal-rooms';
import { recordMeetingStart, recordUsageEvent } from './ledger';
import {
  type LiveKitParticipant,
  deleteLiveKitRoom,
  issueLiveKitToken,
  moveHostAttribute,
  sendHostMessage,
} from './livekit';
import { type RoomConfiguration, RoomCoordinator, RoomError } from './room-coordinator';
import { type OwnerSession } from './contracts';
import { internalRoomFor } from './internal-rooms';

// Which rooms an owner may name. Moved out of `index.ts` with the route table
// so a family's handlers can read them.

/**
 * The owner's *own* room. Stays singular on purpose: "start my room", with no
 * slug in the request, must never resolve to the internal room.
 */
export async function permanentRoomFor(owner: OwnerSession, env: Env): Promise<string | null> {
  return roomOfMember(env, owner.email);
}

/**
 * Every room this owner may host by name — their own, plus the internal room
 * when they are the address configured to host it. The internal room has one
 * `owner_email` like any other room (ADR 0001 decision 5): this widens which
 * slugs one host answers for, never how many people can hold a room.
 */
export async function hostableRoomsFor(owner: OwnerSession, env: Env): Promise<Set<string>> {
  const slugs = new Set<string>();
  const personal = await permanentRoomFor(owner, env);
  if (personal) slugs.add(personal);
  const internal = internalRoomFor(env, owner.email);
  if (internal) slugs.add(internal);
  return slugs;
}

export { roomStub };

/**
 * Start or resume the one mapped permanent room and mint an owner connection.
 * Both native platforms enter through this function; the legacy macOS route
 * returns only `connection`, while the mapped endpoint returns the full typed
 * host bootstrap for a future SwiftUI host implementation.
 *
 * `device` labels the client platform and `installID` makes the LiveKit
 * identity unique to that signed-in installation, so two Macs cannot evict
 * one another. Neither grants anything: the meeting, the lease, and every
 * owner control are keyed on `owner.sub` and stay shared between devices.
 */
export async function beginOwnerHostSession(
  env: Env,
  ctx: ExecutionContext,
  slug: string,
  owner: OwnerSession,
  device?: HostDevice,
  installID?: string | null,
): Promise<OwnerHostSessionResponse> {
  const identity = deviceScopedOwnerIdentity(owner.email, device, installID);
  const meeting = await (await roomStub(env, slug)).startMeeting(owner, identity, installID ?? null);
  // Open the CRM row now so a meeting that never gets finalized still shows
  // on the timeline. Off the critical path: the host is already connecting.
  ctx.waitUntil(syncMeetingLogQuietly(env, slug, meeting.id, 'started'));
  // Same reasoning for the account ledger: a meeting that is never finalized
  // is exactly the one worth having a row for. The completion write in
  // `artifacts.ts` fills in everything else.
  ctx.waitUntil(Promise.all([
    recordMeetingStart(env, {
      meetingId: meeting.id,
      roomSlug: slug,
      hostEmail: owner.email,
      startedAt: meeting.startedAt,
    }),
    recordUsageEvent(env, {
      kind: 'meeting_start',
      room_slug: slug,
      meeting_id: meeting.id,
      actor_kind: 'owner',
    }),
  ]));
  // An event session arms here, once per meeting (docs/SESSIONS.md §7).
  const session = await armSessionIfDue(env, slug, meeting.id);
  const connection = await issueConnection(env, slug, {
    meetingId: meeting.id,
    livekitRoom: meeting.livekitRoom,
    startedAt: meeting.startedAt,
    role: 'owner',
    participant: {
      // This verified Envisioning address is also the LiveKit JWT subject.
      // Caption consumers accept only that owner-shaped identity, which is why
      // the device suffix rides in the local part and never leaves the domain.
      identity,
      name: owner.name,
      // The account address, not the device identity: CRM filing is about the
      // person.
      email: owner.email,
      owner: true,
      client: hostDeviceClient(device),
    },
  });
  return {
    room: { slug, kind: 'permanent', expiresAt: null },
    connection: {
      ...connection,
      owner_identity: identity,
      host_identity: meeting.hostIdentity,
      is_host: meeting.hostIdentity === identity,
      chair_identity: meeting.hostIdentity,
      is_chair: meeting.hostIdentity === identity,
      ...(session ? { session: true } : {}),
    },
    lease: {
      host_lease_expires_at: meeting.hostLeaseExpiresAt,
      renew_after_ms: HOST_HEARTBEAT_INTERVAL_MILLISECONDS,
    },
    captions: {
      topic: CAPTION_DATA_TOPIC,
      // Whichever device holds the host publishes captions under its own
      // identity, so this is the one the client should stamp on its segments.
      publisher_identity: identity,
    },
  };
}

/** Best-effort SFU teardown — never fail the HTTP response over a stale room. */
export async function closeLiveKitRoomQuietly(
  env: Env,
  slug: string,
  livekitRoom: string | null,
): Promise<void> {
  if (!livekitRoom) return;
  try {
    await deleteLiveKitRoom(env, livekitRoom);
  } catch (reason) {
    console.warn('Could not close the LiveKit room', {
      slug,
      reason: reason instanceof Error ? reason.message : 'unknown',
    });
  }
}

/** Host state is authoritative in the room record; clients also reconcile from lobby polls. */
export async function sendHostMessageQuietly(
  env: Env,
  livekitRoom: string,
  message: HostMessage,
  recipientIdentity?: string,
): Promise<void> {
  try {
    await sendHostMessage(env, livekitRoom, message, recipientIdentity);
  } catch {
    // The next authenticated lobby poll carries host and pending identities.
    // A data-channel outage must not turn an already-committed transfer into
    // an apparent failed release on the old host.
  }
}

/** A host claim or release answer, in the 5.8.x `chair` shape on the old route. */
export function hostMutationAnswer(
  legacy: boolean,
  status: HostMutationResponse['status'],
  hostIdentity: string | null,
  pendingIdentity: string | null,
  hostLeaseExpiresAt: number,
): HostMutationResponse | LegacyChairMutationResponse {
  if (legacy) {
    return {
      status: status === 'host' ? 'chair' : status,
      chair_identity: hostIdentity,
      pending_identity: pendingIdentity,
      host_lease_expires_at: hostLeaseExpiresAt,
    };
  }
  return { status, host_identity: hostIdentity, pending_identity: pendingIdentity, host_lease_expires_at: hostLeaseExpiresAt };
}

export async function ensureOwnerRoom(
  env: Env,
  slug: string,
  owner: OwnerSession,
  expectedKind?: RoomConfiguration['kind'],
): Promise<RoomConfiguration> {
  // The room and its unfiled meetings are the owner's alone: an agent acting
  // as the owner is not the owner. It reads a meeting only once
  // it is filed on a subject it can see, through the member path.
  if (sessionAgent(owner)) throw new RoomError('Only the room owner can do that.', 403, 'not_room_owner');
  const room = await roomStub(env, slug);
  const existing = await room.roomConfiguration();
  if (existing) {
    if (existing.ownerSub === owner.sub) return existing;
    if (isInternalRoomSlug(env, slug) && (await hostableRoomsFor(owner, env)).has(slug)) {
      // The internal room is shared: the row keeps the latest host for
      // attribution, but any verified Envisioning member may take the host.
      return existing;
    }
    // Same verified human, different Google subject: a second Mac, a dev
    // session vs real Google sign-in, a re-created Google account, or the
    // same person on the other identity domain. The room's authority is
    // its `rooms` row (or OWNER_ROOM_MAP) plus a verified email — the stored sub is a
    // cache, so adopt it rather than locking the owner out. Both must still
    // agree, so a different person can never take a room.
    if (
      isSameMember(env, existing.ownerEmail, owner.email)
      && (await hostableRoomsFor(owner, env)).has(slug)
    ) {
      return room.adoptOwner({ sub: owner.sub, email: owner.email });
    }
    throw new RoomError('Only the room owner can do that.', 403, 'not_room_owner');
  }
  if (!(await hostableRoomsFor(owner, env)).has(slug)) {
    // 404 hides other rooms; an explicit permanent-room lookup gets an honest 403.
    if (expectedKind === 'permanent') throw new RoomError('This is not the owner’s permanent room.', 403, 'not_room_owner');
    throw new RoomError('Room not found.', 404, 'room_not_found');
  }
  return room.configureRoom({
    slug,
    ownerSub: owner.sub,
    ownerEmail: owner.email,
    ownerName: owner.name,
    kind: 'permanent',
    expiresAt: null,
  });
}

/**
 * The guard on a route that answers members only. It is `requireCapability`
 * with the capability not optional: a route says what it protects, and a
 * revoked person or a role the table does not name for it is refused here, not
 * by a check the route remembered to write. `route-gates.test.ts`
 * fails the build on any call that omits it.
 */
export async function requireOwner(request: Request, env: Env, capability: Capability): Promise<OwnerSession> {
  return requireCapability(request, env, capability);
}

/** The standard gate for owner room mutations: trusted origin/bearer + owner session + room ownership. */
export async function requireRoomOwnerMutation(request: Request, env: Env, slug: string): Promise<OwnerSession> {
  assertTrustedMutation(request, env);
  return requireRoomOwner(request, env, slug);
}

/**
 * Owner session that also owns this room. Every owner route goes through here
 * so the ownership rule — including sub adoption — is applied in one place.
 */
export async function requireRoomOwner(request: Request, env: Env, slug: string): Promise<OwnerSession> {
  const owner = await requireOwner(request, env, 'hosting');
  await ensureOwnerRoom(env, slug, owner);
  return owner;
}

/** The room check of `requireRoomHost`, for a caller that has already read the session (the route table's `room-host` gate). */
export async function admitRoomHost(env: Env, slug: string, owner: OwnerSession): Promise<void> {
  if (sessionAgent(owner)) throw new RoomError('Only the room owner can do that.', 403, 'not_room_owner');
  try {
    await ensureOwnerRoom(env, slug, owner);
  } catch (error) {
    if (error instanceof RoomError && error.code === 'not_room_owner' && await (await roomStub(env, slug)).isHostMember(owner.sub)) {
      return;
    }
    throw error;
  }
}

/**
 * The room owner, or a member hosting this room's open meeting on the host's
 * offer. Meeting routes only — joining as host, the lease, the
 * handover, admission, moderation, the transcript. Room settings and End stay
 * behind `requireRoomOwner`.
 */
export async function requireRoomHost(request: Request, env: Env, slug: string): Promise<OwnerSession> {
  const owner = await requireOwner(request, env, 'hosting');
  await admitRoomHost(env, slug, owner);
  return owner;
}

export async function requireRoomHostMutation(request: Request, env: Env, slug: string): Promise<OwnerSession> {
  assertTrustedMutation(request, env);
  return requireRoomHost(request, env, slug);
}

/** Move the Host badge to the device that hosts, if it moved. */
export async function syncHostBadge(
  env: Env,
  room: DurableObjectStub<RoomCoordinator>,
  meetingId: string,
  livekitRoom: string,
): Promise<void> {
  try {
    const change = await room.hostBadgeChange(meetingId);
    if (change && await moveHostAttribute(env, livekitRoom, change)) await room.hostBadgeChange(meetingId, true);
  } catch {
    // A badge is a courtesy: the next heartbeat tries again.
  }
}

/** Mint the LiveKit JWT + artifact token pair every connection response carries. */
export async function issueConnection(env: Env, slug: string, options: {
  meetingId: string;
  livekitRoom: string;
  startedAt: number;
  role: 'owner' | 'guest';
  participant: LiveKitParticipant;
}): Promise<ConnectionDetails> {
  const livekit = await issueLiveKitToken(env, options.livekitRoom, options.participant);
  const artifactToken = await signArtifactPrincipal({
    roomSlug: slug,
    meetingId: options.meetingId,
    identity: options.participant.identity,
    role: options.role,
    email: options.participant.email,
  }, env);
  return connectionResponse(
    env,
    options.meetingId,
    options.livekitRoom,
    options.startedAt,
    livekit.token,
    artifactToken,
    livekit.expiresAt,
  );
}

export async function requireArtifactPrincipal(request: Request, env: Env, slug: string, meetingId: string) {
  const principal = await getArtifactPrincipal(request, env);
  if (!principal || principal.roomSlug !== slug || principal.meetingId !== meetingId) {
    throw new AuthError('Artifact authorization is required.', 401, 'artifact_denied');
  }
  return principal;
}

export function connectionResponse(
  env: Env,
  meetingId: string,
  livekitRoom: string,
  startedAt: number,
  participantToken: string,
  artifactToken: string,
  participantTokenExpiresAt: number,
): ConnectionDetails {
  return {
    server_url: env.LIVEKIT_URL,
    participant_token: participantToken,
    participant_token_expires_at: participantTokenExpiresAt,
    artifact_token: artifactToken,
    meeting_id: meetingId,
    livekit_room: livekitRoom,
    started_at: startedAt,
  };
}
