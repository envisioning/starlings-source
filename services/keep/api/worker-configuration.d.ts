// Bindings and secrets. Vars come from wrangler.jsonc; secrets are set with
// `wrangler secret put` and listed here so a missing one is a type error
// rather than a runtime surprise.
//
// Note what is absent: there is no encryption key. The Worker holds nothing
// that opens a vault, by design. See README.md § Threat model.

declare namespace Cloudflare {
  interface Env {
    // Bindings
    DB: D1Database;
    ASSETS: Fetcher;
    REVEAL_LIMIT?: RateLimit;
    /**
     * Central sign-in (WEB_SIGN_IN = central, src/central-auth.ts). AUTH is the
     * auth Worker's AuthService; MEET is the workspace Worker's MemberService.
     * Both RPC over a service binding. Typed `unknown`: central-auth.ts names
     * the methods it calls and parses every answer.
     */
    AUTH?: unknown;
    MEET?: unknown;

    // Vars
    ENVIRONMENT: string;
    WEB_ORIGIN: string;
    PUBLIC_API_ORIGIN: string;
    /** Empty on a deployment with WEB_SIGN_IN `off`. */
    GOOGLE_WEB_CLIENT_ID: string;
    /** Where a vault's `project_id` links out to. Empty when the deployment has no Core: the SPA shows no link. */
    CORE_WEB_ORIGIN: string;
    /** Admitted account domains, comma-separated, lowercase. Unset = `org.example`. Empty or malformed = nobody. See `src/identity.ts`. */
    IDENTITY_DOMAINS?: string;
    /** `google` (unset), `central` or `off`. Off: the Google routes answer 503 and only the Meet exchange mints a credential. Read through `webSignIn`. */
    WEB_SIGN_IN?: string;
    /** The auth host, `https://auth.starlings.example`, on a `central` deployment. */
    AUTH_ORIGIN?: string;
    /** The workspace's name in the SPA and the passkey prompt. Unset: Envisioning's own deployment. Read through `GET /api/deployment`. */
    WORKSPACE_NAME?: string;
    /** `TEAMID.bundle.id`, comma-separated: the apps allowed passkeys on this origin. */
    APPLE_APP_IDS: string;

    // Secrets — `wrangler secret put <NAME>`
    /** ≥32 chars. Signs staff sessions and OAuth state. */
    SESSION_SIGNING_SECRET: string;
    GOOGLE_WEB_CLIENT_SECRET: string;
    /** Shared with the Meet Worker. HMACs /api/tokens/meet-exchange. Absent = no device tokens. */
    KEEP_INTERNAL_SECRET?: string;
  }
}

interface Env extends Cloudflare.Env {}
