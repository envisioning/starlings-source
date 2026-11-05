import { z } from 'zod';

/**
 * MCP — a Claude uses the company (docs/MCP.md).
 *
 * The wire contract for the OAuth pairing, the paired-client row a person or
 * an admin sees, and the call record. The tool surface itself is declared in
 * the Worker (`services/control-plane/src/mcp.ts`); nothing here names a
 * tool, because the list is a projection of routes that already exist.
 */

/** A token's scope. Reads only today; `write` is step 4 of the build order. */
export const MCP_SCOPES = ['read', 'write'] as const;
export const mcpScopeSchema = z.enum(MCP_SCOPES);
export type McpScope = (typeof MCP_SCOPES)[number];

export function parseMcpScope(value: string | null | undefined): McpScope[] | null {
  const words = (value ?? 'read').split(/\s+/u).filter((word) => word.length > 0);
  if (words.length === 0) return ['read'];
  const scopes: McpScope[] = [];
  for (const word of words) {
    if (!(MCP_SCOPES as readonly string[]).includes(word)) return null;
    if (!scopes.includes(word as McpScope)) scopes.push(word as McpScope);
  }
  return scopes;
}

/** The MCP endpoint and the OAuth endpoints, relative to the API origin. */
export const MCP_PATH = '/mcp';
export const MCP_OAUTH_PATHS = {
  protectedResource: '/.well-known/oauth-protected-resource',
  authorizationServer: '/.well-known/oauth-authorization-server',
  register: '/oauth/register',
  authorize: '/oauth/authorize',
  token: '/oauth/token',
  revoke: '/oauth/revoke',
} as const;

/** The consent page in `web/`, where `/oauth/authorize` sends a browser. */
export const MCP_CONNECT_PATH = '/connect';

/**
 * The name a workspace's MCP server gives a client, and the name a member
 * gives its connector: "Starlings · HQ". Each workspace serves its own
 * `/mcp`, and a person with two connected must be able to tell them apart.
 */
export const MCP_SERVER_NAME_PREFIX = 'Starlings · ';
export const mcpServerName = (workspace: string) => `${MCP_SERVER_NAME_PREFIX}${workspace}`;

/** The help page that says where each Claude adds the connector. Settings links it on every client. */
export const MCP_CONNECT_HELP_PATH = '/help/howto/connect-claude';

/** The address a member adds to an MCP client: the workspace's web origin and `/mcp`. */
export function mcpAddress(webOrigin: string): string {
  return `${webOrigin.replace(/\/+$/u, '')}${MCP_PATH}`;
}

/** Maximum rows returned from one source by the cross-thread change feed. */
export const MCP_CHANGES_PAGE_SIZE = 200;

export type McpChangeCursor = { changed_at: number; id: string | null };

/** Encode a stable `(changed_at, id)` cursor for `starlings://changes/{cursor}`. */
export function encodeMcpChangeCursor(changedAt: number, id: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ changed_at: changedAt, id }));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

/** A first read uses an ISO timestamp; later reads use the opaque cursor above. */
export function parseMcpChangeCursor(value: string): McpChangeCursor | null {
  if (value.length > 512 || value.length === 0) return null;
  try {
    const base64 = value.replace(/-/gu, '+').replace(/_/gu, '/');
    const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed === 'object' && parsed !== null
      && Number.isSafeInteger((parsed as { changed_at?: unknown }).changed_at)
      && typeof (parsed as { id?: unknown }).id === 'string') {
      return { changed_at: (parsed as { changed_at: number }).changed_at, id: (parsed as { id: string }).id };
    }
  } catch {
    // An ISO timestamp is the initial cursor, not a malformed encoded cursor.
  }
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(value)) return null;
  const changedAt = Date.parse(value);
  return Number.isFinite(changedAt) ? { changed_at: changedAt, id: null } : null;
}

export const mcpChangeKindSchema = z.enum(['message', 'meeting']);
export type McpChangeKind = z.infer<typeof mcpChangeKindSchema>;
export const mcpChangeRowSchema = z.object({
  kind: mcpChangeKindSchema,
  door: z.string(),
  changed_at: z.string().datetime({ offset: true }),
  change: z.enum(['created', 'updated', 'deleted', 'finalized']),
  summary: z.string(),
  actor: z.object({ name: z.string().nullable(), email: z.string() }).optional(),
}).strict();
export type McpChangeRow = z.infer<typeof mcpChangeRowSchema>;

export const mcpChangesResponseSchema = z.object({
  changes: z.array(mcpChangeRowSchema),
  next_cursor: z.string(),
  truncated: z.boolean(),
}).strict();
export type McpChangesResponse = z.infer<typeof mcpChangesResponseSchema>;

/**
 * The web hosts a paired client's code may go to: Claude's own (claude.ai,
 * Claude Desktop). Registration is unauthenticated and a client names
 * itself, so "any HTTPS host" let a stranger register as "Claude" with a
 * redirect to their own server; one Allow then handed them the member's
 * grant. A new client host is added here, by a person, in review.
 */
export const MCP_REDIRECT_HOSTS = ['claude.ai', 'claude.com'] as const;

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/**
 * Where a redirect sends the code: a listed web host, or loopback (a
 * desktop client such as Claude Code, listening on this computer). `null`
 * for anything else, which Meet refuses.
 */
export function mcpRedirectDestination(value: string): { kind: 'web' | 'loopback'; host: string } | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.hash || url.username || url.password) return null;
  if (url.protocol === 'https:' && (MCP_REDIRECT_HOSTS as readonly string[]).includes(url.hostname)) {
    return { kind: 'web', host: url.hostname };
  }
  if ((url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK_HOSTS.includes(url.hostname)) {
    return { kind: 'loopback', host: url.hostname };
  }
  return null;
}

