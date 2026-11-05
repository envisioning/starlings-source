import { sharedSecret } from './shared-secrets';
import {
  HAND_ATTRIBUTE,
  HOST_ATTRIBUTE,
  HAND_LOWERED,
  HOST_DATA_TOPIC,
  LEGACY_CHAIR_DATA_TOPIC,
  MODERATION_DATA_TOPIC,
  type HostMessage,
  type LegacyChairMessage,
  type GuestClient,
  type ModerationMessage,
  type ParticipantMetadata,
} from '@starlings/contracts';
import {
  LIVEKIT_BROKER_VERSION,
  LIVEKIT_PARTICIPANT_TTL_SECONDS,
  liveKitRoomPrefix,
  liveKitTokenResultSchema,
  type LiveKitAdminInput,
  type LiveKitParticipantInput,
} from '@starlings/contracts/livekit-broker';
import { signParticipantToken, signRoomAdminToken, type LiveKitSignedToken } from './livekit-jwt';
import { workspaceSlug } from './workspace-origins';

/** Room JWT lifetime. Long enough for 1h+ meetings; clients should still refresh before expiry. */
export const LIVEKIT_TOKEN_TTL_SECONDS = LIVEKIT_PARTICIPANT_TTL_SECONDS;

/** The RPC surface of `LiveKitService` in src/auth-worker/index.ts. Answers are decoded, never trusted. No argument names a workspace. */
export interface LiveKitBrokerBinding {
  participant(input: LiveKitParticipantInput): Promise<unknown>;
  admin(input: LiveKitAdminInput): Promise<unknown>;
}

/**
 * The `LIVEKIT` binding to the token broker in starlings-auth, or
 * null on a Worker that signs with its own key: Envisioning, whose project it
 * is. Every other workspace binds it and holds no LiveKit key.
 */
export function liveKitBroker(env: Env): LiveKitBrokerBinding | null {
  const binding = (env as { LIVEKIT?: unknown }).LIVEKIT;
  return binding && typeof (binding as { participant?: unknown }).participant === 'function' ? binding as LiveKitBrokerBinding : null;
}

/**
 * The SFU room name for a new meeting. A brokered workspace's rooms carry its
 * prefix, the only rooms the broker signs for; Envisioning's keep `meet-`.
 */
export function liveKitRoomName(env: Env, roomSlug: string, meetingId: string): string {
  const workspace = liveKitBroker(env) ? workspaceSlug(env) : null;
  return `${workspace ? liveKitRoomPrefix(workspace) : ''}meet-${roomSlug}-${meetingId}`;
}

async function brokered(call: Promise<unknown>, what: string): Promise<LiveKitSignedToken> {
  const answer = liveKitTokenResultSchema.safeParse(await call);
  if (!answer.success) throw new Error(`The LiveKit broker answered ${what} with a shape it does not send.`);
  if (!answer.data.ok) throw new Error(`The LiveKit broker refused ${what}: ${answer.data.reason}.`);
  return { token: answer.data.token, expiresAt: answer.data.expiresAt };
}

/** A RoomService token for one room: from the broker, or signed here with Envisioning's key. */
async function roomAdminToken(env: Env, roomName: string): Promise<string> {
  const broker = liveKitBroker(env);
  if (broker) return (await brokered(broker.admin({ v: LIVEKIT_BROKER_VERSION, room: roomName }), 'a room admin token')).token;
  return (await signRoomAdminToken(await liveKitCredentials(env), roomName)).token;
}

export interface LiveKitParticipant {
  identity: string;
  name: string;
  email: string;
  owner: boolean;
  /**
   * Surface this participant is on, stamped into metadata so every client in
   * the room can show it. Null when the client never said (older builds).
   */
  client?: GuestClient | null;
  on_behalf_of?: string | null;
  recording?: boolean;
  /** Let in by an event registration link (docs/SESSIONS.md §7). */
  registered?: boolean;
}

/**
 * Close the SFU room so nobody is left in a meeting the owner already ended.
 *
 * Ending a meeting only stopped the host heartbeat, which meant guests already
 * connected kept talking to each other in a room with no owner, no admission
 * control, and no transcription — the same ghost-room the host lease exists to
 * prevent. Deleting the room disconnects every remaining participant with
 * `ROOM_DELETED`, which is the signal the web client turns into its summary
 * screen.
 *
 * Best-effort by design: the transcript artifact matters more than the tidy
 * shutdown, so callers log and continue on failure.
 */
