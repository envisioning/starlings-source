// The public half of the auth Worker (docs/CENTRAL_AUTH.md): the
// browser sees the sign-in screen here, starts Google here, and
// Google returns here. Nothing on this host
// sets a workspace session, serves a workspace page or answers a private API.
import { optionalSecret } from '../shared-secrets';
import {
  BROWSER_AUTH_KINDS,
  CENTRAL_AUTH_CALLBACK_PATHS,
  CENTRAL_AUTH_COMPLETE_PATHS,
  CENTRAL_AUTH_SIGN_OUT_PATH,
  CENTRAL_AUTH_START_PATH,
  centralAuthCallbackQuerySchema,
  centralAuthStartQuerySchema,
  type BrowserAuthKind,
  type CentralAuthResult,
} from '@starlings/contracts/browser-auth';
import type { GoogleGrantProduct } from '@starlings/contracts/google-grant-products';
import { AuthError, ControlError } from '../errors';
import {
  beginGoogleOAuth,
  exchangeGoogleAuthorizationCode,
  googleAuthorizationURL,
  unsealGoogleOAuthState,
  verifyGoogleIdentity,
  type OAuthStateSeal,
} from '../google-oauth';
import { CALENDAR_OAUTH_SCOPES, GOOGLE_GRANT_SCOPES } from '../google-scopes';
import { cookie, expiredCookie, readCookie, redirectWithCookies } from '../http-cookies';
import { claimAttempt, finishAttempt, isReturnOrigin, pendingAttempt, startedAttempt, type AttemptRow } from './attempts';
import type { AuthEnv } from './env';
import { signInScreenHeaders, signInScreenHTML } from './screen';
import {
  addSessionPlace,
  endBrowserSession,
  readBrowserSession,
  sessionFitsDomain,
  sessionKnows,
  startBrowserSession,
  type BrowserSession,
  type SessionPlace,
} from './sessions';

const STATE_AUDIENCE = 'central-browser-oauth';
/** `__Host-`: Secure, Path=/, no Domain. A sibling host cannot plant one. One per attempt, so tabs do not collide. */
const oauthCookie = (state: string) => `__Host-starlings_auth_oauth_${state}`;

interface CentralState extends OAuthStateSeal {
  ticket: string;
  kind: BrowserAuthKind;
}

function noStore(response: Response): Response {
  response.headers.set('cache-control', 'no-store');
  response.headers.set('referrer-policy', 'no-referrer');
  response.headers.set('x-robots-tag', 'noindex');
  return response;
}

function redirect(location: string, cookies: string[]): Response {
  return noStore(redirectWithCookies(location, cookies));
}

function usable(value: string | undefined): value is string {
  return Boolean(value?.trim()) && !value!.startsWith('replace-with-');
}

function clientFor(env: AuthEnv, kind: BrowserAuthKind): string {
  const client = kind === 'google-grant'
    ? env.GOOGLE_CONNECTOR_CLIENT_ID
    : kind === 'calendar' && usable(env.GOOGLE_CALENDAR_CLIENT_ID) ? env.GOOGLE_CALENDAR_CLIENT_ID : env.GOOGLE_WEB_CLIENT_ID;
  if (!usable(client)) throw new AuthError('Google sign-in is not configured.', 503, 'not_configured');
  return client;
}

function scopeFor(attempt: AttemptRow): string {
  if (attempt.kind === 'login') return 'openid email profile';
  if (attempt.kind === 'calendar') return `openid email profile ${CALENDAR_OAUTH_SCOPES}`;
  const scope = GOOGLE_GRANT_SCOPES[attempt.product as GoogleGrantProduct];
  if (!scope) throw new AuthError('Unknown Google product.', 400, 'oauth_failed');
  return `openid email ${scope}`;
}

/** The same Google parameters as each direct flow in auth.ts, calendar.ts and google-grants.ts. */
function extraParamsFor(attempt: AttemptRow): Record<string, string> {
  if (attempt.kind === 'login') return { prompt: 'select_account' };
  return {
    access_type: 'offline',
    include_granted_scopes: 'true',
    prompt: 'consent',
    ...(attempt.kind === 'google-grant' && attempt.login_hint ? { login_hint: attempt.login_hint } : {}),
  };
}

