import type { McpAuthorizeResponse, McpClientPreview, McpGrantCallsResponse, McpGrantsResponse } from '@starlings/contracts/mcp';
import { json } from '../http';
import { handleMcp } from '../mcp';
import {
  beginMcpAuthorize,
  completeMcpAuthorize,
  mcpAuthorizationServerMetadata,
  mcpProtectedResourceMetadata,
  mcpRevoke,
  mcpToken,
  ownMcpGrantCalls,
  ownMcpGrants,
  previewMcpClient,
  registerMcpClient,
  revokeOwnMcpGrant,
  setOwnMcpGrantPaused,
} from '../mcp-auth';
import { defineRoute, type Param, type Route } from '../route-types';

const GRANT: Param = { re: '[A-Za-z0-9_-]{8,64}', sample: 'grant_sample' };

/**
 * The MCP door and its OAuth pairing (docs/MCP.md). Off `/api/` because the
 * RFCs fix two of the paths under `/.well-known/` and a connector is
 * configured with one URL, `<origin>/mcp`. The paths are literals so the route
 * inventory can read them; `test/route-gates.test.ts` holds them to
 * `MCP_PATH` and `MCP_OAUTH_PATHS`.
 */
/** The door, the pairing's discovery and token endpoints, then what `/connect` draws and the person's own pairings. */
export const mcpRoutes: readonly Route[] = [
  // Every tool call is dispatched back through the router as an ordinary
  // `/api/*` read, so each one passes that route's own gate.
  defineRoute({
    method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    path: '/mcp',
    gate: { kind: 'public', reason: 'handleMcp verifies the paired connector\'s token or the agent\'s signature before it runs any tool' },
    handler: ({ request, env, ctx, dispatch }) => handleMcp(request, env, ctx, dispatch),
  }),

  defineRoute({
    method: 'GET',
    path: '/.well-known/oauth-protected-resource',
    gate: { kind: 'public', reason: 'OAuth discovery metadata (RFC 9728), public by design' },
    handler: ({ request, env }) => mcpProtectedResourceMetadata(request, env),
  }),

  defineRoute({
    method: 'GET',
    path: '/.well-known/oauth-protected-resource/mcp',
    gate: { kind: 'public', reason: 'OAuth discovery metadata (RFC 9728), public by design' },
    handler: ({ request, env }) => mcpProtectedResourceMetadata(request, env),
  }),

  defineRoute({
    method: 'GET',
    path: '/.well-known/oauth-authorization-server',
    gate: { kind: 'public', reason: 'OAuth discovery metadata (RFC 8414), public by design' },
    handler: ({ request, env }) => mcpAuthorizationServerMetadata(request, env),
  }),

  defineRoute({
    method: 'POST',
    path: '/oauth/register',
    gate: { kind: 'public', reason: 'dynamic client registration (RFC 7591): a client with no account says who it is; nothing is granted until a member allows it on /connect' },
    handler: ({ request, env }) => registerMcpClient(request, env),
  }),

  defineRoute({
    method: 'GET',
    path: '/oauth/authorize',
    gate: { kind: 'public', reason: 'only checks the request and sends the browser to /connect, where a member signs in and allows it' },
    handler: ({ request, env }) => beginMcpAuthorize(request, env),
  }),

  defineRoute({
    method: 'POST',
    path: '/oauth/token',
    gate: { kind: 'public', reason: 'the proof is the one-time code and PKCE verifier, or the refresh token, checked in mcpToken' },
    handler: ({ request, env }) => mcpToken(request, env),
  }),

  defineRoute({
    method: 'POST',
    path: '/oauth/revoke',
    gate: { kind: 'public', reason: 'the proof is the token being revoked (RFC 7009), checked in mcpRevoke' },
    handler: ({ request, env }) => mcpRevoke(request, env),
  }),

  // What `/connect` draws before the person allows, and the person's own pairings.
  defineRoute({
    method: 'GET',
    path: '/api/mcp/client',
    gate: { kind: 'capability', capability: 'agents' },
    handler: async ({ request, env }) => json(await previewMcpClient(request, env) satisfies McpClientPreview),
  }),

  defineRoute({
    method: 'GET',
    path: '/api/mcp/grants',
    gate: { kind: 'capability', capability: 'agents' },
    handler: async ({ request, env }) => json(await ownMcpGrants(request, env) satisfies McpGrantsResponse),
  }),

  defineRoute({
    method: 'POST',
    path: '/api/mcp/grants/:grantId/revoke',
    params: { grantId: GRANT },
    gate: { kind: 'capability', capability: 'agents', origin: 'trusted' },
    handler: async ({ request, env, params }) => json(await revokeOwnMcpGrant(request, env, params.grantId!) satisfies McpGrantsResponse),
  }),

  // Pause and Resume: the same owner scope and origin as Revoke.
  defineRoute({
    method: 'POST',
    path: '/api/mcp/grants/:grantId/pause',
    params: { grantId: GRANT },
    gate: { kind: 'capability', capability: 'agents', origin: 'trusted' },
    handler: async ({ request, env, params }) => json(await setOwnMcpGrantPaused(request, env, params.grantId!, true) satisfies McpGrantsResponse),
  }),

  defineRoute({
    method: 'POST',
    path: '/api/mcp/grants/:grantId/resume',
    params: { grantId: GRANT },
    gate: { kind: 'capability', capability: 'agents', origin: 'trusted' },
    handler: async ({ request, env, params }) => json(await setOwnMcpGrantPaused(request, env, params.grantId!, false) satisfies McpGrantsResponse),
  }),

  defineRoute({
    method: 'GET',
    path: '/api/mcp/grants/:grantId/calls',
    params: { grantId: GRANT },
    gate: { kind: 'capability', capability: 'agents' },
    handler: async ({ request, env, params }) => json(await ownMcpGrantCalls(request, env, params.grantId!) satisfies McpGrantCallsResponse),
  }),

  // The person allowed on `/connect`. Session cookie + web origin, like every browser write.
  defineRoute({
    method: 'POST',
    path: '/api/mcp/authorize',
    gate: { kind: 'capability', capability: 'agents', origin: 'web' },
    handler: async ({ request, env }) => json(await completeMcpAuthorize(request, env) satisfies McpAuthorizeResponse),
  }),
];