export async function deleteLiveKitRoom(env: Env, roomName: string): Promise<void> {
  await roomServiceCall(env, roomName, 'DeleteRoom', { room: roomName });
}

/** The LiveKit key pair: the shared store first, then this Worker's own secrets. */
async function liveKitCredentials(env: Env): Promise<{ key: string; secret: string }> {
  const [key, secret] = await Promise.all([sharedSecret(env, 'LIVEKIT_API_KEY'), sharedSecret(env, 'LIVEKIT_API_SECRET')]);
  if (!key || !secret) throw new Error('LiveKit credentials are not configured.');
  return { key, secret };
}

/** One authenticated RoomService call, with an admin token for that one room. */
async function roomServiceCall<T>(
  env: Env,
  roomName: string,
  method: string,
  body: Record<string, unknown>,
): Promise<T> {
  const token = await roomAdminToken(env, roomName);
  const endpoint = new URL(`/twirp/livekit.RoomService/${method}`, httpOrigin(env.LIVEKIT_URL));
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`LiveKit ${method} failed with ${response.status}.`);
  }
  // Twirp answers mutations with `{}`; tolerate an empty body all the same so a
  // void call never fails on a parse.
  const text = await response.text();
  return (text ? JSON.parse(text) : {}) as T;
}

/** Twirp renders the `TrackSource` enum as its proto name. */
const SCREEN_SHARE_SOURCES = new Set(['SCREEN_SHARE', 'SCREEN_SHARE_AUDIO']);

interface ParticipantInfoResponse {
  tracks?: { sid?: string; source?: string }[];
}

/**
 * Stop one participant's screen share on the host's behalf.
 *
 * Two steps, because either alone leaves a hole:
 *
 * - Muting at the SFU is the authoritative half. It takes the share off every
 *   other participant's stage whether or not the sharer's client cooperates,
 *   which is what makes this a moderation control rather than a request.
 * - The data message is the humane half. A server mute stops the *stream*, not
 *   the *capture*: without it the sharer's browser keeps its "sharing" bar lit
 *   and macOS keeps the screen-recording indicator on, for a share nobody can
 *   see. The client releases the capture and says who stopped it.
 *
 * Returns the number of muted tracks — a share is usually video plus, when the
 * sharer included system audio, a second audio track.
 */
export async function stopParticipantScreenShare(
  env: Env,
  roomName: string,
  identity: string,
  stoppedBy: string,
): Promise<number> {
  const participant = await roomServiceCall<ParticipantInfoResponse>(
    env,
    roomName,
    'GetParticipant',
    { room: roomName, identity },
  );
  const shares = (participant.tracks ?? []).filter(
    (track) => track.sid && track.source && SCREEN_SHARE_SOURCES.has(track.source),
  );

  for (const track of shares) {
    await roomServiceCall(env, roomName, 'MutePublishedTrack', {
      room: roomName,
      identity,
      track_sid: track.sid,
      muted: true,
    });
  }

  // Only the sharer needs this: everyone else simply sees the share end, and
  // broadcasting whose share was stopped would put a moderation action on
  // every stage in the room.
  await tellParticipant(env, roomName, identity, 'screenshare.stopped', stoppedBy);

  return shares.length;
}

/** The one source a host mute touches. A screen share's audio is not a voice. */
const MICROPHONE_SOURCE = 'MICROPHONE';

interface ListParticipantsResponse {
  participants?: {
    identity?: string;
    tracks?: { sid?: string; source?: string; muted?: boolean }[];
    attributes?: Record<string, string>;
  }[];
}

/** The current SFU roster, used to distinguish an abandoned host from a live one. */
export async function listLiveKitParticipantIdentities(env: Env, roomName: string): Promise<Set<string>> {
  const roster = await roomServiceCall<ListParticipantsResponse>(env, roomName, 'ListParticipants', { room: roomName });
  return new Set((roster.participants ?? []).flatMap((participant) => participant.identity ? [participant.identity] : []));
}

/**
 * Server-origin host packets are trusted by native clients only when no
 * participant sent them. Each goes out twice until: on `host.v1`, and on
 * the 5.8.x Macs' `chair.v1` with the old key.
 */
