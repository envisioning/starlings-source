// Connect GitHub, the workspace side (docs/GITHUB_CONNECTOR.md "Connecting").
//
// An admin presses Connect GitHub. The workspace asks the token broker in
// starlings-auth for an attempt over its `GITHUB` binding, keeps a browser
// secret in a host-only cookie, and sends the browser to the App's install
// page. The broker checks on its own host that the person can reach the
// installation, and sends the browser back here with a single-use code. This
// side redeems the code with the browser secret; only then does the broker
// record the installation for this workspace. The same shape as central sign-in
// (central-auth.ts): the binding's props name the workspace, no argument does.
import {
  GITHUB_BROKER_VERSION,
  githubBeginResultSchema,
  githubCompleteQuerySchema,
  githubCompleteResultSchema,
  githubDisconnectResultSchema,
} from '@starlings/contracts/github-app';
import type { ConnectorReverseResponse } from './contracts';
import { randomToken, sha256 } from './crypto';
import { ControlError } from './errors';
import { githubBroker, resetGithubTokenCache } from './github-app';
import { assertUnderRateLimit } from './http';
import { cookie, expiredCookie, readCookie, redirectWithCookies } from './http-cookies';

/** The browser half of the attempt: a host-only cookie per attempt, so two tabs do not collide. */
const bridgeCookie = (ticket: string) => `__Host-meet_github_bridge_${ticket}`;
const ATTEMPT_COOKIE_SECONDS = 600;
/** Where the admin lands, connected or not. */
const PAGE_PATH = '/admin/connectors/github';

function noStore(response: Response): Response {
  response.headers.set('cache-control', 'no-store');
  response.headers.set('referrer-policy', 'no-referrer');
  return response;
}

function broker(env: Env) {
  const binding = githubBroker(env);
  if (!binding) throw new ControlError('The GitHub connector is not configured.', 503, 'not_configured');
  return binding;
}

/** The broker's refusal, said once for the admin. */
function refused(reason: string): ControlError {
  switch (reason) {
    case 'not_configured': return new ControlError('The GitHub connector is not configured.', 503, 'not_configured');
    case 'installation_taken': return new ControlError('That GitHub installation is connected to another workspace.', 409, 'invalid_request');
    case 'expired_or_used': return new ControlError('This link has expired. Press Connect GitHub again.', 400, 'invalid_request');
    default: return new ControlError('Connecting GitHub failed.', 502);
  }
}

/** GET /api/connectors/github/connect/start: an admin's click, on the workspace's own origin. */
export async function startGithubConnect(request: Request, env: Env): Promise<Response> {
  if (new URL(request.url).origin !== env.WEB_ORIGIN) throw new ControlError('Unknown workspace.', 403, 'untrusted_origin');
  const binding = broker(env);
  await assertUnderRateLimit(env.JOIN_LIMIT, request, 'github-connect-start');
  const browserSecret = randomToken();
  const answer = githubBeginResultSchema.parse(await binding.begin({ v: GITHUB_BROKER_VERSION, browserHash: await sha256(browserSecret) }));
  if (!answer.ok) throw refused(answer.reason);
  return noStore(redirectWithCookies(answer.installUrl, [cookie(bridgeCookie(answer.ticket), browserSecret, ATTEMPT_COOKIE_SECONDS)]));
}

/** GET /api/connectors/github/connect/complete: the browser is back from the auth host with the ticket and a code. */
export async function completeGithubConnect(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const query = githubCompleteQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!query.success) throw new ControlError('This link has expired. Press Connect GitHub again.', 400, 'invalid_request');
  const { ticket, code } = query.data;
  const browserSecret = readCookie(request, bridgeCookie(ticket));
  if (!browserSecret) throw new ControlError('This link has expired. Press Connect GitHub again.', 400, 'invalid_request');
  const answer = githubCompleteResultSchema.parse(await broker(env).complete({
    v: GITHUB_BROKER_VERSION,
    ticket,
    code,
    browserHash: await sha256(browserSecret),
  }));
  if (!answer.ok) throw refused(answer.reason);
  resetGithubTokenCache();
  return noStore(redirectWithCookies(new URL(PAGE_PATH, url.origin).toString(), [expiredCookie(bridgeCookie(ticket))]));
}

/** POST /api/connectors/github/disconnect: the broker forgets this workspace's installation. */
export async function disconnectGithub(env: Env): Promise<ConnectorReverseResponse> {
  const answer = githubDisconnectResultSchema.parse(await broker(env).disconnect({ v: GITHUB_BROKER_VERSION }));
  if (!answer.ok) throw refused(answer.reason);
  resetGithubTokenCache();
  return { removed: answer.removed ? 1 : 0 };
}