function callbackURI(env: AuthEnv, kind: BrowserAuthKind): string {
  return `${env.AUTH_ORIGIN}${CENTRAL_AUTH_CALLBACK_PATHS[kind]}`;
}

const EXPIRED = 'This sign-in request expired or was already used. Start again from your workspace.';

/**
 * GET /api/auth/central/start?ticket=… — sign-in shows the screen and
 * changes nothing; the button POSTs. Consent (Calendar, a connector) began
 * with the member's own click on "Connect", so it goes to Google at once.
 *
 * With an auth session (sessions.ts) that already signed in to this origin
 * or its workspace, sign-in answers at once, with no screen and no Google.
 * With a session that has not, the screen offers to continue as that
 * account: one click, still no Google.
 */
export async function showCentralSignIn(request: Request, env: AuthEnv): Promise<Response> {
  const query = centralAuthStartQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) throw new AuthError('This sign-in link is not valid. Start again from your workspace.', 400, 'oauth_failed');
  const attempt = await pendingAttempt(env, query.data.ticket);
  if (!attempt || !isReturnOrigin(attempt.workspace_origin, env)) throw new AuthError(EXPIRED, 400, 'oauth_failed');
  if (attempt.kind !== 'login') return startCentralGoogleAuth(env, attempt.ticket);
  const session = await usableSession(request, env, attempt);
  if (session && sessionKnows(session, placeOf(attempt))) return finishWithSession(env, attempt.ticket, session);
  const screen = {
    ticket: attempt.ticket,
    workspaceOrigin: attempt.workspace_origin,
    workspaceName: attempt.workspace_name,
    markPath: attempt.mark_path,
    accent: attempt.accent,
    returnPath: attempt.return_path,
    continueAs: session?.identity.email ?? null,
  };
  const response = noStore(new Response(signInScreenHTML(screen), { headers: signInScreenHeaders(screen) }));
  // Not no-referrer here: with it, Chrome posts the button's form with
  // `Origin: null` and continueCentralSignIn refuses it. same-origin still
  // sends nothing to another host; the 303 to Google is no-referrer.
  response.headers.set('referrer-policy', 'same-origin');
  return response;
}

/**
 * POST /api/auth/central/start — the screen's button. Only a form on this
 * host may post it: a browser sends Origin on every POST, and a missing or
 * foreign one is refused.
 */
export async function continueCentralSignIn(request: Request, env: AuthEnv): Promise<Response> {
  if (request.headers.get('origin') !== env.AUTH_ORIGIN) throw new AuthError('Start again from your workspace.', 403, 'untrusted_origin');
  const form = await request.formData().catch(() => null);
  const query = centralAuthStartQuerySchema.safeParse({ ticket: form?.get('ticket') });
  if (!query.success) throw new AuthError('This sign-in link is not valid. Start again from your workspace.', 400, 'oauth_failed');
  if (form?.get('with') === 'session') {
    const attempt = await pendingAttempt(env, query.data.ticket);
    if (!attempt || attempt.kind !== 'login') throw new AuthError(EXPIRED, 400, 'oauth_failed');
    const session = await usableSession(request, env, attempt);
    if (session) return finishWithSession(env, attempt.ticket, session);
  }
  return startCentralGoogleAuth(env, query.data.ticket);
}

/** Where an attempt signs in: its origin, and the workspace its caller's binding named. */
function placeOf(attempt: AttemptRow): SessionPlace {
  return { origin: attempt.workspace_origin, workspace: attempt.workspace };
}

/** This browser's auth session, when its account fits the attempt's Google domain. */
async function usableSession(request: Request, env: AuthEnv, attempt: AttemptRow): Promise<BrowserSession | null> {
  const session = await readBrowserSession(request, env);
  return session && sessionFitsDomain(session, attempt.hosted_domain) ? session : null;
}

/**
 * Answer a sign-in from the auth session: claim the attempt once, seal the
 * identity Google proved when the session began, and send the browser back
 * with a code, as the Google callback does. The workspace still decides.
 */
