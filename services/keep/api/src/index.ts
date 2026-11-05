// Keep — control plane.
//
// Same shape as Docs and Meet: one `route()` function, explicit path
// matching, errors normalized into `{error, code}` at the boundary, static
// assets served by the ASSETS binding for anything that is not `/api/*`.
//
// What this Worker is for: proving who is asking, storing what it is
// handed, and writing down every reveal. What it is not for: opening
// anything. There is no key here.

import { SIGN_IN_DOMAIN } from '../../../../packages/contracts/src/deployment-values';
import { ZodError } from 'zod';
import { CENTRAL_AUTH_COMPLETE_PATH, ROTATE_BODY_MAX_BYTES, type DeploymentInfo, type KeepErrorBody, type KeepErrorCode } from '@keep/contracts';
import { completeGoogleWebAuth, getPrincipal, logoutResponse, requireStaff, SESSION_COOKIE, signStaffSession, startGoogleWebAuth } from './auth';
import { listAuditEvents, listRecentAuditEvents } from './audit';
import { AuthError, KeepError, NotFoundError } from './errors';
import { identityDomains, isAdmittedEmail, webSignIn } from './identity';
import { centralSignOutResponse, completeCentralWebAuth, startCentralWebAuth } from './central-auth';
import { devCookie, redirectWithCookies, safeReturnPath } from './http-cookies';
import { assertTrustedMutation, assertUnderRateLimit, assertWebOrigin, json, noContent, readBoundedJSON, readBoundedText } from './http';
import { assertInternalSignature, exchangeMeetToken, listDeviceTokens, revokeDeviceToken } from './tokens';
import { createItem, deleteItem, revealItem, updateItem } from './items';
import { addWrap, enrol, getRecoveryKey, getStaffKey, listDirectory, setRecoveryKey } from './keys';
import { coverVault, createVault, deleteVault, getVault, grantMember, listVaults, requireMembership, rotateVault, updateVault } from './vaults';
import { listRecoveryVaults, recoveryJoin } from './recovery';
import {
  agentSelf,
  createMachineItem,
  createMachineVault,
  deleteMachineItem,
  getMachineVault,
  grantAgent,
  listAgents,
  listMachineVaults,
  registerAgentKey,
  requireMachineVault,
  revokeAgent,
  updateMachineItem,
} from './machine';
import type { AgentPrincipal } from './tokens';
import { vaultAccess } from './access';
import { agentRelease, createRelease, endRelease, fetchRelease, getRelease } from './releases';