export async function sendHostMessage(
  env: Env,
  roomName: string,
  message: HostMessage,
  recipientIdentity?: string,
): Promise<void> {
  const sends: [string, HostMessage | LegacyChairMessage][] = [[HOST_DATA_TOPIC, message]];
  // A 5.8.x Mac knows no offers.
  if (message.type !== 'offered') {
    sends.push([LEGACY_CHAIR_DATA_TOPIC, {
      version: 1,
      type: message.type,
      chair_identity: message.host_identity,
      target_identity: message.target_identity,
    }]);
  }
  for (const [topic, body] of sends) {
    await roomServiceCall(env, roomName, 'SendData', {
      room: roomName,
      data: base64(JSON.stringify(body)),
      kind: 'RELIABLE',
      ...(recipientIdentity ? { destination_identities: [recipientIdentity] } : {}),
      topic,
    });
  }
}

/**
 * Mute one participant's microphone, or everyone's but the owner's.
 *
 * Same two halves as stopping a share, for the same reason. The SFU mute is
 * what actually takes the voice off the call whether or not the client
 * cooperates; the data message is what stops it reading as a dead microphone,
 * and lets the client's own mute button tell the truth afterwards.
 *
 * There is no unmute here by design. A host may close a microphone — a barking
 * dog, a forgotten open mic — but opening one again is the decision of the
 * person sitting behind it, and nobody else.
 *
 * Returns how many people were actually publishing audio and got muted.
 */
export async function muteParticipantAudio(
  env: Env,
  roomName: string,
  target: { identity: string } | { exceptIdentity: string },
  mutedBy: string,
): Promise<number> {
  const roster = await roomServiceCall<ListParticipantsResponse>(
    env,
    roomName,
    'ListParticipants',
    { room: roomName },
  );
  const everyone = roster.participants ?? [];
  const targets = 'identity' in target
    ? everyone.filter((participant) => participant.identity === target.identity)
    : everyone.filter((participant) => participant.identity
      && participant.identity !== target.exceptIdentity);

  let muted = 0;
  for (const participant of targets) {
    const identity = participant.identity;
    if (!identity) continue;
    // An already-muted track is skipped rather than re-muted: the count is
    // "how many voices did this close", and re-sending the notice would tell
    // somebody they were muted while they were sitting there muted.
    const microphones = (participant.tracks ?? []).filter(
      (track) => track.sid && track.source === MICROPHONE_SOURCE && !track.muted,
    );
    if (microphones.length === 0) continue;
    for (const track of microphones) {
      await roomServiceCall(env, roomName, 'MutePublishedTrack', {
        room: roomName,
        identity,
        track_sid: track.sid,
        muted: true,
      });
    }
    await tellParticipant(env, roomName, identity, 'audio.muted', mutedBy);
    muted += 1;
  }
  return muted;
}

/**
 * Put one participant's hand up or down.
 *
 * Written here rather than by the client, and that is the whole design. A hand
 * is state, so it belongs in a participant attribute where it syncs to late
 * joiners and survives a reconnect — but LiveKit gates *all* self-service
 * attribute and metadata writes behind one grant, `canUpdateOwnMetadata`, and
 * this app deliberately keeps that shut. The comment on `issueLiveKitToken`
 * says why: metadata is stamped at mint and carries `owner`, so a guest who
 * could rewrite their own metadata could claim to be the owner. Opening the
 * grant to get hands would buy a small feature with a large hole.
 *
 * So the guest asks the control plane, the control plane has already verified
 * who they are, and it writes the attribute with an admin grant. The identity
 * comes from the caller's token rather than from their request, so a guest can
 * only ever raise their own hand — the same rule the quality report follows.
 *
 * `UpdateParticipant` merges the attributes given; an empty value clears a key,
 * which is how a hand comes down without a second call shape.
 */
export async function setParticipantHand(
  env: Env,
  roomName: string,
  identity: string,
  value: string,
): Promise<void> {
  await roomServiceCall(env, roomName, 'UpdateParticipant', {
    room: roomName,
    identity,
    attributes: { [HAND_ATTRIBUTE]: value },
  });
}

