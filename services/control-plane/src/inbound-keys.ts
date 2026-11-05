// One inbound key per caller.
//
// The old shared `INTERNAL_INBOUND_SECRET` was one value held by Core and
// every bot, with the agent's identity a header the caller chose inside the
// signed string. Any holder could therefore post as any roster agent and read
// `/mcp` as any member who had messaged that agent. It was retired and removed
// on 2026-10-06.
//
// Now a caller names its key in `x-internal-key-id` and the Worker looks the
// secret up by that id: `core`, or the address of one roster agent. Core's
// secret is the Worker secret `INBOUND_KEY_CORE`; an agent's is its own
// `inbound_key` on the roster (agent-roster.ts), issued when it enrolled.
// Each key may claim exactly one identity:
//
// | key id            | channel-events                   | /mcp agent door | ping | keep-release | core-writes |
// | ----------------- | -------------------------------- | --------------- | ---- | ------------ | ----------- |
// | `core`            | no `sender` (a quiet system line) | refused         | yes  | refused      | yes         |
// | an agent address  | `sender` is that address         | `x-meet-agent` is that address | refused | `sender` is that address | refused |
//
// A request whose key and claimed identity disagree is refused and counted
// (`inbound_signature`).
//
// The signed string is unchanged. The HMAC key is the secret, so the id only
// selects the key: swapping the id for another caller's makes the signature
// fail, which is the same refusal as a wrong secret.
//
// A request with no key id answers 404 on every door: no secret verifies it.

import { agentByEmail, agentInboundKey, callerSecretName } from './agent-roster';
import { AuthError, ControlError } from './errors';
import { CORE_CALLER, recordInboundRefusal, recordInboundUse } from './ops';

export const INBOUND_KEY_ID_HEADER = 'x-internal-key-id';
/** The key id Core signs with. */
export const CORE_KEY_ID = 'core';
/** A key shorter than this is treated as not provisioned. */
const MIN_KEY_LENGTH = 32;
const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9@._+-]{0,127}$/u;

export type InboundDoor = 'channel-events' | 'ping' | 'mcp' | 'keep-release' | 'core-writes' | 'core-reads';

export type InboundKey =
  | { kind: 'core' }
  | { kind: 'agent'; email: string };

export interface InboundCaller {
  secret: string;
  key: InboundKey;
}

/** `core` → `INBOUND_KEY_CORE`; `vocab@example.com` → `INBOUND_KEY_VOCAB_ENVISIONING_COM` (a config agent, until the var goes). */
export function inboundKeyEnvName(keyId: string): string {
  return callerSecretName('INBOUND_KEY', keyId);
}

/** The name a caller is counted under: `core`, or `agent:<local part>`. Never text the caller chose. */
export async function inboundCallerLabel(env: Env, key: InboundKey): Promise<string> {
  if (key.kind === 'core') return CORE_CALLER;
  return await agentByEmail(env, key.email) ? `agent:${key.email.split('@')[0]}` : 'agent:unknown';
}

/**
 * Which secret verifies this request. Throws 404 for a request with no key
 * id (a door does not advertise itself), 403 for a key id nobody provisioned.
 */
export async function resolveInboundKey(request: Request, env: Env): Promise<InboundCaller> {
  const keyId = (request.headers.get(INBOUND_KEY_ID_HEADER) ?? '').trim().toLowerCase();
  if (!keyId) throw new ControlError('Not found.', 404, 'room_not_found');

  const agent = keyId !== CORE_KEY_ID && KEY_ID_PATTERN.test(keyId) ? await agentByEmail(env, keyId) : null;
  const key: InboundKey | null = keyId === CORE_KEY_ID
    ? { kind: 'core' }
    : agent ? { kind: 'agent', email: keyId } : null;
  if (!key) {
    // The header is the caller's text: counted under a fixed name, not under it.
    await recordInboundRefusal(env, 'unknown-key', 'unknown_key');
    throw new AuthError('Unknown key.', 403, 'owner_auth_required');
  }
  const secret = agent
    ? await agentInboundKey(env, agent)
    : (env as unknown as Record<string, string | undefined>)[inboundKeyEnvName(keyId)]?.trim();
  if (!secret || secret.length < MIN_KEY_LENGTH) {
    await recordInboundRefusal(env, await inboundCallerLabel(env, key), 'unknown_key');
    throw new AuthError('Unknown key.', 403, 'owner_auth_required');
  }
  return { secret, key };
}

/**
 * The identity a signed request claims, checked against the key that signed
 * it. `claimedAgent` is the body's `sender` on channel-events and
 * `x-meet-agent` on `/mcp`; null where the door names none.
 *
 * Runs after the signature has verified, so a refusal here means a holder of
 * a real key asked for an identity that key does not carry.
 */
export async function bindInboundIdentity(
  env: Env,
  caller: InboundCaller,
  door: InboundDoor,
  claimedAgent: string | null,
): Promise<string> {
  const { key } = caller;
  const label = await inboundCallerLabel(env, key);
  const claimed = claimedAgent?.trim().toLowerCase() || null;
  const allowed = key.kind === 'core'
    ? door !== 'mcp' && door !== 'keep-release' && claimed === null
    : door !== 'ping' && door !== 'core-writes' && door !== 'core-reads' && claimed === key.email;
  if (!allowed) {
    await recordInboundRefusal(env, label, 'identity');
    throw new AuthError('That key does not carry that identity.', 403, 'owner_auth_required');
  }
  await recordInboundUse(env, label);
  return label;
}
