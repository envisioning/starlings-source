// Keep — brokering an owner's device token for the Keep host.
//
// The same arrangement as Docs (`docs.ts`), and nothing more: the Worker
// proves the signed-in owner to Keep over a shared HMAC secret, Keep mints a
// per-device `evk_` token, and the Worker hands it back untouched. No proxy
// for the web here — Keep's browser client is Keep's own SPA, and a Keep
// token in a Meet tab is a token in a tab. The device then talks to Keep
// directly and does every cryptographic operation itself; Meet never sees
// a vault key or a plaintext.

import { internalKeepReleaseFetchResponseSchema, type InternalKeepReleaseFetchResponse, type KeepTokenResponse } from '@starlings/contracts';
import { hmacSHA256Hex } from './crypto';
import { ControlError } from './errors';

const EXCHANGE_PATH = '/api/tokens/meet-exchange';
const REQUEST_TIMEOUT_MS = 10_000;

export class KeepError extends ControlError {}

/**
 * This workspace's own Keep. There is no default: a Worker without
 * KEEP_ORIGIN has no Keep, and never reaches Envisioning's.
 */
function configuredKeepOrigin(env: Env): string | null {
  return (env as { KEEP_ORIGIN?: string }).KEEP_ORIGIN?.trim().replace(/\/$/, '') || null;
}

function keepOrigin(env: Env): string {
  const origin = configuredKeepOrigin(env);
  if (!origin) throw new KeepError('KEEP_ORIGIN is not configured.', 503, 'not_configured');
  return origin;
}

/** Off until the shared secret and the origin are configured, so dev and tests never call out. */
export function keepEnabled(env: Env): boolean {
  return Boolean(env.KEEP_INTERNAL_SECRET?.trim() && configuredKeepOrigin(env));
}

/**
 * `scope: 'agent'` mints a token for a roster agent (ADR 0007). It
 * reaches Keep's `/api/agent/*` only. Meet mints one per release fetch
 * (`handleInternalKeepRelease`) and never hands it to the agent.
 */
export async function exchangeKeepToken(
  env: Env,
  owner: { email: string; name: string },
  deviceName: string | undefined,
  scope: 'person' | 'agent' = 'person',
): Promise<KeepTokenResponse> {
  const secret = env.KEEP_INTERNAL_SECRET?.trim();
  if (!secret) throw new KeepError('KEEP_INTERNAL_SECRET is not configured.', 503, 'not_configured');
  const body = JSON.stringify({
    email: owner.email.trim().toLowerCase(),
    name: owner.name.trim() || owner.email.trim().toLowerCase(),
    device_name: deviceName?.trim() || 'Meet',
    ...(scope === 'agent' ? { scope } : {}),
  });
  const timestamp = String(Date.now());
  const signature = await hmacSHA256Hex(secret, `${timestamp}.${body}`);
  const request = new Request(`${keepOrigin(env)}${EXCHANGE_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'x-internal-timestamp': timestamp,
      'x-internal-signature': signature,
    },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  // Over the service binding in production; a URL fetch locally, where the
  // binding is absent.
  const binding = (env as { KEEP?: Fetcher }).KEEP;
  const response = await (binding ? binding.fetch(request) : fetch(request));
  const data = await response.json().catch(() => null) as { token?: string; expires_at?: string; email?: string } | null;
  if (!response.ok || !data) {
    throw new KeepError(`Keep declined to issue a token (${response.status}).`, 502);
  }
  if (typeof data.token !== 'string' || !data.token || typeof data.expires_at !== 'string') {
    throw new KeepError('Keep returned an unusable token response.', 502);
  }
  return {
    token: data.token,
    expires_at: data.expires_at,
    email: typeof data.email === 'string' && data.email ? data.email : owner.email.trim().toLowerCase(),
    origin: keepOrigin(env),
  };
}

/** One agent-token call to Keep's `/api/agent/*`, over the binding when there is one. */
async function keepAgentCall(env: Env, agentToken: string, path: string, method: 'GET' | 'POST'): Promise<{ status: number; data: unknown }> {
  const request = new Request(`${keepOrigin(env)}${path}`, {
    method,
    headers: { accept: 'application/json', authorization: `Bearer ${agentToken}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const binding = (env as { KEEP?: Fetcher }).KEEP;
  const response = await (binding ? binding.fetch(request) : fetch(request));
  return { status: response.status, data: await response.json().catch(() => null) };
}

/** What Keep says about one release. Names and times; never the payload. */
export interface KeepReleaseStatus {
  status: 'live' | 'used' | 'ended' | 'expired' | string;
  vault_id: string;
  item_name: string;
  approver: string;
  expires_at: string;
  ended_by: string | null;
}

/**
 * Read one release as the agent it names, so a card in Meet records
 * what Keep says rather than what a device claims. Meet mints the agent's
 * token for the call and drops it. Null when Keep has no such release for
 * that agent.
 */
export async function readKeepRelease(env: Env, agent: { email: string; name: string }, releaseId: string): Promise<KeepReleaseStatus | null> {
  const token = await exchangeKeepToken(env, agent, 'Meet release', 'agent');
  const { status, data } = await keepAgentCall(env, token.token, `/api/agent/releases/${encodeURIComponent(releaseId)}`, 'GET');
  if (status === 404) return null;
  const row = data as Partial<KeepReleaseStatus> | null;
  if (status !== 200 || !row || typeof row.status !== 'string' || typeof row.vault_id !== 'string' || typeof row.item_name !== 'string'
    || typeof row.approver !== 'string' || typeof row.expires_at !== 'string') {
    throw new KeepError(`Keep refused the read (${status}).`, 502);
  }
  return { status: row.status, vault_id: row.vault_id, item_name: row.item_name, approver: row.approver, expires_at: row.expires_at, ended_by: row.ended_by ?? null };
}

/**
 * The agent's one fetch of a release, with an `agent` token. Keep
 * answers 404 for another agent and 410 once the release is used, ended or
 * expired; both pass through as such. The body is sealed to the agent's
 * session key and passes through untouched.
 */
export async function fetchKeepRelease(env: Env, agentToken: string, releaseId: string): Promise<InternalKeepReleaseFetchResponse> {
  const { status, data } = await keepAgentCall(env, agentToken, `/api/agent/releases/${encodeURIComponent(releaseId)}/fetch`, 'POST');
  const body = data as { error?: unknown } | null;
  if (status === 404) throw new KeepError('No such release.', 404, 'room_not_found');
  if (status === 410) throw new KeepError(typeof body?.error === 'string' ? body.error : 'This release is closed.', 410, 'release_request_closed');
  if (status !== 200 || !data) throw new KeepError(`Keep refused the fetch (${status}).`, 502);
  const parsed = internalKeepReleaseFetchResponseSchema.safeParse(data);
  if (!parsed.success) throw new KeepError('Keep returned an unusable release.', 502);
  return parsed.data;
}
