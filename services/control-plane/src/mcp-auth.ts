// The OAuth 2.1 pairing in front of `/mcp` (docs/MCP.md §Auth).
//
// Any MCP client (Claude, Claude Code, Hermes) pairs with Meet the way the RFCs
// say: it discovers the authorization server (RFC 8414, RFC 9728), registers
// itself (RFC 7591), sends the person to `/oauth/authorize` with PKCE, and
// trades the code for tokens at `/oauth/token`. Nothing here is a second
// identity: the person still signs in through Google, the browser still
// carries the same `meet_session` cookie, and the access token this mints is
// verified by `getMcpPrincipal` and then turned into the ordinary owner
// session every `/api/*` route already checks (decision 10).
//
// Two audiences, so a token can never be spent as the other kind, and neither
// can be spent as a plain session: `meet-mcp` reaches `/mcp` only, and
// `meet-mcp-refresh` reaches `/oauth/token` only. A leaked MCP token cannot
// call `/api/threads` directly — every call it can make goes through the
// record (docs/MCP.md rule 2).

import { isWorkspaceOrigin, workspaceAliases } from './workspace-origins';
import { isRootAdminEmail } from './workspace-identity';
import { SignJWT, type JWTPayload } from 'jose';
import {
  isAllowedMcpRedirectURI,
  mcpAuthorizeRequestSchema,
  mcpClientRegistrationSchema,
  mcpTokenRequestSchema,
  MCP_REDIRECT_HOSTS,
  MCP_CONNECT_PATH,
  MCP_OAUTH_PATHS,
  MCP_PATH,
  MCP_SCOPES,
  parseMcpScope,
  type McpAuthorizeRequest,
  type McpAuthorizeResponse,
  type McpCallEntry,
  type McpClientPreview,
  type McpGrant,
  type McpGrantCallsResponse,
  type McpGrantsResponse,
  type McpScope,
} from '@starlings/contracts/mcp';
import { agentFreeze, frozenMessage } from './agent-freezes';
import { agentByEmail } from './agents';
import { bindInboundIdentity, inboundCallerLabel, resolveInboundKey } from './inbound-keys';
import { recordInboundRefusal } from './ops';
import { REFRESH_GRACE_MS } from './auth';
import { isAdmittedMember, requireCapability } from './capabilities';
import { INTERNAL_SIGNATURE_SKEW_MILLISECONDS, type AgentWrite, type OwnerSession } from './contracts';
import { constantTimeEqualSync, hmacSHA256Hex, randomToken, sha256 } from './crypto';
import { ACCEPTED_SESSION_ISSUERS, SESSION_ISSUER, signSessionJwt, verifySessionJwt } from './session-keys';
import { AuthError, ControlError } from './errors';
import { assertUnderRateLimit, assertWebOrigin, json, readBoundedJSON, readBoundedText } from './http';
import { mcpServerName, workspaceDisplayName } from './workspace-profile';

const ACCESS_AUDIENCE = 'meet-mcp';
const REFRESH_AUDIENCE = 'meet-mcp-refresh';
/** An hour: the client refreshes on its own, and a revoke bites within it either way — `getMcpPrincipal` reads the grant on every call. */
const ACCESS_LIFETIME = '1h';
const ACCESS_LIFETIME_SECONDS = 60 * 60;
/** As the native clients' refresh: survives a quiet month, not a departed member. */
const REFRESH_LIFETIME = '60d';
/** A code is spent within minutes or not at all. */
const CODE_LIFETIME_MS = 10 * 60 * 1000;

/**
 * Who is calling `/mcp`, and as whom.
 *
 * `session` is a person's paired Claude: the OAuth grant below, scope chosen
 * on `/connect`. `agent` is an agent living in Meet (docs/MCP.md step 5,
 * docs/AGENTS_SURFACE.md §Authority): HMAC on the inbound secret, the human
 * who addressed it as `owner`, no grant row, and never more than `read`.
 * Either way `owner` is the person every dispatched route runs as — an agent
 * has no authority of its own to run anything as.
 */
export interface McpPrincipal {
  kind: 'session' | 'agent';
  owner: OwnerSession;
  grant: Pick<McpGrant, 'client_name' | 'scopes'> & { id: string | null };
  /** An agent's roster exceptions to `read` (`AGENT_ROSTER` `writes`); absent for a session. */
  writes?: AgentWrite[];
  /** The agent's roster `sub`, for an agent; the borrowed token carries it (docs/ACCESS.md slice 2). */
  agentSub?: string;
  /**
   * The member paused this pairing in Settings. The principal
   * still resolves, so the connector stays connected and the refusal can say
   * why in words a Claude passes on; `handleMcp` refuses every call that
   * reads or writes. Absent for an agent, which is frozen at its door instead.
   */
  paused?: boolean;
}

/** The headers an agent's call carries beside the signature. */
export const MCP_AGENT_HEADER = 'x-meet-agent';
export const MCP_ACTOR_HEADER = 'x-meet-actor';

