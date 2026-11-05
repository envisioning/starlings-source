// The auth host's browser session (docs/CENTRAL_AUTH.md "The auth session").
//
// Google proves a person once; this session remembers it for 30 days, so the
// next sign-in on this browser skips Google. It proves identity only. Every
// workspace and service still decides, on redeem, whether that person may
// come in, and its own session is hours, not days.
//
// Silent sign-in is per workspace. The session lists the places this
// browser signed in to, each an origin and the workspace it signs in as.
// Any origin of one of those workspaces (the workspace itself, its Docs, its
// Keep) gets a code without a click. Any other shows the screen, because a
// silent code would hand this person's name and address to a workspace
// they never chose (another firm's, for one). An alias that names no
// workspace is silent for itself only.
//
// At rest the row holds the token's hash and a blob sealed under a key
// derived from the token itself, so the auth D1 alone names nobody.
// zod/mini and a namespace import, as in @starlings/contracts/browser-auth: this
// Worker bundles small.
import * as z from 'zod/mini';
import { openSecret, randomToken, sealSecret, sha256 } from '../crypto';
import { cookie, expiredCookie, readCookie } from '../http-cookies';
import type { AuthEnv } from './env';

export const SESSION_MS = 30 * 24 * 60 * 60_000;
/** `__Host-`: Secure, Path=/, no Domain. Only this host reads or sets it. */
export const SESSION_COOKIE = '__Host-starlings_auth_session';
/** Enough for one person's workspaces and their services; the oldest drop first. */
const MAX_PLACES = 32;

const sessionIdentitySchema = z.object({
  sub: z.string().check(z.minLength(1), z.maxLength(255)),
  email: z.email(),
  name: z.string().check(z.minLength(1)),
  hd: z.optional(z.string()),
  picture: z.optional(z.string()),
});
export type SessionIdentity = z.infer<typeof sessionIdentitySchema>;

/** Where a browser signed in: the origin, and the workspace it signs in as (null for an alias that names none). */
export interface SessionPlace {
  origin: string;
  workspace: string | null;
}

const placeSchema = z.object({ origin: z.string(), workspace: z.nullable(z.string()) });
const sealedSessionSchema = z.object({
  identity: sessionIdentitySchema,
  // A bare origin is a place from before workspaces were kept (c15852c2).
  origins: z.array(z.union([z.string(), placeSchema])),
});
interface SealedSession {
  identity: SessionIdentity;
  places: SessionPlace[];
}

export interface BrowserSession extends SealedSession {
  token: string;
}

/** Domain separation from the attempt seal, and a key no row can open without its cookie. */
function sessionKey(env: AuthEnv, token: string): string {
  return `${env.AUTH_SIGNING_SECRET}:browser-session-v1:${token}`;
}

async function write(env: AuthEnv, token: string, body: SealedSession): Promise<{ iv: string; ciphertext: string }> {
  return sealSecret(sessionKey(env, token), JSON.stringify({ identity: body.identity, origins: body.places }));
}

/** The session this request's cookie names, or null: no cookie, no row, expired, or a seal that does not open. */
export async function readBrowserSession(request: Request, env: AuthEnv): Promise<BrowserSession | null> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const row = await env.AUTH_DB.prepare(`SELECT sealed_iv, sealed_ciphertext FROM browser_sessions
    WHERE id_hash = ?1 AND expires_at > ?2`)
    .bind(await sha256(token), Date.now())
    .first<{ sealed_iv: string; sealed_ciphertext: string }>();
  if (!row) return null;
  try {
    const opened = await openSecret(sessionKey(env, token), { iv: row.sealed_iv, ciphertext: row.sealed_ciphertext });
    const body = sealedSessionSchema.parse(JSON.parse(opened));
    const places = body.origins.map((place) => typeof place === 'string' ? { origin: place, workspace: null } : place);
    return { token, identity: body.identity, places };
  } catch {
    return null;
  }
}

/**
 * A new session after Google proved `identity` at `place`. Any session the
 * browser already had is deleted: one browser, one person. Expired rows go
 * first. Returns the cookie to set.
 */
export async function startBrowserSession(
  request: Request,
  env: AuthEnv,
  identity: SessionIdentity,
  place: SessionPlace,
): Promise<string> {
  const previous = readCookie(request, SESSION_COOKIE);
  const token = randomToken();
  const now = Date.now();
  const sealed = await write(env, token, { identity: sessionIdentitySchema.parse(identity), places: [place] });
  await env.AUTH_DB.batch([
    env.AUTH_DB.prepare('DELETE FROM browser_sessions WHERE expires_at < ?1').bind(now),
    ...(previous ? [env.AUTH_DB.prepare('DELETE FROM browser_sessions WHERE id_hash = ?1').bind(await sha256(previous))] : []),
    env.AUTH_DB.prepare(`INSERT INTO browser_sessions (id_hash, sealed_iv, sealed_ciphertext, created_at, expires_at)
      VALUES (?1, ?2, ?3, ?4, ?5)`)
      .bind(await sha256(token), sealed.iv, sealed.ciphertext, now, now + SESSION_MS),
  ]);
  return cookie(SESSION_COOKIE, token, SESSION_MS / 1000);
}

/** True when this browser already signed in to `place`'s origin or, when it names one, its workspace. */
export function sessionKnows(session: BrowserSession, place: SessionPlace): boolean {
  return session.places.some((known) => known.origin === place.origin
    || (place.workspace !== null && known.workspace === place.workspace));
}

/** Remember that this browser chose `place`. The expiry stays where sign-in set it: 30 days is absolute. */
export async function addSessionPlace(env: AuthEnv, session: BrowserSession, place: SessionPlace): Promise<void> {
  if (session.places.some((known) => known.origin === place.origin && known.workspace === place.workspace)) return;
  const places = [...session.places.filter((known) => known.origin !== place.origin), place].slice(-MAX_PLACES);
  const sealed = await write(env, session.token, { identity: session.identity, places });
  await env.AUTH_DB.prepare(`UPDATE browser_sessions SET sealed_iv = ?2, sealed_ciphertext = ?3
    WHERE id_hash = ?1 AND expires_at > ?4`)
    .bind(await sha256(session.token), sealed.iv, sealed.ciphertext, Date.now()).run();
  session.places = places;
}

/** The session may answer an attempt only when its account is on the attempt's Google domain, if it names one. */
export function sessionFitsDomain(session: BrowserSession, hostedDomain: string | null): boolean {
  return !hostedDomain || session.identity.hd === hostedDomain;
}

/** Sign out of the auth host: delete this browser's row. Returns the cookie that clears it. */
export async function endBrowserSession(request: Request, env: AuthEnv): Promise<string> {
  const token = readCookie(request, SESSION_COOKIE);
  if (token) await env.AUTH_DB.prepare('DELETE FROM browser_sessions WHERE id_hash = ?1').bind(await sha256(token)).run();
  return expiredCookie(SESSION_COOKIE);
}
