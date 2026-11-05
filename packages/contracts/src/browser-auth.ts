/**
 * Central sign-in (docs/CENTRAL_AUTH.md). The
 * shapes that cross between a workspace Worker, the `starlings-auth` Worker
 * and the browser. A browser URL carries only an opaque ticket, an OAuth
 * state or a single-use code. Identity and Google codes travel only Worker to
 * Worker.
 *
 * `zod/mini` and no import from the contracts index: the auth Worker bundles
 * this file, and the full index and classic Zod are most of a megabyte
 *. `import * as z`, not `import { z }`: the exported `z` object
 * holds every locale and esbuild cannot drop them; a namespace import keeps
 * only what this file uses.
 */
import * as z from 'zod/mini';
import { GOOGLE_GRANT_PRODUCTS } from './google-grant-products';
import { WORKSPACE_SERVICES } from './workspace-slug';

/**
 * The handoff version a workspace sends in `begin` and `redeem`
 * (docs/DEPLOY_STRATEGY.md rule 6). The auth Worker deploys first, so when
 * this moves to 2 it accepts 1 and 2 for one release.
 */
export const AUTH_HANDOFF_VERSION = 1;
const handoffVersion = z.literal(AUTH_HANDOFF_VERSION);

export const BROWSER_AUTH_KINDS = ['login', 'calendar', 'google-grant'] as const;
export const browserAuthKindSchema = z.enum(BROWSER_AUTH_KINDS);
export type BrowserAuthKind = z.infer<typeof browserAuthKindSchema>;

/**
 * The auth Worker's sign-in screen. A GET shows it; the button
 * POSTs the ticket back to the same path, and only that POST goes to Google.
 */
export const CENTRAL_AUTH_START_PATH = '/api/auth/central/start';

/**
 * Sign-out of the auth session (docs/CENTRAL_AUTH.md "The auth session"). The
 * same path on both hosts: a GET on the workspace sends the browser to the
 * auth host with `return_to` set to the workspace origin; the auth host ends
 * its session and sends the browser back there.
 */
export const CENTRAL_AUTH_SIGN_OUT_PATH = '/api/auth/central/sign-out';

/** Google returns to these paths on the auth host. Register each one once. */
/** Where the central sign-in screen posts an address for a mailed link, on the workspace (email-sign-in.ts). */
export const EMAIL_LINK_REQUEST_PATH = '/api/auth/email-link';

export const CENTRAL_AUTH_CALLBACK_PATHS: Readonly<Record<BrowserAuthKind, string>> = {
  login: '/api/auth/google/callback',
  calendar: '/api/auth/calendar/callback',
  'google-grant': '/api/auth/connectors/google/callback',
};

/** The workspace redeems the code on these paths, on its own host. */
export const CENTRAL_AUTH_COMPLETE_PATHS: Readonly<Record<BrowserAuthKind, string>> = {
  login: '/api/auth/central/complete',
  calendar: '/api/calendar/connect/complete',
  'google-grant': '/api/connectors/google/connect/complete',
};

/** A random token from `randomToken` or a SHA-256 from `sha256`: base64url. */
const opaque = z.string().check(z.regex(/^[A-Za-z0-9_-]{20,128}$/u));
const returnPath = z.string().check(z.startsWith('/'), z.maxLength(2048));
const sub = z.string().check(z.minLength(1), z.maxLength(255));
/** A local path on the workspace host: one leading slash, no backslash, no control character. */
const localPath = z.string().check(z.maxLength(300), z.regex(/^\/(?![/\\])[^\\\s]*$/u));

export const centralAuthStartQuerySchema = z.object({ ticket: opaque });
export const centralAuthCallbackQuerySchema = z.object({
  state: opaque,
  code: z.optional(z.string().check(z.minLength(1), z.maxLength(4096))),
  error: z.optional(z.string().check(z.maxLength(200))),
});
export const centralAuthCompleteQuerySchema = z.object({ ticket: opaque, code: opaque });

/**
 * What a workspace's `AUTH` binding carries as `props` (wrangler.jsonc,
 * docs/CENTRAL_AUTH.md "The caller's origin"). The account owner sets it in
 * the binding's config; the calling Worker's code cannot change it. The auth
 * Worker reads it as `ctx.props` and takes the workspace origin from here,
 * never from an RPC argument.
 */
const bindingOrigin = z.string().check(z.minLength(8), z.maxLength(300));
export const authBindingPropsSchema = z.union([
  /** A workspace: the origin alone. Its slug is read off a `<slug>.<suffix>` host. */
  z.strictObject({ origin: bindingOrigin }),
  /**
   * A workspace's service (docs/CENTRAL_AUTH.md "Services"): Docs or Keep,
   * signing in as part of `workspace`. Its origin must be
   * `<service>-<workspace>.<suffix>` or a listed alias.
   */
  z.strictObject({
    origin: bindingOrigin,
    workspace: z.string().check(z.minLength(2), z.maxLength(63)),
    service: z.enum(WORKSPACE_SERVICES),
  }),
]);
export type AuthBindingProps = z.infer<typeof authBindingPropsSchema>;

