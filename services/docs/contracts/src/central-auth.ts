// Central sign-in, the service side: Docs signing in through the auth host
// (the auth host) as its workspace. See envisioning/meet
// docs/CENTRAL_AUTH.md "Services".
//
// A copy, not a dependency. The originals are in envisioning/meet,
// packages/contracts/src/browser-auth.ts. This copy is narrowed to what Docs
// sends and reads (a login, never consent), in zod 3. The guard is the
// fixture: fixtures/meet/service-sign-in.json is Meet's
// fixtures/central-auth/service-sign-in.json, byte for byte
// (scripts/sync-meet-fixtures.mjs), and these schemas must parse it
// (scripts/check-central-auth-fixture.mjs). Meet parses the same file with
// the originals. A change to the handoff starts in Meet.
import { z } from 'zod';

/** The handoff version every call carries. Meet's AUTH_HANDOFF_VERSION. */
export const AUTH_HANDOFF_VERSION = 1;
const handoffVersion = z.literal(AUTH_HANDOFF_VERSION);

/** Paths on the auth host and on this host. Meet's CENTRAL_AUTH_* constants for `login`. */
export const CENTRAL_AUTH_START_PATH = '/api/auth/central/start';
export const CENTRAL_AUTH_SIGN_OUT_PATH = '/api/auth/central/sign-out';
export const CENTRAL_AUTH_COMPLETE_PATH = '/api/auth/central/complete';

/** A random token or a SHA-256, base64url or hex. */
const opaque = z.string().regex(/^[A-Za-z0-9_-]{20,128}$/u);
const returnPath = z.string().startsWith('/').max(2048);
const sub = z.string().min(1).max(255);

/** What this Worker's `AUTH` binding carries as props (wrangler.jsonc). Set by the account owner, never by code. */
export const authBindingPropsSchema = z.object({
  origin: z.string().min(8).max(300),
  workspace: z.string().min(2).max(63),
  service: z.enum(['docs', 'keep']),
}).strict();

export const authBeginInputSchema = z.object({
  v: handoffVersion,
  kind: z.literal('login'),
  returnPath,
  browserHash: opaque,
  ownerSub: z.null(),
  product: z.null(),
  loginHint: z.null(),
  workspaceName: z.string().min(1).max(60).nullable(),
  markPath: z.null(),
  hostedDomain: z.string().max(253).regex(/^[a-z0-9.-]+$/u).nullable(),
}).strict();
export type AuthBeginInput = z.infer<typeof authBeginInputSchema>;

export const authBeginResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), ticket: opaque }),
  z.object({ ok: z.literal(false), reason: z.enum(['origin_refused', 'invalid_request']) }),
]);

export const authRedeemInputSchema = z.object({
  v: handoffVersion,
  kind: z.literal('login'),
  ticket: opaque,
  code: opaque,
  browserHash: opaque,
  ownerSub: z.null(),
}).strict();
export type AuthRedeemInput = z.infer<typeof authRedeemInputSchema>;

const centralAuthResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('login'),
    sub,
    email: z.string().email(),
    name: z.string().min(1),
    hd: z.string().optional(),
    picture: z.string().optional(),
  }),
  z.object({ kind: z.literal('cancelled') }),
]);

export const authRedeemResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), returnPath, result: centralAuthResultSchema }),
  z.object({ ok: z.literal(false), reason: z.enum(['expired_or_used', 'invalid_request']) }),
]);

/** Asked of the workspace on every redeem: may this proven identity sign in? RPC `MemberService.check` over `MEET`. */
export const memberCheckInputSchema = z.object({
  v: handoffVersion,
  sub,
  email: z.string().email(),
  hd: z.string().max(255).optional(),
}).strict();
export type MemberCheckInput = z.infer<typeof memberCheckInputSchema>;

export const memberCheckResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), reason: z.enum(['invalid_request', 'not_member', 'blocked']) }),
]);