async function finishWithSession(env: AuthEnv, ticket: string, session: BrowserSession): Promise<Response> {
  const attempt = await claimAttempt(env, ticket);
  if (!attempt || attempt.kind !== 'login' || !isReturnOrigin(attempt.workspace_origin, env)
    || !sessionFitsDomain(session, attempt.hosted_domain)) {
    throw new AuthError(EXPIRED, 400, 'oauth_failed');
  }
  const code = await finishAttempt(env, attempt.ticket, { kind: 'login', ...session.identity });
  if (!code) throw new AuthError(EXPIRED, 400, 'oauth_failed');
  await addSessionPlace(env, session, placeOf(attempt));
  return redirect(completeURL(attempt, code), []);
}

function completeURL(attempt: AttemptRow, code: string): string {
  const back = new URL(CENTRAL_AUTH_COMPLETE_PATHS[attempt.kind], attempt.workspace_origin);
  back.searchParams.set('ticket', attempt.ticket);
  back.searchParams.set('code', code);
  return back.toString();
}

/** Claim the attempt once and send the browser to Google. 303: a POST becomes a GET. */
async function startCentralGoogleAuth(env: AuthEnv, ticket: string): Promise<Response> {
  const attempt = await claimAttempt(env, ticket);
  if (!attempt || !isReturnOrigin(attempt.workspace_origin, env)) throw new AuthError(EXPIRED, 400, 'oauth_failed');
  const clientID = clientFor(env, attempt.kind);
  const oauth = await beginGoogleOAuth({
    signingSecret: env.AUTH_SIGNING_SECRET,
    audience: STATE_AUDIENCE,
    returnTo: '/',
    extraClaims: { ticket: attempt.ticket, kind: attempt.kind },
  });
  const google = googleAuthorizationURL({
    clientID,
    redirectURI: callbackURI(env, attempt.kind),
    scope: scopeFor(attempt),
    state: oauth.state,
    nonce: oauth.nonce,
    challenge: oauth.challenge,
    hostedDomain: attempt.hosted_domain,
    extraParams: extraParamsFor(attempt),
  });
  const response = redirect(google, [cookie(oauthCookie(oauth.state), oauth.sealedState, 600)]);
  return new Response(null, { status: 303, headers: response.headers });
}

/**
 * Google returns to the callback for `kind`. Sign-in: exchange the code and
 * prove the identity here. Consent: keep the Google code sealed for the
 * workspace, which exchanges it itself. Either way the browser leaves with an
 * opaque ticket and a single-use code, nothing else.
 */
export async function completeCentralGoogleAuth(request: Request, env: AuthEnv, kind: BrowserAuthKind): Promise<Response> {
  const query = centralAuthCallbackQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) throw new AuthError('The Google response is incomplete.', 400, 'oauth_failed');
  const sealedState = readCookie(request, oauthCookie(query.data.state));
  if (!sealedState) throw new AuthError('The Google response is incomplete.', 400, 'oauth_failed');
  const state = await unsealGoogleOAuthState<CentralState>({
    sealedState,
    returnedState: query.data.state,
    signingSecret: env.AUTH_SIGNING_SECRET,
    audience: STATE_AUDIENCE,
  }).catch((error: unknown) => {
    if (error instanceof ControlError) throw error;
    throw new AuthError('The Google response expired. Start again from your workspace.', 400, 'oauth_failed');
  });
  if (state.kind !== kind) throw new AuthError('OAuth purpose did not match.', 400, 'oauth_failed');
  const attempt = await startedAttempt(env, state.ticket);
  if (!attempt || attempt.kind !== kind || !isReturnOrigin(attempt.workspace_origin, env)) throw new AuthError(EXPIRED, 400, 'oauth_failed');

  let result: CentralAuthResult;
  if (query.data.error) {
    result = { kind: 'cancelled' };
  } else if (!query.data.code) {
    throw new AuthError('The Google response is incomplete.', 400, 'oauth_failed');
  } else if (kind !== 'login') {
    result = {
      kind: 'consent',
      code: query.data.code,
      verifier: state.verifier,
      nonce: state.nonce,
      redirectUri: callbackURI(env, kind),
      clientId: clientFor(env, kind),
    };
  } else {
    result = await signInResult(env, query.data.code, state);
  }

  const code = await finishAttempt(env, attempt.ticket, result);
  if (!code) throw new AuthError(EXPIRED, 400, 'oauth_failed');
  const cookies = [expiredCookie(oauthCookie(query.data.state))];
  // Only a proven sign-in starts the auth session; consent and a
  // cancellation leave it as it was.
  if (result.kind === 'login') {
    const { kind: _kind, ...identity } = result;
    cookies.push(await startBrowserSession(request, env, identity, placeOf(attempt)));
  }
  return redirect(completeURL(attempt, code), cookies);
}

