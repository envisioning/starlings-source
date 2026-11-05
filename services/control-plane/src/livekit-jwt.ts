// The two LiveKit tokens Starlings signs, in one place: a
// participant's room JWT and a RoomService admin token. Envisioning signs
// them with its own key (livekit.ts); every other workspace asks the broker
// in starlings-auth (auth-worker/livekit.ts), which signs them here with the
// same grants. A workspace never chooses a grant.
import { SignJWT } from 'jose';
import { LIVEKIT_ADMIN_TTL_SECONDS, LIVEKIT_PARTICIPANT_TTL_SECONDS } from '@starlings/contracts/livekit-broker';

export interface LiveKitKey {
  key: string;
  secret: string;
}

export interface LiveKitSignedToken {
  token: string;
  /** Seconds since the epoch. */
  expiresAt: number;
}

/** A token to join one room with the participant's fixed grants. `metadata` is `ParticipantMetadata` as JSON. */
export async function signParticipantToken(
  credentials: LiveKitKey,
  room: string,
  participant: { identity: string; name: string; metadata: string },
  now = Math.floor(Date.now() / 1000),
): Promise<LiveKitSignedToken> {
  const expiresAt = now + LIVEKIT_PARTICIPANT_TTL_SECONDS;
  const token = await new SignJWT({
    name: participant.name,
    metadata: participant.metadata,
    video: {
      room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      // Metadata is stamped here at mint and is read-only after that. No
      // client updates it, and leaving the grant open let any guest set
      // `{"owner": true}` on themselves and impersonate the owner's presence.
      canUpdateOwnMetadata: false,
    },
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(credentials.key)
    .setSubject(participant.identity)
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(expiresAt)
    .sign(new TextEncoder().encode(credentials.secret));
  return { token, expiresAt };
}

/**
 * A RoomService token, minted per call and scoped to the one room it acts on,
 * so a leaked token is worth a minute of one meeting rather than the whole SFU.
 */
export async function signRoomAdminToken(
  credentials: LiveKitKey,
  room: string,
  now = Math.floor(Date.now() / 1000),
): Promise<LiveKitSignedToken> {
  const expiresAt = now + LIVEKIT_ADMIN_TTL_SECONDS;
  const token = await new SignJWT({ video: { roomAdmin: true, room } })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(credentials.key)
    .setSubject(credentials.key)
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(expiresAt)
    .sign(new TextEncoder().encode(credentials.secret));
  return { token, expiresAt };
}