/**
 * Move the Host badge: set `HOST_ATTRIBUTE` on the device that hosts and clear
 * it on the one that did. Same admin write as a hand, for the same reason: a
 * participant cannot be trusted to say it is the host. Answers whether the
 * new badge was written; a host not yet in the call is tried again later.
 */
export async function moveHostAttribute(
  env: Env,
  roomName: string,
  change: { set: string | null; clear: string | null },
): Promise<boolean> {
  const write = async (identity: string, value: string): Promise<boolean> => {
    try {
      await roomServiceCall(env, roomName, 'UpdateParticipant', {
        room: roomName,
        identity,
        attributes: { [HOST_ATTRIBUTE]: value },
      });
      return true;
    } catch {
      return false;
    }
  };
  // The old host may have left; only the new badge decides whether this counts.
  if (change.clear) await write(change.clear, '');
  return change.set ? write(change.set, '1') : true;
}

/**
 * Lower every hand in the room, for the host.
 *
 * Once there is a queue there has to be a way to clear it — a host who has just
 * answered six people should not be lowering six hands one at a time, and a
 * queue nobody can reset is a queue that stops meaning anything by the second
 * meeting. Only hands that are actually up are touched, so the count returned
 * is "how many did this lower" rather than "how many people were in the room".
 */
export async function lowerAllHands(env: Env, roomName: string): Promise<number> {
  const roster = await roomServiceCall<ListParticipantsResponse>(
    env,
    roomName,
    'ListParticipants',
    { room: roomName },
  );
  let lowered = 0;
  for (const participant of roster.participants ?? []) {
    const identity = participant.identity;
    if (!identity) continue;
    if (!participant.attributes?.[HAND_ATTRIBUTE]) continue;
    await setParticipantHand(env, roomName, identity, HAND_LOWERED);
    lowered += 1;
  }
  return lowered;
}

/**
 * Disconnect one participant from the SFU.
 *
 * The notice goes first and deliberately: `RemoveParticipant` tears the peer
 * connection down, so anything sent afterwards has nowhere to land. Even so it
 * is a courtesy rather than a guarantee — the client also reads LiveKit's own
 * `PARTICIPANT_REMOVED` disconnect reason, which is what keeps a removal from
 * looking like a dropped connection worth silently retrying.
 *
 * Removal at the SFU alone would only last until the guest's browser
 * reconnected with the lobby credentials it still holds, so the caller spends
 * their admission in the room record first. Coming back means knocking again.
 */
export async function removeParticipant(
  env: Env,
  roomName: string,
  identity: string,
  removedBy: string,
): Promise<void> {
  await tellParticipant(env, roomName, identity, 'participant.removed', removedBy);
  await roomServiceCall(env, roomName, 'RemoveParticipant', { room: roomName, identity });
}

/** One moderation packet, addressed to the one person it happened to. */
async function tellParticipant(
  env: Env,
  roomName: string,
  identity: string,
  type: ModerationMessage['type'],
  by: string,
): Promise<void> {
  const message: ModerationMessage = { version: 1, type, by };
  await roomServiceCall(env, roomName, 'SendData', {
    room: roomName,
    data: base64(JSON.stringify(message)),
    kind: 'RELIABLE',
    destination_identities: [identity],
    topic: MODERATION_DATA_TOPIC,
  });
}

/** Twirp carries proto `bytes` as base64. */
function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** The RoomService API lives on the http(s) twin of the signalling URL. */
function httpOrigin(livekitURL: string): string {
  const url = new URL(livekitURL);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  return url.origin;
}

export async function issueLiveKitToken(
  env: Env,
  roomName: string,
  participant: LiveKitParticipant,
): Promise<{ token: string; expiresAt: number }> {
  const person = {
    identity: participant.identity,
    name: participant.name,
    metadata: JSON.stringify({
      owner: participant.owner,
      client: participant.client ?? null,
      on_behalf_of: participant.on_behalf_of ?? null,
      recording: participant.recording ?? false,
      ...(participant.registered ? { registered: true } : {}),
    } satisfies ParticipantMetadata),
  };
  const broker = liveKitBroker(env);
  if (broker) return brokered(broker.participant({ v: LIVEKIT_BROKER_VERSION, room: roomName, ...person }), 'a participant token');
  return signParticipantToken(await liveKitCredentials(env), roomName, person);
}
