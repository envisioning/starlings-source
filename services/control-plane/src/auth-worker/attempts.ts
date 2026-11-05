// Sign-in attempts in the auth Worker's own D1 (docs/CENTRAL_AUTH.md).
//
// An attempt lives ten minutes. It binds purpose, the exact workspace origin
// (the caller's binding props), a local return path and the hash of a browser secret that only the
// workspace's host-only cookie holds. Consent also binds the owner. A result
// is sealed with AES-GCM; only the hash of the redemption code is stored. The
// workspace redeems once, over the service binding, with one atomic
// DELETE ... RETURNING.
import {
  authBeginInputSchema,
  authBindingPropsSchema,
  authRedeemInputSchema,
  centralAuthResultSchema,
  type AuthBeginResult,
  type AuthRedeemResult,
  type BrowserAuthKind,
  type CentralAuthResult,
} from '@starlings/contracts/browser-auth';
import {
  checkWorkspaceSlug,
  isServiceHostOrigin,
  isWorkspaceHostOrigin,
  serviceOrigin,
  workspaceSlugOfOrigin,
} from '@starlings/contracts/workspace-slug';
import { openSecret, randomToken, sealSecret, sha256 } from '../crypto';
import { safeReturnPath } from '../http-cookies';
import type { AuthEnv } from './env';

export const ATTEMPT_MS = 10 * 60_000;
export const REDEEM_MS = 60_000;

export interface AttemptRow {
  ticket: string;
  kind: BrowserAuthKind;
  workspace_origin: string;
  /** The workspace the caller signs in as (`Caller.workspace`); null for an alias that names none. */
  workspace: string | null;
  return_path: string;
  owner_sub: string | null;
  product: string | null;
  login_hint: string | null;
  workspace_name: string | null;
  mark_path: string | null;
  accent: string | null;
  hosted_domain: string | null;
  browser_hash: string;
  expires_at: number;
  started_at: number | null;
  redeem_hash: string | null;
  result_iv: string | null;
  result_ciphertext: string | null;
}

/** Domain separation: the same secret signs OAuth state, so the seal key is derived. */
function resultKey(env: AuthEnv): string {
  return `${env.AUTH_SIGNING_SECRET}:central-auth-result-v1`;
}

function returnOriginAliases(env: AuthEnv): string[] {
  return (env.RETURN_ORIGIN_ALIASES ?? '').split(',').map((value) => value.trim()).filter((value) => {
    try { const url = new URL(value); return url.protocol === 'https:' && url.origin === value; } catch { return false; }
  });
}

/**
 * `https://<slug>.<suffix>`, `https://<service>-<slug>.<suffix>`
 * or an alias this Worker lists by name. Never the auth host.
 */
export function isReturnOrigin(origin: string, env: AuthEnv): boolean {
  if (origin === env.AUTH_ORIGIN) return false;
  return isWorkspaceHostOrigin(origin) || isServiceHostOrigin(origin) || returnOriginAliases(env).includes(origin);
}

/** Who is calling: the origin a code may go to, and the workspace that origin signs in as. */
export interface Caller {
  origin: string;
  /** A slug, or null for an alias that names no workspace. The auth session is shared within one workspace. */
  workspace: string | null;
}

/**
 * The caller, from the props its `AUTH` binding carries. The
 * account owner fixes them in wrangler.jsonc; the caller's code cannot set
 * them. A workspace names its origin only, and a `<slug>.<suffix>`
 * host gives its slug. A service names its workspace and itself, and its
 * origin must be that service's host for that workspace, or a listed alias.
 * Null when the props are anything else or name an origin this Worker does
 * not serve.
 */
export function caller(props: unknown, env: AuthEnv): Caller | null {
  const parsed = authBindingPropsSchema.safeParse(props);
  if (!parsed.success || !isReturnOrigin(parsed.data.origin, env)) return null;
  const { origin } = parsed.data;
  if ('service' in parsed.data) {
    const { workspace, service } = parsed.data;
    const slug = checkWorkspaceSlug(workspace);
    if (!slug.ok || slug.slug !== workspace) return null;
    if (origin !== serviceOrigin(service, workspace) && !returnOriginAliases(env).includes(origin)) return null;
    return { origin, workspace };
  }
  // A service host must say which workspace it serves; it cannot pass as one.
  if (isServiceHostOrigin(origin)) return null;
  return { origin, workspace: workspaceSlugOfOrigin(origin) };
}

/**
 * A workspace or service asks for an attempt (RPC `begin`). The origin and
 * workspace come from `caller`, never from `raw`: the strict input schema
 * refuses them. Expired attempts go first.
 */