/**
 * The origin a client reached this workspace's MCP on. A client keeps the
 * host it registered against, and checks that the issuer is the host it
 * fetched the metadata from (RFC 8414). So each of the workspace's own
 * origins answers as itself: a connector registered on
 * the legacy workers.dev host keeps working after the workspace's address
 * moves (ADR 0004 §What does not move). Any other host gets
 * PUBLIC_API_ORIGIN.
 */
export function mcpOrigin(request: Request, env: Env): string {
  const origin = new URL(request.url).origin;
  return origin === env.PUBLIC_API_ORIGIN || isWorkspaceOrigin(origin, env) ? origin : env.PUBLIC_API_ORIGIN;
}

/** Every `/mcp` resource this workspace answers for: one per own origin. */
function mcpResources(env: Env): Set<string> {
  return new Set([env.PUBLIC_API_ORIGIN, env.WEB_ORIGIN, ...workspaceAliases(env)].map((origin) => `${origin}${MCP_PATH}`));
}

/** RFC 9728 — where a bearer challenge points a client that has no token yet. */
export async function mcpProtectedResourceMetadata(request: Request, env: Env): Promise<Response> {
  const origin = mcpOrigin(request, env);
  return json({
    resource: `${origin}${MCP_PATH}`,
    authorization_servers: [origin],
    scopes_supported: [...MCP_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: mcpServerName(await workspaceDisplayName(env)),
  });
}

/** RFC 8414 — the six endpoints, all on the origin the client asked. */
export function mcpAuthorizationServerMetadata(request: Request, env: Env): Response {
  const origin = mcpOrigin(request, env);
  return json({
    issuer: origin,
    authorization_endpoint: `${origin}${MCP_OAUTH_PATHS.authorize}`,
    token_endpoint: `${origin}${MCP_OAUTH_PATHS.token}`,
    registration_endpoint: `${origin}${MCP_OAUTH_PATHS.register}`,
    revocation_endpoint: `${origin}${MCP_OAUTH_PATHS.revoke}`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [...MCP_SCOPES],
  });
}

/** The 401 that starts discovery: no token, a bad token, or a revoked grant all answer the same. */
export function mcpUnauthorized(request: Request, env: Env, description: string): Response {
  const metadata = `${mcpOrigin(request, env)}${MCP_OAUTH_PATHS.protectedResource}${MCP_PATH}`;
  return new Response(JSON.stringify({ error: 'invalid_token', error_description: description }), {
    status: 401,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'www-authenticate': `Bearer resource_metadata="${metadata}", error="invalid_token", error_description="${description.replaceAll('"', "'")}"`,
    },
  });
}

/** RFC 6749 §5.2 error shape — clients match on `error`, not on prose. */
function oauthError(error: string, description: string, status = 400): Response {
  return json({ error, error_description: description }, status);
}

/**
 * RFC 7591. Unauthenticated by the spec, so the row is worth nothing on its
 * own: a client is a name and a redirect list until a person allows it on
 * `/connect`. Rate limited, bounded, and refused for any redirect that is
 * not HTTPS or loopback.
 */