/**
 * A workspace asks for an attempt. It names no origin: the auth Worker takes
 * it from the binding, and a strict object refuses a stray
 * `workspaceOrigin`. `browserHash` is the SHA-256 of a secret that only the
 * workspace's host-only cookie holds. Consent binds the owner.
 * `workspaceName`, `markPath` and `accent` only draw the sign-in screen;
 * `hostedDomain` narrows Google's account chooser, as the direct flow does.
 */
export const authBeginInputSchema = z.strictObject({
  v: handoffVersion,
  kind: browserAuthKindSchema,
  returnPath,
  browserHash: opaque,
  ownerSub: z.nullable(sub),
  product: z.nullable(z.enum(GOOGLE_GRANT_PRODUCTS)),
  loginHint: z.nullable(z.string().check(z.maxLength(320))),
  workspaceName: z.nullable(z.string().check(z.minLength(1), z.maxLength(60))),
  markPath: z.nullable(localPath),
  /** The workspace's accent, `#rrggbb`. Optional: an older workspace sends none. */
  accent: z.optional(z.nullable(z.string().check(z.regex(/^#[0-9a-f]{6}$/u)))),
  hostedDomain: z.nullable(z.string().check(z.maxLength(253), z.regex(/^[a-z0-9.-]+$/u))),
}).check(z.superRefine((value, context) => {
  const consent = value.kind !== 'login';
  if (consent !== (value.ownerSub !== null)) context.addIssue({ code: 'custom', message: 'ownerSub is required for consent and refused for login', input: value });
  if ((value.kind === 'google-grant') !== (value.product !== null)) context.addIssue({ code: 'custom', message: 'product is required for google-grant only', input: value });
}));
export type AuthBeginInput = z.infer<typeof authBeginInputSchema>;

export const authBeginResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), ticket: opaque }),
  z.object({ ok: z.literal(false), reason: z.enum(['origin_refused', 'invalid_request']) }),
]);
export type AuthBeginResult = z.infer<typeof authBeginResultSchema>;

/** Sealed at rest in the auth D1; returned only over the service binding. */
export const centralAuthResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('login'),
    sub,
    email: z.email(),
    name: z.string().check(z.minLength(1)),
    hd: z.optional(z.string()),
    picture: z.optional(z.string()),
  }),
  /** The workspace exchanges the Google code itself, with this redirect URI and client. */
  z.object({
    kind: z.literal('consent'),
    code: z.string().check(z.minLength(1)),
    verifier: z.string().check(z.minLength(1)),
    nonce: z.string().check(z.minLength(1)),
    redirectUri: z.url(),
    clientId: z.string().check(z.minLength(1)),
  }),
  z.object({ kind: z.literal('cancelled') }),
]);
export type CentralAuthResult = z.infer<typeof centralAuthResultSchema>;

/** A workspace redeems a code. As in `begin`, the origin is the binding's, never an argument. */
export const authRedeemInputSchema = z.strictObject({
  v: handoffVersion,
  kind: browserAuthKindSchema,
  ticket: opaque,
  code: opaque,
  browserHash: opaque,
  ownerSub: z.nullable(sub),
});
export type AuthRedeemInput = z.infer<typeof authRedeemInputSchema>;

export const authRedeemResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), returnPath, result: centralAuthResultSchema }),
  z.object({ ok: z.literal(false), reason: z.enum(['expired_or_used', 'invalid_request']) }),
]);
export type AuthRedeemResult = z.infer<typeof authRedeemResultSchema>;

/**
 * A workspace's service (Docs, Keep) asks its workspace whether an identity
 * the auth Worker proved may sign in, on every central redeem
 * (docs/CENTRAL_AUTH.md "Services"). RPC `MemberService.check` on the
 * workspace's Worker, over a service binding named `MEET`. The rules are the
 * workspace's own sign-in rules: its identity domains, then `people` (an
 * agent, a revoked person or a role without `ownProfile` is refused). A
 * person with no row yet is a first sign-in, as on the workspace.
 */
export const memberCheckInputSchema = z.strictObject({
  v: handoffVersion,
  sub,
  email: z.email(),
  hd: z.optional(z.string().check(z.maxLength(255))),
});
export type MemberCheckInput = z.infer<typeof memberCheckInputSchema>;

export const memberCheckResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), reason: z.enum(['invalid_request', 'not_member', 'blocked']) }),
]);
export type MemberCheckResult = z.infer<typeof memberCheckResultSchema>;