export async function beginAttempt(env: AuthEnv, from: Caller | null, raw: unknown): Promise<AuthBeginResult> {
  if (!from || !isReturnOrigin(from.origin, env)) return { ok: false, reason: 'origin_refused' };
  const origin = from.origin;
  const parsed = authBeginInputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'invalid_request' };
  const input = parsed.data;
  if (safeReturnPath(input.returnPath) !== input.returnPath) return { ok: false, reason: 'invalid_request' };
  const ticket = randomToken(24);
  const now = Date.now();
  await env.AUTH_DB.batch([
    env.AUTH_DB.prepare('DELETE FROM sign_in_attempts WHERE expires_at < ?1').bind(now),
    env.AUTH_DB.prepare(`INSERT INTO sign_in_attempts
      (ticket, kind, workspace_origin, return_path, owner_sub, product, login_hint, workspace_name, mark_path, hosted_domain,
        browser_hash, expires_at, accent, workspace)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`)
      .bind(ticket, input.kind, origin, input.returnPath, input.ownerSub, input.product, input.loginHint,
        input.workspaceName, input.markPath, input.hostedDomain, input.browserHash, now + ATTEMPT_MS, input.accent ?? null,
        from.workspace),
  ]);
  return { ok: true, ticket };
}

/** The sign-in screen reads an attempt that has not started Google. It changes nothing. */
export async function pendingAttempt(env: AuthEnv, ticket: string): Promise<AttemptRow | null> {
  return env.AUTH_DB.prepare(`SELECT * FROM sign_in_attempts
    WHERE ticket = ?1 AND started_at IS NULL AND expires_at > ?2`)
    .bind(ticket, Date.now()).first<AttemptRow>();
}

/** The browser chose to continue with the ticket. A ticket starts Google once. */
export async function claimAttempt(env: AuthEnv, ticket: string): Promise<AttemptRow | null> {
  const now = Date.now();
  return env.AUTH_DB.prepare(`UPDATE sign_in_attempts SET started_at = ?2
    WHERE ticket = ?1 AND started_at IS NULL AND expires_at > ?2 RETURNING *`)
    .bind(ticket, now).first<AttemptRow>();
}

/** An attempt that started Google and has no result yet. */
export async function startedAttempt(env: AuthEnv, ticket: string): Promise<AttemptRow | null> {
  return env.AUTH_DB.prepare(`SELECT * FROM sign_in_attempts
    WHERE ticket = ?1 AND started_at IS NOT NULL AND redeem_hash IS NULL AND expires_at > ?2`)
    .bind(ticket, Date.now()).first<AttemptRow>();
}

/**
 * Seal the result and store the hash of a new redemption code. The attempt
 * then lives sixty seconds. Returns the code, or null when the attempt
 * expired or already has a result.
 */
export async function finishAttempt(env: AuthEnv, ticket: string, result: CentralAuthResult): Promise<string | null> {
  const code = randomToken();
  const sealed = await sealSecret(resultKey(env), JSON.stringify(result));
  const now = Date.now();
  const saved = await env.AUTH_DB.prepare(`UPDATE sign_in_attempts
    SET redeem_hash = ?2, result_iv = ?3, result_ciphertext = ?4, expires_at = ?5
    WHERE ticket = ?1 AND started_at IS NOT NULL AND redeem_hash IS NULL AND expires_at > ?6`)
    .bind(ticket, await sha256(code), sealed.iv, sealed.ciphertext, now + REDEEM_MS, now).run();
  return saved.meta.changes === 1 ? code : null;
}

/**
 * The workspace redeems (RPC `redeem`). The delete is the exchange: every
 * binding is in its WHERE, the caller's origin included, so a mismatch
 * consumes nothing and two concurrent redemptions succeed exactly once.
 * `origin` is `caller(...).origin`, as in `beginAttempt`.
 */
export async function redeemAttempt(env: AuthEnv, origin: string | null, raw: unknown): Promise<AuthRedeemResult> {
  if (!origin) return { ok: false, reason: 'invalid_request' };
  const parsed = authRedeemInputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'invalid_request' };
  const input = parsed.data;
  const row = await env.AUTH_DB.prepare(`DELETE FROM sign_in_attempts
    WHERE ticket = ?1 AND kind = ?2 AND workspace_origin = ?3 AND browser_hash = ?4 AND redeem_hash = ?5
      AND expires_at > ?6 AND owner_sub IS ?7
    RETURNING return_path, result_iv, result_ciphertext`)
    .bind(input.ticket, input.kind, origin, input.browserHash, await sha256(input.code), Date.now(), input.ownerSub)
    .first<Pick<AttemptRow, 'return_path' | 'result_iv' | 'result_ciphertext'>>();
  if (!row?.result_iv || !row.result_ciphertext) return { ok: false, reason: 'expired_or_used' };
  const opened = await openSecret(resultKey(env), { iv: row.result_iv, ciphertext: row.result_ciphertext });
  return { ok: true, returnPath: row.return_path, result: centralAuthResultSchema.parse(JSON.parse(opened)) };
}