export async function registerMcpClient(request: Request, env: Env): Promise<Response> {
  await assertUnderRateLimit(env.MCP_LIMIT, request, 'mcp-register');
  const parsed = mcpClientRegistrationSchema.safeParse(await readBoundedJSON(request));
  if (!parsed.success) {
    if (parsed.error.issues.some((issue) => issue.message === 'redirect_uri is not allowed')) {
      const guide = new URL('/help/howto/connect-an-agent-over-mcp', env.WEB_ORIGIN).toString();
      return oauthError(
        'invalid_client_metadata',
        `Only a member of this workspace can pair an MCP client. Accepted redirect hosts are ${MCP_REDIRECT_HOSTS.join(', ')}, localhost, 127.0.0.1, and [::1]. Read how to connect an agent over MCP: ${guide}`,
      );
    }
    throw parsed.error;
  }
  const body = parsed.data;
  // Whatever auth method the client proposed, the answer is `none`: PKCE is
  // the proof, no secret is issued, and RFC 7591 lets the server decide.
  // A client that reads the registration response uses what it says.
  const clientID = randomToken(24);
  const clientName = body.client_name ?? 'Unnamed client';
  const now = Date.now();
  await env.USAGE.prepare(
    `INSERT INTO mcp_clients (client_id, client_name, client_uri, redirect_uris, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  ).bind(clientID, clientName, body.client_uri ?? null, JSON.stringify(body.redirect_uris), now).run();
  return json({
    client_id: clientID,
    client_name: clientName,
    ...(body.client_uri ? { client_uri: body.client_uri } : {}),
    redirect_uris: body.redirect_uris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    client_id_issued_at: Math.floor(now / 1000),
  }, 201);
}

interface ClientRow {
  client_id: string;
  client_name: string;
  client_uri: string | null;
  redirect_uris: string;
}

async function clientByID(env: Env, clientID: string): Promise<ClientRow | null> {
  return env.USAGE.prepare('SELECT client_id, client_name, client_uri, redirect_uris FROM mcp_clients WHERE client_id = ?1')
    .bind(clientID)
    .first<ClientRow>();
}

/**
 * Whether a client still names a redirect Meet admits. A client registered
 * before the host list (MCP_REDIRECT_HOSTS) may name only hosts it no longer
 * admits; its grants stop working on the next call and the next refresh, so
 * no pairing made through an open redirect outlives the fix.
 */
function clientStillAdmitted(redirectURIs: string | null): boolean {
  let list: unknown;
  try {
    list = JSON.parse(redirectURIs ?? '[]');
  } catch {
    return false;
  }
  return Array.isArray(list) && list.some((uri) => typeof uri === 'string' && isAllowedMcpRedirectURI(uri));
}

function redirectAllowed(client: ClientRow, redirectURI: string): boolean {
  let list: unknown;
  try {
    list = JSON.parse(client.redirect_uris);
  } catch {
    return false;
  }
  return Array.isArray(list) && list.includes(redirectURI) && isAllowedMcpRedirectURI(redirectURI);
}

/**
 * The authorization request, checked once here and once more when `/connect`
 * posts it back. A request that fails before the client and redirect are
 * known cannot be answered by redirect (RFC 6749 §4.1.2.1), so it is a 400
 * on this origin; one that fails after can go back to the client with the
 * error in the query, and does.
 */
async function checkedAuthorizeRequest(env: Env, raw: Record<string, string>): Promise<
  | { ok: true; request: McpAuthorizeRequest; client: ClientRow; scopes: McpScope[] }
  | { ok: false; response: Response }
> {
  const parsed = mcpAuthorizeRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, response: oauthError('invalid_request', parsed.error.issues.map((issue) => issue.message).join('; ')) };
  }
  const request = parsed.data;
  const client = await clientByID(env, request.client_id);
  if (!client) return { ok: false, response: oauthError('invalid_client', 'Unknown client_id.', 401) };
  if (!redirectAllowed(client, request.redirect_uri)) {
    return { ok: false, response: oauthError('invalid_request', 'redirect_uri is not registered for this client.') };
  }
  const scopes = parseMcpScope(request.scope);
  if (!scopes) {
    return { ok: false, response: Response.redirect(withQuery(request.redirect_uri, { error: 'invalid_scope', state: request.state }), 302) };
  }
  // Any of this workspace's own `/mcp`: authorize may start on one host and
  // the consent run on WEB_ORIGIN.
  if (request.resource && !mcpResources(env).has(request.resource)) {
    return { ok: false, response: Response.redirect(withQuery(request.redirect_uri, { error: 'invalid_target', state: request.state }), 302) };
  }
  return { ok: true, request, client, scopes };
}

function withQuery(base: string, params: Record<string, string | undefined>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

/**
 * `GET /oauth/authorize` — the browser arrives from the client. The consent
 * lives in `web/` (decision 12), so this checks what it can and sends the
 * same query on to `/connect`, where the person signs in if they are not,
 * sees the client's name and scope, and allows.
 */
export async function beginMcpAuthorize(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const checked = await checkedAuthorizeRequest(env, Object.fromEntries(url.searchParams));
  if (!checked.ok) return checked.response;
  return Response.redirect(`${env.WEB_ORIGIN}${MCP_CONNECT_PATH}?${url.searchParams.toString()}`, 302);
}

/** `GET /api/mcp/client?client_id=` — what `/connect` draws: the client's own words, plus the scope asked. */
export async function previewMcpClient(request: Request, env: Env): Promise<McpClientPreview> {
  await requireCapability(request, env, 'agents');
  const url = new URL(request.url);
  const clientID = url.searchParams.get('client_id') ?? '';
  const client = await clientByID(env, clientID);
  if (!client) throw new ControlError('That client is not registered.', 404, 'request_not_found');
  const scopes = parseMcpScope(url.searchParams.get('scope'));
  if (!scopes) throw new ControlError('That scope is not one Starlings grants.', 400, 'invalid_request');
  return { client_id: client.client_id, client_name: client.client_name, client_uri: client.client_uri, scopes };
}

/**
 * `POST /api/mcp/authorize` — the person allowed. Session cookie and web origin,
 * like every other browser write; the query the client sent, checked again
 * because the SPA is a relay and not an authority. Mints a code bound to the
 * client, the redirect, the PKCE challenge and the person, and answers with
 * where the browser goes next.
 */
export async function completeMcpAuthorize(request: Request, env: Env): Promise<McpAuthorizeResponse> {
  assertWebOrigin(request, env);
  const owner = await requireCapability(request, env, 'agents');
  const body = await readBoundedJSON(request);
  const raw: Record<string, string> = {};
  if (body && typeof body === 'object') {
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (typeof value === 'string') raw[key] = value;
    }
  }
  const checked = await checkedAuthorizeRequest(env, raw);
  if (!checked.ok) {
    const location = checked.response.headers.get('location');
    if (location) return { redirect: location };
    const detail = (await checked.response.json().catch(() => null)) as { error_description?: string } | null;
    throw new ControlError(detail?.error_description ?? 'The authorization request is not valid.', 400, 'invalid_request');
  }
  const code = randomToken(32);
  const now = Date.now();
  await env.USAGE.prepare(
    `INSERT INTO mcp_codes (code_hash, client_id, sub, email, name, scope, code_challenge, redirect_uri, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  ).bind(
    await sha256(code),
    checked.client.client_id,
    owner.sub,
    owner.email,
    owner.name,
    checked.scopes.join(' '),
    checked.request.code_challenge,
    checked.request.redirect_uri,
    now + CODE_LIFETIME_MS,
  ).run();
  return { redirect: withQuery(checked.request.redirect_uri, { code, state: checked.request.state }) };
}

interface CodeRow {
  code_hash: string;
  client_id: string;
  sub: string;
  email: string;
  name: string;
  scope: string;
  code_challenge: string;
  redirect_uri: string;
  expires_at: number;
  used_at: number | null;
}

interface GrantRow {
  id: string;
  client_id: string;
  sub: string;
  email: string;
  scope: string;
  refresh_jti: string;
  previous_refresh_jti: string | null;
  renewed_at: number;
  revoked_at: number | null;
}

/** Form-encoded by the spec; JSON accepted because some clients send it. */
async function readTokenRequest(request: Request): Promise<Record<string, string>> {
  const text = await readBoundedText(request);
  const type = request.headers.get('content-type') ?? '';
  const raw: Record<string, string> = {};
  if (type.includes('application/json')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text === '' ? '{}' : text);
    } catch {
      return raw;
    }
    if (parsed && typeof parsed === 'object') {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === 'string') raw[key] = value;
      }
    }
    return raw;
  }
  for (const [key, value] of new URLSearchParams(text)) raw[key] = value;
  return raw;
}

