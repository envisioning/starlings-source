// The keys that sign sessions, and how a rotation keeps everyone signed in
//. See docs/SECURITY.md › Rotating the session signing secret.

import { WORKSPACE_HOST_SUFFIX } from '@starlings/contracts/workspace-slug';
import { decodeProtectedHeader, errors, jwtVerify, type JWTVerifyOptions, type JWTVerifyResult, type SignJWT } from 'jose';
import { sha256, signingKey } from './crypto';

export interface SessionKey {
  kid: string;
  key: Uint8Array;
}

/**
 * The `iss` of every token this Worker signs: sessions, refresh tokens, guest
 * sessions, artifact tokens, MCP tokens and the sealed Google OAuth state
 *. Clients never read it.
 */
export const SESSION_ISSUER = WORKSPACE_HOST_SUFFIX;

/**
 * The issuer before the rename. Verify still accepts it so a token signed
 * before the change lives out its lifetime; the longest is a 60-day refresh
 * token. Drop it from `ACCEPTED_SESSION_ISSUERS` after 2026-12-15.
 */
import { LEGACY_SESSION_ISSUER } from '@starlings/contracts/deployment';

export { LEGACY_SESSION_ISSUER };

/** Pass as `issuer` to every verify. */
export const ACCEPTED_SESSION_ISSUERS = [SESSION_ISSUER, LEGACY_SESSION_ISSUER];

type KeyEnv = Pick<Env, 'SESSION_SIGNING_SECRET' | 'SESSION_SIGNING_SECRET_PREVIOUS'>;

const kids = new Map<string, Promise<string>>();

/**
 * A key id derived from the secret, so no second setting can drift from it.
 * Labelled and cut to 16 characters: it names a key, and says nothing useful
 * about a 32-character random secret.
 */
function kidFor(secret: string): Promise<string> {
  let kid = kids.get(secret);
  if (!kid) {
    kid = sha256(`meet-session-kid:${secret}`).then((digest) => digest.slice(0, 16));
    kids.set(secret, kid);
  }
  return kid;
}

/**
 * The current key first, then the previous one while a rotation is under way.
 * `SESSION_SIGNING_SECRET_PREVIOUS` is set only between the two steps of the
 * runbook; without it there is one key, as before.
 */
export async function sessionSigningKeys(env: KeyEnv): Promise<SessionKey[]> {
  return Promise.all(sessionSigningSecrets(env).map(async (secret) => ({ kid: await kidFor(secret), key: signingKey(secret) })));
}

/** Sign with the current key. The header names it, so a later rotation knows which key to check. */
export async function signSessionJwt(jwt: SignJWT, env: KeyEnv): Promise<string> {
  const [current] = await sessionSigningKeys(env);
  return jwt.setProtectedHeader({ alg: 'HS256', typ: 'JWT', kid: current!.kid }).sign(current!.key);
}

/**
 * Verify against the key the header names. A token with no `kid` was signed
 * before key ids existed: it tries the current key, then the previous one, so
 * a 60-day refresh token minted before this shipped survives a rotation. A
 * `kid` that names neither key is refused. Only a bad signature moves on to
 * the next key; an expired or wrong-audience token fails at once.
 */
export async function verifySessionJwt(token: string, env: KeyEnv, options: JWTVerifyOptions): Promise<JWTVerifyResult> {
  const keys = await sessionSigningKeys(env);
  const { kid } = decodeProtectedHeader(token);
  const candidates = typeof kid === 'string' ? keys.filter((key) => key.kid === kid) : keys;
  if (candidates.length === 0) throw new errors.JWSSignatureVerificationFailed('unknown key id');
  for (const [index, candidate] of candidates.entries()) {
    try {
      return await jwtVerify(token, candidate.key, options);
    } catch (error) {
      const last = index === candidates.length - 1;
      if (last || !(error instanceof errors.JWSSignatureVerificationFailed)) throw error;
    }
  }
  throw new errors.JWSSignatureVerificationFailed('no key');
}

/** Every secret that may have signed something still in use: the current one first. */
export function sessionSigningSecrets(env: KeyEnv): string[] {
  const previous = env.SESSION_SIGNING_SECRET_PREVIOUS?.trim();
  return previous && previous !== env.SESSION_SIGNING_SECRET
    ? [env.SESSION_SIGNING_SECRET, previous]
    : [env.SESSION_SIGNING_SECRET];
}
