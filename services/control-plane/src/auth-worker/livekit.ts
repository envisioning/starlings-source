// The LiveKit token broker, the auth Worker's side (,
// docs/CENTRAL_AUTH.md "The LiveKit broker"). Envisioning's LiveKit key pair
// is bound here from the Secrets Store and in no workspace Worker. A
// workspace asks over its `LIVEKIT` service binding; `props.origin` names it,
// and the broker signs only for rooms under that workspace's prefix
// (`liveKitRoomPrefix`). The grants are fixed in livekit-jwt.ts.
import {
  liveKitAdminInputSchema,
  liveKitBindingPropsSchema,
  liveKitParticipantInputSchema,
  liveKitRoomPrefix,
  type LiveKitTokenResult,
} from '@starlings/contracts/livekit-broker';
import { signParticipantToken, signRoomAdminToken, type LiveKitKey } from '../livekit-jwt';
import { sharedSecret } from '../shared-secrets';
import { caller } from './attempts';
import type { AuthEnv } from './env';

/** The calling workspace's slug, from the binding's props alone. A service host (Docs, Keep) and a host off the workspace domain are refused. */
export function liveKitCaller(props: unknown, env: AuthEnv): string | null {
  if (!liveKitBindingPropsSchema.safeParse(props).success) return null;
  return caller(props, env)?.workspace ?? null;
}

async function liveKitKey(env: AuthEnv): Promise<LiveKitKey | null> {
  const [key, secret] = await Promise.all([sharedSecret(env, 'LIVEKIT_API_KEY'), sharedSecret(env, 'LIVEKIT_API_SECRET')]);
  return key && secret ? { key, secret } : null;
}

/** True when `room` is under the workspace's prefix and has a name after it. */
function roomOf(workspace: string, room: string): boolean {
  const prefix = liveKitRoomPrefix(workspace);
  return room.startsWith(prefix) && room.length > prefix.length;
}

function refused(reason: Extract<LiveKitTokenResult, { ok: false }>['reason'], workspace: string | null, room?: string): LiveKitTokenResult {
  // The workspace and the refusal only: never a token, a name or a room's people.
  console.warn(JSON.stringify({ level: 'warn', message: 'livekit.broker.refused', reason, workspace, room_prefix_ok: room === undefined ? null : false }));
  return { ok: false, reason };
}

/** `participant`: a room JWT for one person in one of the caller's rooms. */
export async function liveKitParticipantToken(env: AuthEnv, workspace: string | null, raw: unknown): Promise<LiveKitTokenResult> {
  if (!workspace) return refused('origin_refused', null);
  const parsed = liveKitParticipantInputSchema.safeParse(raw);
  if (!parsed.success) return refused('invalid_request', workspace);
  const input = parsed.data;
  if (!roomOf(workspace, input.room)) return refused('room_refused', workspace, input.room);
  const credentials = await liveKitKey(env);
  if (!credentials) return refused('not_configured', workspace);
  const signed = await signParticipantToken(credentials, input.room, input);
  return { ok: true, token: signed.token, expiresAt: signed.expiresAt };
}

/** `admin`: a one-minute RoomService token for one of the caller's rooms. */
export async function liveKitAdminToken(env: AuthEnv, workspace: string | null, raw: unknown): Promise<LiveKitTokenResult> {
  if (!workspace) return refused('origin_refused', null);
  const parsed = liveKitAdminInputSchema.safeParse(raw);
  if (!parsed.success) return refused('invalid_request', workspace);
  if (!roomOf(workspace, parsed.data.room)) return refused('room_refused', workspace, parsed.data.room);
  const credentials = await liveKitKey(env);
  if (!credentials) return refused('not_configured', workspace);
  const signed = await signRoomAdminToken(credentials, parsed.data.room);
  return { ok: true, token: signed.token, expiresAt: signed.expiresAt };
}