/** A registered client nobody allowed is dropped after this long. */
export const MCP_UNUSED_CLIENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The daily pairing clean-up. `/oauth/register` is open to anyone,
 * so `mcp_clients` grows with every anonymous registration; a row whose
 * client never completed a grant in 7 days is deleted. A client with a grant
 * row, revoked or not, stays: the grant and the call record point at it.
 * An authorization code is deleted once it is past its expiry, used or not.
 */
export async function pruneMcpAuth(env: Env, now: number): Promise<{ codes: number; clients: number }> {
  const codes = await env.USAGE.prepare('DELETE FROM mcp_codes WHERE expires_at < ?1').bind(now).run();
  const clients = await env.USAGE.prepare(
    `DELETE FROM mcp_clients
     WHERE created_at < ?1
       AND NOT EXISTS (SELECT 1 FROM mcp_grants WHERE mcp_grants.client_id = mcp_clients.client_id)`,
  ).bind(now - MCP_UNUSED_CLIENT_RETENTION_MS).run();
  return { codes: codes.meta.changes ?? 0, clients: clients.meta.changes ?? 0 };
}

/** `POST /oauth/token` — both grants. */
export async function mcpToken(request: Request, env: Env): Promise<Response> {
  await assertUnderRateLimit(env.MCP_LIMIT, request, 'mcp-token');
  const parsed = mcpTokenRequestSchema.safeParse(await readTokenRequest(request));
  if (!parsed.success) return oauthError('invalid_request', parsed.error.issues.map((issue) => issue.message).join('; '));
  const body = parsed.data;
  const now = Date.now();

  if (body.grant_type === 'authorization_code') {
    const hash = await sha256(body.code);
    const code = await env.USAGE.prepare('SELECT * FROM mcp_codes WHERE code_hash = ?1').bind(hash).first<CodeRow>();
    if (!code || code.client_id !== body.client_id || code.redirect_uri !== body.redirect_uri) {
      return oauthError('invalid_grant', 'The authorization code is not valid for this client.');
    }
    if (code.used_at != null || code.expires_at < now) return oauthError('invalid_grant', 'The authorization code has expired.');
    if ((await sha256(body.code_verifier)) !== code.code_challenge) return oauthError('invalid_grant', 'PKCE verification failed.');
    // Spent before anything is minted, so a race mints nothing twice.
    const spent = await env.USAGE.prepare('UPDATE mcp_codes SET used_at = ?2 WHERE code_hash = ?1 AND used_at IS NULL')
      .bind(hash, now).run();
    if ((spent.meta.changes ?? 0) !== 1) return oauthError('invalid_grant', 'The authorization code has expired.');

    const owner: OwnerSession = { sub: code.sub, email: code.email, name: code.name };
    const jti = randomToken(16);
    const existing = await env.USAGE.prepare('SELECT id FROM mcp_grants WHERE client_id = ?1 AND sub = ?2')
      .bind(code.client_id, code.sub).first<{ id: string }>();
    const grantID = existing?.id ?? randomToken(16);
    // A second pairing with the same client is the same grant renewed —
    // un-revoked, re-scoped to what the person just allowed, and given a
    // fresh refresh token. One row per (client, person), always. A pause
    // survives it: pausing is undone with Resume, never by pairing again.
    await env.USAGE.prepare(
      `INSERT INTO mcp_grants (id, client_id, sub, email, scope, refresh_jti, previous_refresh_jti, renewed_at, created_at, last_call_at, revoked_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?7, NULL, NULL)
       ON CONFLICT (client_id, sub) DO UPDATE SET
         email = excluded.email, scope = excluded.scope, refresh_jti = excluded.refresh_jti,
         previous_refresh_jti = NULL, renewed_at = excluded.renewed_at, revoked_at = NULL`,
    ).bind(grantID, code.client_id, code.sub, code.email, code.scope, jti, now).run();
    return tokenResponse(env, owner, grantID, code.client_id, code.scope, jti);
  }

  let payload: JWTPayload;
  try {
    ({ payload } = await verifySessionJwt(body.refresh_token, env, { issuer: ACCEPTED_SESSION_ISSUERS, audience: REFRESH_AUDIENCE }));
  } catch {
    return oauthError('invalid_grant', 'The refresh token is not valid.');
  }
  const grantID = typeof payload.grant === 'string' ? payload.grant : '';
  const jti = typeof payload.jti === 'string' ? payload.jti : '';
  const grant = grantID ? await grantByID(env, grantID) : null;
  if (!grant || grant.revoked_at != null || (body.client_id && body.client_id !== grant.client_id)) {
    return oauthError('invalid_grant', 'The refresh token is not valid.');
  }
  const client = await clientByID(env, grant.client_id);
  if (!client || !clientStillAdmitted(client.redirect_uris)) {
    return oauthError('invalid_grant', 'This client is no longer admitted. Pair it again.');
  }
  const current = grant.refresh_jti === jti;
  const withinGrace = !current && grant.previous_refresh_jti === jti && now - grant.renewed_at < REFRESH_GRACE_MS;
  if (!current && !withinGrace) return oauthError('invalid_grant', 'The refresh token has been used.');
  const person = await personStanding(env, grant.sub);
  if (person.revoked && !isRootAdminEmail(env, grant.email)) return oauthError('invalid_grant', 'This account can no longer sign in to Starlings.');
  // A narrower scope may be asked for on renewal; a wider one never.
  const askedScopes = body.scope ? parseMcpScope(body.scope) : null;
  const grantScopes = parseMcpScope(grant.scope) ?? ['read'];
  if (body.scope && (!askedScopes || askedScopes.some((scope) => !grantScopes.includes(scope)))) {
    return oauthError('invalid_scope', 'The refresh token does not carry that scope.');
  }
  const scope = (askedScopes ?? grantScopes).join(' ');
  const nextJti = randomToken(16);
  if (current) {
    await env.USAGE.prepare(
      'UPDATE mcp_grants SET refresh_jti = ?2, previous_refresh_jti = ?3, renewed_at = ?4 WHERE id = ?1 AND refresh_jti = ?3',
    ).bind(grantID, nextJti, jti, now).run();
  }
  const owner: OwnerSession = { sub: grant.sub, email: grant.email, name: person.name ?? grant.email };
  return tokenResponse(env, owner, grantID, grant.client_id, scope, current ? nextJti : grant.refresh_jti);
}

