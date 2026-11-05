/**
 * The Starlings GitHub App and its token broker (docs/GITHUB_CONNECTOR.md
 * "One App, one broker"). One App serves the whole fleet. Its private key is
 * in one Worker only, `starlings-auth`, which answers a workspace over a
 * service binding named `GITHUB` (entrypoint `GithubService`). The binding's
 * `props.origin` names the workspace, as the `AUTH` binding's does
 * (docs/CENTRAL_AUTH.md "The caller's origin"); no argument can. The broker
 * mints an installation token only for the installation recorded for that
 * origin.
 *
 * `zod/mini` and no import from the contracts index: the auth Worker bundles
 * this file (see browser-auth.ts).
 */
import { PRODUCT_SITE_ORIGIN } from './deployment.ts';
import * as z from 'zod/mini';

/**
 * The broker handoff version (docs/DEPLOY_STRATEGY.md rule 6). The auth
 * Worker deploys first, so when this moves to 2 it accepts 1 and 2 for one
 * release.
 */
export const GITHUB_BROKER_VERSION = 1;
const brokerVersion = z.literal(GITHUB_BROKER_VERSION);

/** Paths on the auth host. The App's manifest names each one. */
export const GITHUB_APP_PATHS = {
  /** GitHub sends the browser here after an install or an update of the installation. */
  setup: '/api/github/setup',
  /** GitHub returns the person's authorization here: the proof that they can reach the installation. */
  callback: '/api/github/callback',
  /** Installation events: an uninstall or a suspension drops the binding. */
  webhook: '/api/github/webhook',
} as const;

/** Paths on the workspace host. */
export const GITHUB_CONNECT_START_PATH = '/api/connectors/github/connect/start';
export const GITHUB_CONNECT_COMPLETE_PATH = '/api/connectors/github/connect/complete';

/**
 * What the App may do (docs/GITHUB_CONNECTOR.md). Issues write lets
 * `/api/crm/issue` file and edit through the App; everything else is read.
 */
export const GITHUB_APP_PERMISSIONS = {
  contents: 'read',
  pull_requests: 'read',
  checks: 'read',
  metadata: 'read',
  issues: 'write',
} as const;

/**
 * The manifest for `POST https://github.com/organizations/<org>/settings/apps/new`
 * (https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest).
 * `redirectUrl` receives the one-time code after the click; the creation
 * script listens there on loopback, so the private key goes from GitHub to
 * the auth Worker's secret and nowhere else.
 */
export function githubAppManifest(options: { authOrigin: string; redirectUrl: string; homepage?: string; name?: string }) {
  const at = (path: string) => new URL(path, options.authOrigin).toString();
  return {
    name: options.name ?? 'Starlings Work',
    url: options.homepage ?? PRODUCT_SITE_ORIGIN,
    description: 'Starlings reads the repositories a workspace maps to its projects: pull requests, checks and issues.',
    // Every firm installs the same App on its own account.
    public: true,
    hook_attributes: { url: at(GITHUB_APP_PATHS.webhook), active: true },
    redirect_url: options.redirectUrl,
    callback_urls: [at(GITHUB_APP_PATHS.callback)],
    setup_url: at(GITHUB_APP_PATHS.setup),
    // A reconnect to an installation that exists comes back through setup too.
    setup_on_update: true,
    // The broker asks for the authorization itself, after setup, so it can
    // carry the attempt's state through it.
    request_oauth_on_install: false,
    default_permissions: { ...GITHUB_APP_PERMISSIONS },
    // `installation` events reach every App without a subscription.
    default_events: [] as string[],
  };
}

/**
 * The value of the auth Worker's `GITHUB_APP` secret: what GitHub's manifest
 * conversion answered, as one line of JSON. Written by
 * `scripts/github-app-create.mjs`; nobody copies a key.
 */
export const githubAppSecretSchema = z.object({
  id: z.number(),
  slug: z.string().check(z.regex(/^[a-z0-9-]{1,100}$/u)),
  client_id: z.string().check(z.minLength(1)),
  client_secret: z.string().check(z.minLength(1)),
  webhook_secret: z.string().check(z.minLength(16)),
  pem: z.string().check(z.includes('PRIVATE KEY')),
});
export type GithubAppSecret = z.infer<typeof githubAppSecretSchema>;