/**
 * GET /api/auth/central/sign-out?return_to=<origin> — end this browser's
 * auth session. A workspace sends the browser here after its own sign-out.
 * It returns only to an origin this Worker serves; anything else ends here.
 * A GET, not a form: a third party that signs someone out of the auth host
 * gains nothing, and the workspace's own session is already gone.
 */
async function signOutCentral(request: Request, env: AuthEnv): Promise<Response> {
  const clear = await endBrowserSession(request, env);
  const returnTo = new URL(request.url).searchParams.get('return_to');
  if (returnTo && isReturnOrigin(returnTo, env)) return redirect(`${returnTo}/`, [clear]);
  const response = noStore(new Response('Signed out.', { headers: { 'content-type': 'text/plain; charset=utf-8' } }));
  response.headers.append('set-cookie', clear);
  return response;
}

/** Prove who signed in. The workspace, not this Worker, decides whether they may. */
async function signInResult(env: AuthEnv, code: string, state: CentralState): Promise<CentralAuthResult> {
  const exchanged = await exchangeGoogleAuthorizationCode({
    code,
    codeVerifier: state.verifier,
    redirectURI: callbackURI(env, 'login'),
    clientID: clientFor(env, 'login'),
    ...await optionalSecret(env, 'GOOGLE_WEB_CLIENT_SECRET'),
  });
  if (!exchanged.ok) {
    console.error(JSON.stringify({ level: 'error', message: 'auth.google.exchange_rejected', reason: exchanged.reason }));
    throw new AuthError('Google rejected the authorization code.', 401, 'oauth_failed');
  }
  if (typeof exchanged.body.id_token !== 'string') throw new AuthError('Google did not return an identity token.', 401, 'oauth_failed');
  const identity = await verifyGoogleIdentity(exchanged.body.id_token, {
    audience: clientFor(env, 'login'),
    nonce: state.nonce,
    failureMessage: 'Google could not verify this account.',
  });
  if (typeof identity.name !== 'string' || !identity.name) throw new AuthError('Google did not return a name for this account.', 403, 'oauth_failed');
  return {
    kind: 'login',
    sub: identity.sub,
    email: identity.email.toLowerCase(),
    name: identity.name,
    ...(typeof identity.hd === 'string' ? { hd: identity.hd } : {}),
    ...(typeof identity.picture === 'string' ? { picture: identity.picture } : {}),
  };
}

const CALLBACKS = new Map<string, BrowserAuthKind>(BROWSER_AUTH_KINDS.map((kind) => [CENTRAL_AUTH_CALLBACK_PATHS[kind], kind]));

/**
 * The whole public surface on AUTH_ORIGIN: the start path (GET shows the
 * screen, POST continues), three GET callbacks and the GET sign-out.
 * Everything else is a 404.
 */
export async function handleAuthFetch(request: Request, env: AuthEnv): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (request.method === 'POST' && url.origin === env.AUTH_ORIGIN && url.pathname === CENTRAL_AUTH_START_PATH) {
      return await continueCentralSignIn(request, env);
    }
    if (request.method === 'GET' && url.origin === env.AUTH_ORIGIN) {
      if (url.pathname === CENTRAL_AUTH_START_PATH) return await showCentralSignIn(request, env);
      if (url.pathname === CENTRAL_AUTH_SIGN_OUT_PATH) return await signOutCentral(request, env);
      const kind = CALLBACKS.get(url.pathname);
      if (kind) return await completeCentralGoogleAuth(request, env, kind);
    }
    return noStore(new Response('Not found.', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } }));
  } catch (error) {
    const known = error instanceof ControlError;
    if (!known) console.error(JSON.stringify({ level: 'error', message: 'auth.request.failed', path: url.pathname, error: error instanceof Error ? error.name : 'unknown' }));
    const status = known ? error.status : 500;
    const message = known ? error.message : 'Sign-in failed. Start again from your workspace.';
    return noStore(new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } }));
  }
}