const worker = {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    try {
      const response = await route(request, env);
      log('info', 'request.completed', {
        requestId,
        method: request.method,
        path: new URL(request.url).pathname,
        status: response.status,
        durationMs: Date.now() - startedAt,
      });
      return withSecurityHeaders(response, env);
    } catch (error) {
      const status = errorStatus(error);
      const code = errorCode(error, status);
      log(status >= 500 ? 'error' : 'warn', 'request.failed', {
        requestId,
        method: request.method,
        path: new URL(request.url).pathname,
        status,
        code,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      const body: KeepErrorBody = { error: publicError(error, status), code };
      if (status >= 500) body.request_id = requestId;
      return withSecurityHeaders(json(body, status), env);
    }
  },
} satisfies ExportedHandler<Env>;

export default worker;

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // Apple reads this to let the Meet app use passkeys for this origin
  // (associated domains, `webcredentials`). Served by the Worker, not the
  // SPA, so it never falls through to index.html.
  if (method === 'GET' && path === '/.well-known/apple-app-site-association') {
    return Response.json(
      { webcredentials: { apps: env.APPLE_APP_IDS.split(',').map((id) => id.trim()).filter(Boolean) } },
      { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' } },
    );
  }

  // Anything that is not the API is the SPA.
  if (!path.startsWith('/api/') && path !== '/api') {
    return env.ASSETS.fetch(request);
  }

  if (method === 'GET' && path === '/api/health') {
    return json({ ok: true, service: 'keep', environment: env.ENVIRONMENT });
  }

  // The deployment's name and admitted domains, for the SPA's sign-in screen,
  // chrome and passkey prompt (: a workspace deployment
  // is not Envisioning's). Public, before sign-in.
  if (method === 'GET' && path === '/api/deployment') {
    const name = env.WORKSPACE_NAME?.trim().slice(0, 60);
    return json({
      name: name || 'Envisioning',
      envisioning: !name,
      identity_domains: [...identityDomains(env)],
    } satisfies DeploymentInfo);
  }

  // ---- auth ---------------------------------------------------------------

  // A `central` deployment keeps the start path the SPA links to, and signs in
  // through the auth host (central-auth.ts). The Google callback refuses it.
  if (method === 'GET' && path === '/api/auth/google/start') {
    return webSignIn(env) === 'central' ? startCentralWebAuth(request, env) : startGoogleWebAuth(request, env);
  }
  if (method === 'GET' && path === '/api/auth/google/callback') return completeGoogleWebAuth(request, env);
  if (method === 'GET' && path === CENTRAL_AUTH_COMPLETE_PATH) {
    if (webSignIn(env) !== 'central') throw new NotFoundError('No such route.');
    return completeCentralWebAuth(request, env);
  }
  if (method === 'GET' && path === '/api/auth/central/sign-out') return centralSignOutResponse(env, webSignIn(env) === 'central');
  if (method === 'POST' && path === '/api/auth/logout') {
    assertWebOrigin(request, env);
    return logoutResponse(env);
  }

  // Local development only. Google OAuth needs a registered redirect URI,
  // which 127.0.0.1 does not have, so dev mints a session directly. The
  // environment check is the entire safeguard.
  if (method === 'GET' && path === '/api/dev/session') {
    if (env.ENVIRONMENT === 'production') throw new NotFoundError('No such route.');
    const email = (url.searchParams.get('email') ?? `rosa@${SIGN_IN_DOMAIN}`).toLowerCase();
    if (!isAdmittedEmail(env, email)) {
      throw new AuthError('Dev sessions admit the same domains as sign-in.', 403, 'forbidden');
    }
    const session = await signStaffSession({ sub: `dev-${email}`, email, name: email.split('@')[0] ?? 'Dev' }, env);
    return redirectWithCookies(`${env.WEB_ORIGIN}${safeReturnPath(url.searchParams.get('return_to'))}`, [
      devCookie(SESSION_COOKIE, session),
    ]);
  }

  // Service-to-service: the Meet Worker mints a device token for an owner
  // it has already verified. Before principal resolution — the caller has
  // no session, only the shared secret.
  if (method === 'POST' && path === '/api/tokens/meet-exchange') {
    const body = await readBoundedText(request);
    await assertInternalSignature(request, env, body);
    return json(await exchangeMeetToken(env, JSON.parse(body)), 201);
  }

  // Everything below needs a principal, and every mutation is either a
  // device or a request from the web origin. An agent token reaches its own
  // routes and nothing else (ADR 0007).
  const principal = await getPrincipal(request, env);
  if (method !== 'GET' && principal) assertTrustedMutation(request, env);
  if (principal?.kind === 'agent') return routeAgent(request, env, principal.agent, path, method);
  const session = requireStaff(principal);

  if (method === 'GET' && path === '/api/me') {
    const key = await getStaffKey(env, session.email);
    return json({
      email: session.email,
      name: session.name,
      picture: session.picture ?? null,
      enrolled: key !== null,
      key,
      core_web_origin: env.CORE_WEB_ORIGIN,
    });
  }

  // ---- keys ---------------------------------------------------------------

  if (method === 'PUT' && path === '/api/keys/me') {
    const replace = url.searchParams.get('replace') === '1';
    return json(await enrol(env, session, await readBoundedJSON(request), request, { replace }), 201);
  }
  if (method === 'POST' && path === '/api/keys/me/wraps') {
    return json(await addWrap(env, session, await readBoundedJSON(request), request), 201);
  }
  if (method === 'GET' && path === '/api/keys/directory') {
    return json({ entries: await listDirectory(env) });
  }
  if (method === 'GET' && path === '/api/recovery') {
    return json({ recovery: await getRecoveryKey(env) });
  }
  if (method === 'PUT' && path === '/api/recovery') {
    return json(await setRecoveryKey(env, session, await readBoundedJSON(request), request), 201);
  }
  if (method === 'GET' && path === '/api/recovery/vaults') {
    return json({ vaults: await listRecoveryVaults(env, session, request) });
  }
  const recoveryJoinMatch = /^\/api\/recovery\/vaults\/([0-9a-f-]{36})\/join$/u.exec(path);
  if (recoveryJoinMatch && method === 'POST') {
    await recoveryJoin(env, session, recoveryJoinMatch[1]!, await readBoundedJSON(request), request);
    return noContent();
  }

  // ---- devices ------------------------------------------------------------

  if (method === 'GET' && path === '/api/tokens') {
    return json({ tokens: await listDeviceTokens(env, session.email) });
  }
  const tokenMatch = /^\/api\/tokens\/([0-9a-f-]{36})$/u.exec(path);
  if (tokenMatch && method === 'DELETE') {
    await revokeDeviceToken(env, tokenMatch[1]!, session.email);
    return noContent();
  }

  // ---- audit --------------------------------------------------------------

  if (method === 'GET' && path === '/api/audit') {
    return json({ events: await listRecentAuditEvents(env) });
  }

  // ---- agents and machine vaults (machine.ts) -----------------------------

  if (method === 'GET' && path === '/api/agents') {
    return json({ agents: await listAgents(env) });
  }
  if (method === 'GET' && path === '/api/machine-vaults') {
    return json({ vaults: await listMachineVaults(env) });
  }
  if (method === 'POST' && path === '/api/machine-vaults') {
    return json(await createMachineVault(env, session, await readBoundedJSON(request), request), 201);
  }
  const machineMatch = /^\/api\/machine-vaults\/([0-9a-f-]{36})(?:\/(.*))?$/u.exec(path);
  if (machineMatch) {
    const vaultId = machineMatch[1]!;
    const rest = machineMatch[2] ?? '';
    if (rest === '' && method === 'GET') return json(await getMachineVault(env, vaultId));
    if (rest === 'agent' && method === 'POST') {
      return json(await grantAgent(env, session, vaultId, await readBoundedJSON(request), request), 201);
    }
    if (rest === 'revoke' && method === 'POST') return json(await revokeAgent(env, session, vaultId, request));
    if (rest === 'access' && method === 'GET') {
      await requireMachineVault(env, vaultId);
      return json(await vaultAccess(env, { id: vaultId, machine: true }, accessItem(url)));
    }
    if (rest === 'audit' && method === 'GET') {
      await getMachineVault(env, vaultId);
      return json({ events: await listAuditEvents(env, vaultId) });
    }
    if (rest === 'items' && method === 'POST') {
      return json(await createMachineItem(env, session, vaultId, await readBoundedJSON(request), request), 201);
    }
    // No GET: nobody reveals a machine vault item through keep-api.
    const itemMatch = /^items\/([0-9a-f-]{36})$/u.exec(rest);
    if (itemMatch) {
      const itemId = itemMatch[1]!;
      if (method === 'PATCH') return json(await updateMachineItem(env, session, vaultId, itemId, await readBoundedJSON(request), request));
      if (method === 'DELETE') {
        await deleteMachineItem(env, session, vaultId, itemId, request);
        return noContent();
      }
    }
  }

  // ---- vaults -------------------------------------------------------------

  if (method === 'GET' && path === '/api/vaults') {
    return json({ vaults: await listVaults(env, session) });
  }
  if (method === 'POST' && path === '/api/vaults') {
    return json(await createVault(env, session, await readBoundedJSON(request), request), 201);
  }

  const vaultMatch = /^\/api\/vaults\/([0-9a-f-]{36})(?:\/(.*))?$/u.exec(path);
  if (vaultMatch) {
    const vaultId = vaultMatch[1]!;
    const rest = vaultMatch[2] ?? '';

    if (rest === '') {
      if (method === 'GET') return json(await getVault(env, session, vaultId));
      if (method === 'PATCH') return json(await updateVault(env, session, vaultId, await readBoundedJSON(request), request));
      if (method === 'DELETE') {
        await deleteVault(env, session, vaultId, request);
        return noContent();
      }
    }
    if (rest === 'members' && method === 'POST') {
      return json(await grantMember(env, session, vaultId, await readBoundedJSON(request), request), 201);
    }
    if (rest === 'recovery' && method === 'POST') {
      return json(await coverVault(env, session, vaultId, await readBoundedJSON(request), request), 201);
    }
    if (rest === 'rotate' && method === 'POST') {
      return json(await rotateVault(env, session, vaultId, await readBoundedJSON(request, ROTATE_BODY_MAX_BYTES), request));
    }
    if (rest === 'access' && method === 'GET') {
      await requireMembership(env, session, vaultId);
      return json(await vaultAccess(env, { id: vaultId, machine: false }, accessItem(url)));
    }
    if (rest === 'audit' && method === 'GET') {
      await getVault(env, session, vaultId);
      return json({ events: await listAuditEvents(env, vaultId) });
    }
    if (rest === 'items' && method === 'POST') {
      return json(await createItem(env, session, vaultId, await readBoundedJSON(request), request), 201);
    }
    // Attended releases (releases.ts). A machine vault answers 404.
    if (rest === 'releases' && method === 'POST') {
      return json(await createRelease(env, session, vaultId, await readBoundedJSON(request), request), 201);
    }
    const releaseMatch = /^releases\/([0-9a-f-]{36})(\/end)?$/u.exec(rest);
    if (releaseMatch) {
      const releaseId = releaseMatch[1]!;
      if (!releaseMatch[2] && method === 'GET') return json(await getRelease(env, session, vaultId, releaseId));
      if (releaseMatch[2] && method === 'POST') return json(await endRelease(env, session, vaultId, releaseId, request));
    }
    const itemMatch = /^items\/([0-9a-f-]{36})$/u.exec(rest);
    if (itemMatch) {
      const itemId = itemMatch[1]!;
      if (method === 'GET') {
        await assertUnderRateLimit(env.REVEAL_LIMIT, `reveal:${session.email}`);
        return json(await revealItem(env, session, vaultId, itemId, request));
      }
      if (method === 'PATCH') return json(await updateItem(env, session, vaultId, itemId, await readBoundedJSON(request), request));
      if (method === 'DELETE') {
        await deleteItem(env, session, vaultId, itemId, request);
        return noContent();
      }
    }
  }

  throw new NotFoundError('No such route.');
}

/** `?item=<uuid>` narrows a "can use" list to one item. Anything else is a 400. */
function accessItem(url: URL): string | null {
  const item = url.searchParams.get('item');
  if (item === null) return null;
  if (!/^[0-9a-f-]{36}$/u.test(item)) throw new KeepError('item: a uuid expected.', 400, 'invalid_request');
  return item;
}

/**
 * An agent token's whole reach: who it is, the broker's seam to register its
 * public key, and its own releases: the state of one, and
 * the one fetch. The broker's one-item read joins here in. Anything
 * else is 404: the rest of Keep does not exist for an agent.
 */
async function routeAgent(request: Request, env: Env, agent: AgentPrincipal, path: string, method: string): Promise<Response> {
  if (method === 'GET' && path === '/api/agent/me') return json(await agentSelf(env, agent));
  if (method === 'PUT' && path === '/api/agent/key') {
    return json(await registerAgentKey(env, agent, await readBoundedJSON(request), request));
  }
  const releaseMatch = /^\/api\/agent\/releases\/([0-9a-f-]{36})(\/fetch)?$/u.exec(path);
  if (releaseMatch) {
    const releaseId = releaseMatch[1]!;
    if (!releaseMatch[2] && method === 'GET') return json(await agentRelease(env, agent, releaseId));
    if (releaseMatch[2] && method === 'POST') return json(await fetchRelease(env, agent, releaseId, request));
  }
  throw new NotFoundError('No such route.');
}

/**
 * The SPA is the trusted computing base: whoever can change the JavaScript
 * it runs can read every vault the next person unlocks. A strict CSP is the
 * one header that narrows that. No inline script, no remote script, no
 * connections anywhere but here.
 */
function withSecurityHeaders(response: Response, env: Env): Response {
  const headers = new Headers(response.headers);
  headers.set(
    'content-security-policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https://lh3.googleusercontent.com",
      "font-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self' https://accounts.google.com",
      'upgrade-insecure-requests',
    ].join('; '),
  );
  headers.set('referrer-policy', 'no-referrer');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('x-frame-options', 'DENY');
  headers.set('permissions-policy', 'publickey-credentials-get=(self), publickey-credentials-create=(self)');
  if (env.ENVIRONMENT === 'production') {
    headers.set('strict-transport-security', 'max-age=63072000; includeSubDomains');
  }
  return new Response(response.body, { status: response.status, headers });
}

function errorStatus(error: unknown): number {
  if (error instanceof KeepError) return error.status;
  if (error instanceof ZodError) return 400;
  return 500;
}

function errorCode(error: unknown, status: number): KeepErrorCode {
  if (error instanceof KeepError) return error.code;
  if (error instanceof ZodError) return 'invalid_request';
  return status >= 500 ? 'internal' : 'invalid_request';
}

function publicError(error: unknown, status: number): string {
  if (error instanceof ZodError) {
    const first = error.issues[0];
    return first ? `${first.path.join('.') || 'body'}: ${first.message}` : 'Invalid request.';
  }
  // 5xx prose is deliberately opaque; the request id is what to quote.
  if (status >= 500) return 'Something went wrong on our side.';
  return error instanceof Error ? error.message : 'Request failed.';
}

function log(level: 'info' | 'warn' | 'error', message: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, message, ...fields }));
}

export { OpsService } from './ops';