/** A random token from `randomToken` or a SHA-256 from `sha256`: base64url. */
const opaque = z.string().check(z.regex(/^[A-Za-z0-9_-]{20,128}$/u));

/** What the `GITHUB` binding carries as `props`: the workspace origin alone. A service (Docs, Keep) has no binding. */
export const githubBindingPropsSchema = z.strictObject({ origin: z.string().check(z.minLength(8), z.maxLength(300)) });
export type GithubBindingProps = z.infer<typeof githubBindingPropsSchema>;

/** `begin`: an admin pressed Connect GitHub. `browserHash` is the SHA-256 of the secret in the workspace's host-only cookie. */
export const githubBeginInputSchema = z.strictObject({ v: brokerVersion, browserHash: opaque });
export type GithubBeginInput = z.infer<typeof githubBeginInputSchema>;

/** `complete`: the browser came back with the ticket and the code; the workspace proves it is the same browser. */
export const githubCompleteInputSchema = z.strictObject({ v: brokerVersion, ticket: opaque, code: opaque, browserHash: opaque });
export type GithubCompleteInput = z.infer<typeof githubCompleteInputSchema>;

/** `token`, `status` and `disconnect` take the version alone. */
export const githubPlainInputSchema = z.strictObject({ v: brokerVersion });
export type GithubPlainInput = z.infer<typeof githubPlainInputSchema>;

export const GITHUB_BROKER_REFUSALS = [
  /** The props name no workspace this Worker serves. */
  'origin_refused',
  'invalid_request',
  /** The auth Worker holds no App yet (the `GITHUB_APP` secret is unset). */
  'not_configured',
  /** No installation is recorded for this workspace. */
  'not_connected',
  'expired_or_used',
  /** The installation is bound to another workspace. */
  'installation_taken',
  /** GitHub refused to mint a token. */
  'github_failed',
] as const;
const refusal = z.object({ ok: z.literal(false), reason: z.enum(GITHUB_BROKER_REFUSALS) });
export type GithubBrokerRefusal = z.infer<typeof refusal>;

/** The account the installation is on, and when this workspace bound it. */
const connection = z.object({
  installation_id: z.number(),
  account: z.string(),
  connected_at: z.number(),
});
export type GithubConnection = z.infer<typeof connection>;

export const githubBeginResultSchema = z.union([z.object({ ok: z.literal(true), ticket: opaque, installUrl: z.string() }), refusal]);
export type GithubBeginResult = z.infer<typeof githubBeginResultSchema>;

export const githubCompleteResultSchema = z.union([z.object({ ok: z.literal(true), connection }), refusal]);
export type GithubCompleteResult = z.infer<typeof githubCompleteResultSchema>;

export const githubStatusResultSchema = z.union([z.object({ ok: z.literal(true), connection: z.nullable(connection) }), refusal]);
export type GithubStatusResult = z.infer<typeof githubStatusResultSchema>;

export const githubTokenResultSchema = z.union([
  z.object({ ok: z.literal(true), token: z.string().check(z.minLength(1)), expiresAt: z.number() }),
  refusal,
]);
export type GithubTokenResult = z.infer<typeof githubTokenResultSchema>;

export const githubDisconnectResultSchema = z.union([z.object({ ok: z.literal(true), removed: z.boolean() }), refusal]);
export type GithubDisconnectResult = z.infer<typeof githubDisconnectResultSchema>;

/** The auth host's query strings. */
export const githubSetupQuerySchema = z.object({
  state: opaque,
  installation_id: z.optional(z.string().check(z.regex(/^\d{1,20}$/u))),
  setup_action: z.optional(z.string().check(z.maxLength(40))),
});
export const githubCallbackQuerySchema = z.object({
  state: opaque,
  code: z.optional(z.string().check(z.minLength(1), z.maxLength(512))),
  error: z.optional(z.string().check(z.maxLength(200))),
});
export const githubCompleteQuerySchema = z.object({ ticket: opaque, code: opaque });
