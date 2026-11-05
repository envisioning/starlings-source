// Bindings and secrets. Vars come from wrangler.jsonc; secrets are set with
// `wrangler secret put` and listed here so a missing one is a type error
// rather than a runtime surprise.
//
// Declared inside `Cloudflare` and re-exported as the global `Env`, matching
// what `wrangler types` generates — the test pool's `ProvidedEnv` extends
// `Cloudflare.Env`, so anything declared only on the global would be invisible
// to tests.

declare namespace Cloudflare {
  interface Env {
    // Bindings
    DB: D1Database;
    DOCS_FILES: R2Bucket;
    ASSETS: Fetcher;
    CLAIM_LIMIT?: RateLimit;
    SIGN_LIMIT?: RateLimit;
    /**
     * Central sign-in (WEB_SIGN_IN = central, src/central-auth.ts). AUTH is the
     * auth Worker's AuthService; MEET is the workspace Worker's MemberService,
     * also told of guest views and clicks (src/access-notify.ts). Both RPC
     * over a service binding. Typed `unknown`: `MemberBinding` in
     * central-auth.ts names the methods, and every answer is parsed.
     */
    AUTH?: unknown;
    MEET?: unknown;

    // Vars
    ENVIRONMENT: string;
    WEB_ORIGIN: string;
    PUBLIC_API_ORIGIN: string;
    GOOGLE_WEB_CLIENT_ID: string;
    CORE_API_ORIGIN: string;
    EMAIL_FROM: string;
    EMAIL_MODE: 'log' | 'send';
    /**
     * Comma-separated identity domains, compared lower case. Unset = Envisioning's
     * two. Empty or invalid = nobody. Read only through `identityDomains`.
     */
    IDENTITY_DOMAINS?: string;
    /** `google` (unset), `central` or `off`. Any other value is `off`. Read only through `webSignIn`. */
    WEB_SIGN_IN?: string;
    /** The auth host, `https://auth.starlings.example`, on a `central` deployment. */
    AUTH_ORIGIN?: string;
    /** The workspace's name in the SPA. Unset: Envisioning's own deployment. Read through `GET /api/deployment`. */
    WORKSPACE_NAME?: string;
    /**
     * The workspace's Meet web origin. Staff pages redirect to its /docs
     * (envisioning/docs#24, `src/staff-redirect.ts`). Unset: no redirect,
     * the SPA serves them (local dev).
     */
    MEET_WEB_ORIGIN?: string;

    // Secrets — `wrangler secret put <NAME>`
    /** ≥32 chars. Signs staff and guest sessions, and OAuth state. */
    SESSION_SIGNING_SECRET: string;
    /**
     * Separate from the session secret so rotating sessions cannot invalidate
     * every signature seal ever written. Falls back to SESSION_SIGNING_SECRET
     * when unset — set it before signing anything that matters.
     */
    SIGNATURE_SEAL_SECRET: string;
    GOOGLE_WEB_CLIENT_SECRET: string;
    /** Shared with Core. HMACs the /api/ingest handshake. */
    INTERNAL_REQUEST_SECRET: string;
    /** Shared with the Meet Worker. HMACs /api/tokens/meet-exchange. */
    DOCS_INTERNAL_SECRET: string;
    /** Core's two Supabase projects, for the hourly mirror. Absent = the sweep records "not configured" and does nothing. */
    SUPABASE_URL_CMS?: string;
    SUPABASE_SERVICE_ROLE_KEY_CMS?: string;
    SUPABASE_URL_CRM?: string;
    SUPABASE_SERVICE_ROLE_KEY_CRM?: string;
    POSTMARK_TOKEN: string;
  }
}

interface Env extends Cloudflare.Env {}
