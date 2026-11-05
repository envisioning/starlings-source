// The operator check of `starlings-ops` (docs/OPS_CONSOLE.md §Access).
// Cloudflare Access protects the host. This Worker also checks
// every request itself and fails closed:
//
// 1. The team domain, the AUD tag and the operator list are all set and well
//    formed. If one is missing, the Worker refuses every request.
// 2. The request carries `Cf-Access-Jwt-Assertion`.
// 3. The token verifies against the team's certs, for this issuer and AUD.
// 4. The token's `email` is on `OPS_OPERATORS`.
//
// A workspace admin is not an operator because of that role. Only the list
// decides.
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { OpsEnv } from './env';

const TEAM_DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/u;
const AUD_TAG = /^[a-f0-9]{64}$/u;
const EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/u;

export const ACCESS_JWT_HEADER = 'cf-access-jwt-assertion';

export type AccessRefusal = 'not_configured' | 'missing_token' | 'invalid_token' | 'not_operator';
export type AccessResult = { ok: true; email: string } | { ok: false; reason: AccessRefusal };

/** The operator list, lowercased. An entry that is not an address is dropped. */
export function parseOperators(raw: string | null | undefined): string[] {
  const entries = (raw ?? '').split(',').map((entry) => entry.trim().toLowerCase()).filter((entry) => EMAIL.test(entry));
  return [...new Set(entries)];
}

/** The team domain and AUD tag when both are well formed, else null. */
export function accessConfig(env: Pick<OpsEnv, 'OPS_ACCESS_TEAM_DOMAIN' | 'OPS_ACCESS_AUD'>): { team: string; aud: string } | null {
  const team = String(env.OPS_ACCESS_TEAM_DOMAIN ?? '').trim().toLowerCase();
  const aud = String(env.OPS_ACCESS_AUD ?? '').trim().toLowerCase();
  if (!TEAM_DOMAIN.test(team) || !AUD_TAG.test(aud)) return null;
  return { team, aud };
}

const remoteKeys = new Map<string, JWTVerifyGetKey>();

/** The team's signing keys. jose caches and refreshes them per isolate. */
function accessKeys(team: string): JWTVerifyGetKey {
  let keys = remoteKeys.get(team);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`https://${team}/cdn-cgi/access/certs`));
    remoteKeys.set(team, keys);
  }
  return keys;
}

/**
 * Decide whether the request comes from an operator. `keysFor` exists for
 * tests; production reads the team's certs.
 */
export async function verifyOperator(
  request: Request,
  env: Pick<OpsEnv, 'OPS_ACCESS_TEAM_DOMAIN' | 'OPS_ACCESS_AUD' | 'OPS_OPERATORS'>,
  keysFor: (team: string) => JWTVerifyGetKey = accessKeys,
): Promise<AccessResult> {
  const config = accessConfig(env);
  const operators = parseOperators(env.OPS_OPERATORS);
  if (!config || operators.length === 0) return { ok: false, reason: 'not_configured' };

  const token = request.headers.get(ACCESS_JWT_HEADER)?.trim();
  if (!token) return { ok: false, reason: 'missing_token' };

  let email: unknown;
  try {
    const { payload } = await jwtVerify(token, keysFor(config.team), {
      issuer: `https://${config.team}`,
      audience: config.aud,
      algorithms: ['RS256'],
    });
    email = payload.email;
  } catch {
    return { ok: false, reason: 'invalid_token' };
  }
  // A service token carries no `email`, so it is never an operator.
  const address = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!address || !operators.includes(address)) return { ok: false, reason: 'not_operator' };
  return { ok: true, email: address };
}