async function tokenResponse(env: Env, owner: OwnerSession, grantID: string, clientID: string, scope: string, refreshJti: string): Promise<Response> {
  const accessToken = await signSessionJwt(new SignJWT({ email: owner.email, name: owner.name, scope, grant: grantID, client: clientID })
    .setIssuer(SESSION_ISSUER)
    .setAudience(ACCESS_AUDIENCE)
    .setSubject(owner.sub)
    .setIssuedAt()
    .setExpirationTime(ACCESS_LIFETIME), env);
  const refreshToken = await signSessionJwt(new SignJWT({ grant: grantID })
    .setIssuer(SESSION_ISSUER)
    .setAudience(REFRESH_AUDIENCE)
    .setSubject(owner.sub)
    .setJti(refreshJti)
    .setIssuedAt()
    .setExpirationTime(REFRESH_LIFETIME), env);
  return json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_LIFETIME_SECONDS,
    refresh_token: refreshToken,
    scope,
  });
}

async function grantByID(env: Env, id: string): Promise<GrantRow | null> {
  return env.USAGE.prepare('SELECT * FROM mcp_grants WHERE id = ?1').bind(id).first<GrantRow>();
}

/** Unreachable D1 hands out nothing: fail closed, as `personForRenewal` does. */
async function personStanding(env: Env, sub: string): Promise<{ revoked: boolean; name: string | null }> {
  try {
    const row = await env.USAGE.prepare('SELECT revoked_at, name FROM people WHERE sub = ?1')
      .bind(sub).first<{ revoked_at: number | null; name: string | null }>();
    return { revoked: row?.revoked_at != null, name: row?.name ?? null };
  } catch (error) {
    console.error('MCP standing check failed', { reason: error instanceof Error ? error.message : 'unknown' });
    throw new AuthError('Sign in again to continue.', 401, 'session_expired');
  }
}

