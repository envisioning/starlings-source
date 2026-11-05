/**
 * The bindings of the `starlings-auth` Worker (wrangler.auth.jsonc). Written
 * by hand: `wrangler types` generates the workspace Worker's `Env` only, and a
 * second generated file would declare a second global `Env`.
 */
export interface AuthEnv {
  /** Sign-in attempts. Its own D1 (`starlings-auth`); no workspace reads it. */
  AUTH_DB: D1Database;
  ENVIRONMENT: string;
  /** This Worker's own origin, `the auth host`. Google returns here. */
  AUTH_ORIGIN: string;
  /** Exact HTTPS origins, comma-separated, that are not `<slug>.<suffix>` but may receive a code. */
  RETURN_ORIGIN_ALIASES?: string;
  /** The same client as every workspace's GOOGLE_WEB_CLIENT_ID: a workspace exchanges the Calendar code. */
  GOOGLE_WEB_CLIENT_ID: string;
  /** The same client as every workspace's GOOGLE_CONNECTOR_CLIENT_ID. Empty: connector consent is off. */
  GOOGLE_CONNECTOR_CLIENT_ID: string;
  /**
   * Starlings' calendar-only client (Google project starlings-calendar), the
   * same as every workspace's GOOGLE_CALENDAR_CLIENT_ID. Empty: calendar
   * consent uses the web client.
   */
  GOOGLE_CALENDAR_CLIENT_ID?: string;
  /** Secret. Signs the OAuth state and keys the AES-GCM seal of each result. At least 32 characters. */
  AUTH_SIGNING_SECRET: string;
  /** Secret. The web client's secret, for the sign-in code exchange only. */
  GOOGLE_WEB_CLIENT_SECRET: string;
  /** Secret. Postmark's Starlings server (signup.ts). Absent: no signup mail is sent and minting a link fails. */
  POSTMARK_API_KEY?: string;
  /**
   * Secret. The Starlings GitHub App as one line of JSON (id, slug, client id
   * and secret, webhook secret, private key), written by
   * scripts/github-app-create.mjs. Absent: the GitHub broker answers
   * `not_configured`. No other Worker holds it.
   */
  GITHUB_APP?: string;
  /**
   * Envisioning's LiveKit key pair, from the Secrets Store starlings-shared,
   * for the LiveKit broker (livekit.ts). No workspace but
   * Envisioning binds it. Absent: the broker answers `not_configured`.
   */
  SHARED_LIVEKIT_API_KEY?: SecretsStoreSecret;
  SHARED_LIVEKIT_API_SECRET?: SecretsStoreSecret;
  /** The sender of every signup mail, on the verified the workspace domain domain. */
  MAIL_FROM: string;
  /** Who hears about a new workspace request. */
  OPS_ALERT_EMAIL: string;
  /** The product site, `the product site`. Signup links point at its /start. */
  SIGNUP_ORIGIN: string;
  /** The operator console, `the ops host`. */
  OPS_ORIGIN: string;
}