/** A redirect a registered client may name: a listed host, or loopback. */
export function isAllowedMcpRedirectURI(value: string): boolean {
  return mcpRedirectDestination(value) !== null;
}

/** RFC 7591 dynamic client registration — the fields Meet reads. */
export const mcpClientRegistrationSchema = z.object({
  client_name: z.string().trim().min(1).max(120).optional(),
  redirect_uris: z.array(z.string().max(2048).refine(isAllowedMcpRedirectURI, 'redirect_uri is not allowed')).min(1).max(10),
  token_endpoint_auth_method: z.enum(['none', 'client_secret_post', 'client_secret_basic']).optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  scope: z.string().max(64).optional(),
  client_uri: z.string().url().max(2048).optional(),
  logo_uri: z.string().url().max(2048).optional(),
}).passthrough();

/** The query `/oauth/authorize` receives and the body `/connect` posts back. */
export const mcpAuthorizeRequestSchema = z.object({
  client_id: z.string().min(1).max(128),
  redirect_uri: z.string().max(2048).refine(isAllowedMcpRedirectURI, 'redirect_uri is not allowed'),
  response_type: z.literal('code'),
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.literal('S256'),
  state: z.string().max(1024).optional(),
  scope: z.string().max(64).optional(),
  resource: z.string().max(2048).optional(),
}).strict();
export type McpAuthorizeRequest = z.infer<typeof mcpAuthorizeRequestSchema>;

/** `/oauth/token`, both grants. Form-encoded on the wire; parsed into this. */
export const mcpTokenRequestSchema = z.discriminatedUnion('grant_type', [
  z.object({
    grant_type: z.literal('authorization_code'),
    code: z.string().min(1).max(256),
    redirect_uri: z.string().max(2048),
    client_id: z.string().min(1).max(128),
    code_verifier: z.string().min(43).max(128),
    resource: z.string().max(2048).optional(),
  }).passthrough(),
  z.object({
    grant_type: z.literal('refresh_token'),
    refresh_token: z.string().min(1).max(4096),
    client_id: z.string().min(1).max(128).optional(),
    scope: z.string().max(64).optional(),
    resource: z.string().max(2048).optional(),
  }).passthrough(),
]);
export type McpTokenRequest = z.infer<typeof mcpTokenRequestSchema>;

/** What `/connect` shows before the person allows: the client, as it registered. */
export const mcpClientPreviewSchema = z.object({
  client_id: z.string(),
  client_name: z.string(),
  client_uri: z.string().nullable(),
  scopes: z.array(mcpScopeSchema),
});
export type McpClientPreview = z.infer<typeof mcpClientPreviewSchema>;

/** `POST /oauth/authorize` answer: where the browser goes next. */
export const mcpAuthorizeResponseSchema = z.object({
  redirect: z.string(),
});
export type McpAuthorizeResponse = z.infer<typeof mcpAuthorizeResponseSchema>;

/** One tool-call refusal returned in MCP `structuredContent`. */
export const mcpToolFailureSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    hint: z.string(),
    retryable: z.boolean(),
    door: z.string().optional(),
  }).strict(),
}).strict();
export type McpToolFailure = z.infer<typeof mcpToolFailureSchema>;

/**
 * A pairing between a person and a registered client. One row per
 * (client, person); revoked in place, never deleted, so the call record
 * keeps its key.
 */
export const mcpGrantSchema = z.object({
  id: z.string(),
  client_id: z.string(),
  client_name: z.string(),
  scopes: z.array(mcpScopeSchema),
  created_at: z.number().int(),
  last_call_at: z.number().int().nullable(),
  revoked_at: z.number().int().nullable(),
  /**
   * The member paused it in Settings: `/mcp` refuses its calls
   * until they resume it. Unlike a revoke, the pairing and its refresh token
   * stay, so resuming needs no new pairing. Optional on the wire, which the
   * compatibility check asks of a new field; the Worker always sends it.
   */
  paused_at: z.number().int().nullable().optional(),
});
export type McpGrant = z.infer<typeof mcpGrantSchema>;

/** `GET /api/mcp/grants`, and the answer to a revoke, a pause and a resume. */
export const mcpGrantsResponseSchema = z.object({
  grants: z.array(mcpGrantSchema),
});
export type McpGrantsResponse = z.infer<typeof mcpGrantsResponseSchema>;

/** `peer`: an organization outside the workspace, through its peer token (docs/ACCESS.md slice 5). */
export const mcpCallPrincipalSchema = z.enum(['session', 'agent', 'peer']);
export const mcpCallMethodSchema = z.enum(['tools/call', 'resources/read', 'prompts/get']);
export const mcpCallOutcomeSchema = z.enum(['ok', 'replayed', 'refused', 'failed']);

/** One row of the record. Rendered on Admin and in the person's own Settings. */
export const mcpCallEntrySchema = z.object({
  id: z.string(),
  ts: z.number().int(),
  principal: mcpCallPrincipalSchema,
  actor_email: z.string(),
  client_name: z.string().nullable(),
  method: mcpCallMethodSchema,
  name: z.string(),
  args: z.string().nullable(),
  outcome: mcpCallOutcomeSchema,
  detail: z.string().nullable(),
  duration_ms: z.number().int().nonnegative(),
  // Older Workers do not return this audit detail; absence means false.
  replayed: z.boolean().optional(),
});
export type McpCallEntry = z.infer<typeof mcpCallEntrySchema>;

/** `GET /api/mcp/grants/<id>/calls` — newest first. */
export const mcpGrantCallsResponseSchema = z.object({
  calls: z.array(mcpCallEntrySchema),
});
export type McpGrantCallsResponse = z.infer<typeof mcpGrantCallsResponseSchema>;