/**
 * `POST /oauth/revoke` (RFC 7009). A refresh token revokes its grant; an
 * access token revokes the grant it names. Either way the answer is 200,
 * because the spec says a caller learns nothing from this route.
 */
export async function mcpRevoke(request: Request, env: Env): Promise<Response> {
  await assertUnderRateLimit(env.MCP_LIMIT, request, 'mcp-revoke');
  const raw = await readTokenRequest(request);
  const token = raw.token ?? '';
  if (token) {
    for (const audience of [REFRESH_AUDIENCE, ACCESS_AUDIENCE]) {
      try {
        const { payload } = await verifySessionJwt(token, env, { issuer: ACCEPTED_SESSION_ISSUERS, audience });
        if (typeof payload.grant === 'string') await revokeMcpGrant(env, payload.grant, typeof payload.sub === 'string' ? payload.sub : null);
        break;
      } catch {
        // Not this audience, or not ours. The next one, or nothing.
      }
    }
  }
  return json({ ok: true });
}

/** Revoke in place. `sub` when known, so a token can only revoke its own person's grant. */
export async function revokeMcpGrant(env: Env, grantID: string, sub: string | null): Promise<void> {
  await env.USAGE.prepare(
    `UPDATE mcp_grants SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL${sub ? ' AND sub = ?3' : ''}`,
  ).bind(...(sub ? [grantID, Date.now(), sub] : [grantID, Date.now()])).run();
}

/**
 * Who is calling `/mcp`. The access token names the grant; the grant row is
 * read on every call so a revoke bites on the next one, not after the token's
 * hour. Anything short of a live grant for a member in good standing is the
 * same 401 with the discovery pointer. A paused grant is live: it resolves
 * with `paused`, and `handleMcp` refuses its calls in words.
 */
export async function getMcpPrincipal(request: Request, env: Env): Promise<McpPrincipal | null> {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return null;
  const token = authorization.slice(7).trim();
  let payload: JWTPayload;
  try {
    ({ payload } = await verifySessionJwt(token, env, { issuer: ACCEPTED_SESSION_ISSUERS, audience: ACCESS_AUDIENCE }));
  } catch {
    return null;
  }
  if (typeof payload.sub !== 'string' || typeof payload.email !== 'string' || typeof payload.grant !== 'string') return null;
  // The same member gate as every internal route: a domain member, a root
  // admin, or an accepted invitation.
  if (!(await isAdmittedMember(env, payload.email))) return null;
  const grant = await env.USAGE.prepare(
    `SELECT g.id, g.scope, g.sub, g.revoked_at, g.paused_at, c.client_name, c.redirect_uris
     FROM mcp_grants g LEFT JOIN mcp_clients c ON c.client_id = g.client_id
     WHERE g.id = ?1`,
  ).bind(payload.grant).first<{ id: string; scope: string; sub: string; revoked_at: number | null; paused_at: number | null; client_name: string | null; redirect_uris: string | null }>();
  if (!grant || grant.sub !== payload.sub || grant.revoked_at != null) return null;
  if (!clientStillAdmitted(grant.redirect_uris)) return null;
  const person = await personStanding(env, payload.sub);
  if (person.revoked && !isRootAdminEmail(env, payload.email)) return null;
  const scopes = parseMcpScope(typeof payload.scope === 'string' ? payload.scope : grant.scope) ?? ['read'];
  return {
    kind: 'session',
    owner: { sub: payload.sub, email: payload.email, name: typeof payload.name === 'string' ? payload.name : payload.email },
    grant: { id: grant.id, client_name: grant.client_name ?? 'Unnamed client', scopes },
    ...(grant.paused_at != null ? { paused: true } : {}),
  };
}

/** Whether a request is an agent's, by the header only — verified by `getAgentMcpPrincipal`. */
export function isAgentMcpRequest(request: Request): boolean {
  return request.headers.has(MCP_AGENT_HEADER);
}

/**
 * The agent principal (docs/MCP.md build order step 5).
 *
 * An agent never holds a session, so it cannot pair over OAuth; it signs the
 * way it signs everything else it says to Meet — `x-internal-timestamp` and
 * `x-internal-signature`, HMAC-SHA256 on its own inbound key, named in
 * `x-internal-key-id` (`inbound-keys.ts`) — and
 * names two addresses beside the signature: itself (`x-meet-agent`) and the
 * person it is working for (`x-meet-actor`). Both are inside the signed
 * string, so a captured call cannot be replayed as somebody else within the
 * clock window.
 *
 * Five locks, in order, and every refusal is a 403 rather than the OAuth
 * 401 — nothing here should start a pairing dance:
 *
 * 1. The door does not exist without the secret (as `internal.ts`).
 * 2. A session token on the request is a caller confusing two doors.
 * 3. The signature, inside the window, under the key the request names.
 * 4. The agent is the one that key was issued to, and one `AGENT_ROSTER`
 *    names. A key held by one agent cannot speak as another, Core's cannot
 *    speak as any, and a human address is refused outright, so possession of
 *    a secret does not let anything read as a colleague. A request with no
 *    key id answers 404: the old shared secret is gone (,
 *    inbound-keys.ts). An agent an admin froze
 *    (`agent_freezes`) is refused here, whatever else holds.
 * 5. The actor is a `people` row of `kind = 'human'` in good standing who
 *    has addressed this agent — an `agent_addressers` row, written on every
 *    accepted hand-off (a DM line or a channel @mention), or, for DMs that
 *    predate that table, a shared `thread_members` row. Borrowed authority
 *    is only borrowable from somebody who actually spoke to the agent; a
 *    runtime holding the secret cannot pick an arbitrary member to read as.
 *
 * Scope is always `read`. There is no `write` scope for an agent through this
 * door: a task it wants created is a proposal to the person, who creates it.
 * The one exception is a write its roster entry names (`writes`, one tool and
 * for `cms` one entity), carried here and checked per call in `tools/call`.
 */
export async function getAgentMcpPrincipal(request: Request, env: Env, rawBody: string): Promise<McpPrincipal> {
  const inbound = await resolveInboundKey(request, env);
  if (request.headers.get('authorization')) {
    throw new AuthError('An agent does not carry a session.', 403, 'owner_auth_required');
  }

  const agentEmail = (request.headers.get(MCP_AGENT_HEADER) ?? '').trim().toLowerCase();
  const actorEmail = (request.headers.get(MCP_ACTOR_HEADER) ?? '').trim().toLowerCase();
  const timestamp = request.headers.get('x-internal-timestamp') ?? '';
  const signature = request.headers.get('x-internal-signature') ?? '';
  const sentAt = Number(timestamp);
  if (!agentEmail || !actorEmail || !timestamp || !signature || !Number.isFinite(sentAt)) {
    throw new AuthError('Request is not signed.', 403, 'owner_auth_required');
  }
  // A refusal is counted against the key that signed, never against the
  // header: that is the caller's text, never a row key.
  const caller = await inboundCallerLabel(env, inbound.key);
  if (Math.abs(Date.now() - sentAt) > INTERNAL_SIGNATURE_SKEW_MILLISECONDS) {
    await recordInboundRefusal(env, caller, 'expired');
    throw new AuthError('Signature has expired.', 403, 'owner_auth_required');
  }
  const expected = await hmacSHA256Hex(inbound.secret, `${timestamp}.${agentEmail}.${actorEmail}.${rawBody}`);
  if (!constantTimeEqualSync(expected, signature.trim().toLowerCase())) {
    await recordInboundRefusal(env, caller, 'mismatch');
    throw new AuthError('Signature does not match.', 403, 'owner_auth_required');
  }

  // The key may only speak as the agent it was issued to. A
  // signature that verifies under another agent's key, or under Core's,
  // proves possession of that key and nothing about this agent.
  await bindInboundIdentity(env, inbound, 'mcp', agentEmail);
  const agent = await agentByEmail(env, agentEmail);
  if (!agent) throw new AuthError('That agent is not on the roster.', 403, 'capability_denied');
  // Frozen by an admin: read per call, so it bites on the next one.
  if (await agentFreeze(env, agent.sub)) throw new AuthError(frozenMessage(agent.name), 403, 'capability_denied');
  if (!(await isAdmittedMember(env, actorEmail))) {
    throw new AuthError('That actor is not on the team.', 403, 'capability_denied');
  }

  const actor = await env.USAGE.prepare(
    `SELECT p.sub, p.email, p.name, p.revoked_at,
            EXISTS (
              SELECT 1 FROM agent_addressers x WHERE x.agent_sub = ?2 AND x.actor_sub = p.sub
            ) OR EXISTS (
              SELECT 1 FROM thread_members a
              JOIN thread_members b ON b.thread_id = a.thread_id
              WHERE a.member_sub = ?2 AND b.member_sub = p.sub
            ) AS addressed
     FROM people p WHERE p.email = ?1 AND p.kind = 'human'`,
  ).bind(actorEmail, agent.sub).first<{ sub: string; email: string; name: string | null; revoked_at: number | null; addressed: number }>();
  if (!actor || actor.revoked_at != null) {
    throw new AuthError('That actor is not on the team.', 403, 'capability_denied');
  }
  if (!actor.addressed) {
    throw new AuthError('That person has not addressed this agent.', 403, 'capability_denied');
  }

  return {
    kind: 'agent',
    owner: { sub: actor.sub, email: actor.email, name: actor.name ?? actor.email },
    grant: { id: null, client_name: agent.name, scopes: ['read'] },
    ...(agent.writes?.length ? { writes: agent.writes } : {}),
    agentSub: agent.sub,
  };
}

/** A person's own pairings, for the Connected agents section (build order step 3) and Admin. */
export async function listMcpGrants(env: Env, sub: string | null): Promise<McpGrant[]> {
  const { results } = await env.USAGE.prepare(
    `SELECT g.id, g.client_id, c.client_name, g.scope, g.created_at, g.last_call_at, g.revoked_at, g.paused_at
     FROM mcp_grants g LEFT JOIN mcp_clients c ON c.client_id = g.client_id
     ${sub ? 'WHERE g.sub = ?1' : ''}
     ORDER BY g.created_at DESC LIMIT 100`,
  ).bind(...(sub ? [sub] : [])).all<{ id: string; client_id: string; client_name: string | null; scope: string; created_at: number; last_call_at: number | null; revoked_at: number | null; paused_at: number | null }>();
  return results.map((row) => ({
    id: row.id,
    client_id: row.client_id,
    client_name: row.client_name ?? 'Unnamed client',
    scopes: parseMcpScope(row.scope) ?? ['read'],
    created_at: row.created_at,
    last_call_at: row.last_call_at,
    revoked_at: row.revoked_at,
    paused_at: row.paused_at,
  }));
}

/** `GET /api/mcp/grants` — the session-holder's own pairings, for Connected agents in Settings. */
export async function ownMcpGrants(request: Request, env: Env): Promise<McpGrantsResponse> {
  const owner = await requireSession(request, env);
  return { grants: await activeGrants(env, owner.sub) };
}

/** Settings shows what can still call; a revoked pairing is history, kept for the record. */
async function activeGrants(env: Env, sub: string): Promise<McpGrant[]> {
  return (await listMcpGrants(env, sub)).filter((grant) => grant.revoked_at == null);
}

/**
 * `POST /api/mcp/grants/<id>/revoke` — the Revoke button. Scoped to the
 * caller's own grant: a grant id that is somebody else's answers the same
 * 404 a missing one does.
 */
export async function revokeOwnMcpGrant(request: Request, env: Env, grantID: string): Promise<McpGrantsResponse> {
  const owner = await requireSession(request, env);
  const grant = await env.USAGE.prepare('SELECT id FROM mcp_grants WHERE id = ?1 AND sub = ?2')
    .bind(grantID, owner.sub).first<{ id: string }>();
  if (!grant) throw new ControlError('That connector is not yours.', 404, 'request_not_found');
  await revokeMcpGrant(env, grantID, owner.sub);
  return { grants: await activeGrants(env, owner.sub) };
}

/**
 * `POST /api/mcp/grants/<id>/pause` and `/resume` — the Pause button
 *. Owner-scoped exactly like Revoke: somebody else's grant, or a
 * revoked one, answers the same 404 a missing one does. Pausing keeps the
 * pairing and its refresh token, so the Claude stays connected and is told
 * why each call is refused; Resume lets the next call through. Pausing twice
 * keeps the first time.
 */
export async function setOwnMcpGrantPaused(request: Request, env: Env, grantID: string, paused: boolean): Promise<McpGrantsResponse> {
  const owner = await requireSession(request, env);
  const grant = await env.USAGE.prepare('SELECT id FROM mcp_grants WHERE id = ?1 AND sub = ?2 AND revoked_at IS NULL')
    .bind(grantID, owner.sub).first<{ id: string }>();
  if (!grant) throw new ControlError('That connector is not yours.', 404, 'request_not_found');
  await env.USAGE.prepare(
    paused
      ? 'UPDATE mcp_grants SET paused_at = ?3 WHERE id = ?1 AND sub = ?2 AND paused_at IS NULL'
      : 'UPDATE mcp_grants SET paused_at = NULL WHERE id = ?1 AND sub = ?2',
  ).bind(...(paused ? [grantID, owner.sub, Date.now()] : [grantID, owner.sub])).run();
  return { grants: await activeGrants(env, owner.sub) };
}

/** `GET /api/mcp/grants/<id>/calls` — the tail of one connector's record, the caller's own. */
export async function ownMcpGrantCalls(request: Request, env: Env, grantID: string): Promise<McpGrantCallsResponse> {
  const owner = await requireSession(request, env);
  const { results } = await env.USAGE.prepare(
    `SELECT id, ts, principal, actor_email, client_name, method, name, args, outcome, detail, duration_ms, replayed
     FROM mcp_calls WHERE grant_id = ?1 AND actor_sub = ?2 ORDER BY ts DESC LIMIT 50`,
  ).bind(grantID, owner.sub).all<McpCallEntry>();
  return { calls: results.map((call) => ({ ...call, replayed: Boolean(call.replayed) })) };
}

async function requireSession(request: Request, env: Env): Promise<OwnerSession> {
  return requireCapability(request, env, 'agents');
}
