/**
 * Everything the generated `worker-configuration.d.ts` cannot know.
 *
 * Secrets are the reason this file exists: a secret is set with
 * `wrangler secret put`, never written into `wrangler.jsonc`, so no generator
 * can see one. `wrangler types` used to pick them up from whatever `.dev.vars`
 * happened to sit next to the config, which made the generated file differ per
 * machine and failed `--check` on CI and on a fresh clone. Generation is now
 * pinned to `types.env`, and this is where the secrets are declared by hand.
 */
interface MeetSecrets {
  /** The app channel door's key, from the Secrets Store. Unbound: the door stays closed. */
  APP_INTAKE_KEY?: SecretsStoreSecret;
  /** Ephemeral per-workspace operator bootstrap; removed after managed installation. Never supplied to an agent. */
  MANAGED_AGENT_PROVISIONING_KEY?: string;
  SESSION_SIGNING_SECRET: string;
  /**
   * The secret `SESSION_SIGNING_SECRET` replaced, set only while a rotation is
   * under way: tokens it signed still verify (docs/SECURITY.md ›
   * Rotating the session signing secret). Absent otherwise.
   */
  SESSION_SIGNING_SECRET_PREVIOUS?: string;
  GOOGLE_WEB_CLIENT_SECRET: string;
  /** Starlings' calendar-only client (GOOGLE_CALENDAR_CLIENT_ID). Absent with the id unset: the web client. */
  GOOGLE_CALENDAR_CLIENT_SECRET?: string;
  GOOGLE_TOKEN_ENCRYPTION_KEY: string;
  /**
   * The Google connector's OAuth client secret (docs/CONNECTORS.md). Absent =
   * the Gmail and Drive grant is not offered.
   */
  GOOGLE_CONNECTOR_CLIENT_SECRET?: string;
  LIVEKIT_API_KEY: string;
  LIVEKIT_API_SECRET: string;
  /**
   * Shared HMAC secret for server-to-server calls into Core (meeting-log
   * ingest). Absent in dev and tests, which disables CRM sync entirely.
   */
  INTERNAL_REQUEST_SECRET?: string;
  /** Enable the staged, retryable D1-to-Core favorites write bridge. */
  FAVORITES_SYNC_ENABLED?: string;
  /** Read legacy CRM stars from Core after per-member counts have been checked. */
  FAVORITES_READS_FROM_CORE?: string;
  /**
   * Being retired. The old fleet secret that signed the outbound
   * hand-off to every config agent. A config agent's own key is the Worker
   * secret `WEBHOOK_KEY_<ADDRESS>` (`callerSecretName` in agent-roster.ts);
   * this one signs only an agent that has none yet, and each such hand-off is
   * logged (`agents.webhook.shared_secret`). With neither, nothing is sent
   * outside development. See docs/AGENTS_SURFACE.md.
   */
  AGENT_WEBHOOK_SECRET?: string;
  /**
   * Turnstile secret for the public write routes (join, book, feedback).
   * Absent = bot checking off. Must be set together with the web bundle's
   * `VITE_TURNSTILE_SITE_KEY` — see `turnstile.ts`. Native knocks skip the
   * check so flipping this secret does not break shipped Mac/iOS builds.
   */
  TURNSTILE_SECRET_KEY?: string;
  /**
   * The key the sites sign `POST /api/public/leads` with
   * (docs/SECURITY.md, "The public lead route"). At least 32 characters.
   * Absent = the route answers 404. Nothing else reads it.
   */
  PUBLIC_LEAD_SECRET?: string;
  /**
   * Fine-grained GitHub token, Issues: read+write on `GITHUB_ISSUES_REPO` only.
   * Absent disables `POST /api/feedback` with `not_configured`.
   */
  GITHUB_ISSUES_TOKEN?: string;
  /**
   * Fine-grained GitHub token, Contents: read on `envisioning/starlings` only. Lets
   * the hourly deploy check compare `BUILD_COMMIT` with `main` when the Meet
   * GitHub App is not configured. Absent, the check is skipped and
   * Admin › Operations says so.
   */
  GITHUB_DEPLOY_CHECK_TOKEN?: string;
  /**
   * The App Store Connect API key (the `.p8` file's text), its key id, the
   * issuer id and the numeric app id. They let the daily TestFlight check
   * read the newest build's upload date. They are the same four
   * values the `testflight-age` and iOS release workflows read as Actions
   * secrets. Absent, the check is skipped and Admin › Operations says so.
   */
  APPLE_API_KEY?: string;
  APPLE_API_KEY_ID?: string;
  APPLE_API_ISSUER_ID?: string;
  ASC_APP_ID?: string;
  /**
   * Postmark server token, sending as `MAIL_FROM`, whose domain is verified
   * on that server: core-web's server for the Envisioning workspace, the
   * Starlings server (Secrets Store) for every other Worker. Absent = no mail goes out:
   * the interest form still saves the row, and nobody gets a copy.
   */
  POSTMARK_API_KEY?: string;
  /**
   * Granola personal or workspace API key (`grn_…`), created in the Granola
   * app under Settings → Connectors → API keys. Read-only against Granola;
   * it is the only way to read a note's body, because a webhook delivery
   * carries an id and nothing else. Absent = the bridge is off and the
   * backfill route answers `not_configured`.
   * See docs/GRANOLA_BRIDGE.md.
   */
  GRANOLA_API_KEY?: string;
  /**
   * Vercel AI Gateway key. When set, the Granola filing suggestion calls
   * `typesafe-ai/jev` through the gateway instead of `typesafe/jev` on
   * Workers AI — same questions, same answers, billed to Vercel instead of
   * Cloudflare's AI Gateway credits. Absent = Workers AI. See
   * docs/GRANOLA_BRIDGE.md §Suggested filing.
   */
  AI_GATEWAY_API_KEY?: string;
  /**
   * Signing secret for Granola's webhook deliveries (`whsec_…`), shown once
   * when the endpoint is created. Standard Webhooks, so base64 over
   * `<id>.<timestamp>.<body>` — deliberately not any of the hex HMAC secrets
   * above, and verifying with the wrong one silently never matches.
   * Absent = `/api/internal/granola-webhook` answers 404.
   */
  GRANOLA_WEBHOOK_SECRET?: string;
  /**
   * Anthropic API key. Present = meeting notes are written by Claude
   * (`NOTES_MODEL`); absent = Workers AI writes them as before. The
   * transcript text is what crosses, never audio (docs/PRIVACY.md).
   */
  ANTHROPIC_API_KEY?: string;
}

/**
 * `Cloudflare.Env` is what `env` from `cloudflare:workers` is typed as, and the
 * tests spread it to build a Worker environment. It gets the secrets too, or a
 * test environment would be missing them and read as broken rather than as the
 * deliberate omission it is.
 */
declare namespace Cloudflare {
  interface Env extends MeetSecrets {}
}

interface Env extends MeetSecrets {
  /**
   * Who gets the operational alert mail (`ops.ts`). Empty means
   * no mail. Widened from the literal the generated types infer.
   */
  OPS_ALERT_EMAIL: string;
  /**
   * Yesterday's model tokens, summed across providers, above which the daily
   * cron counts a `model_spend` failure (`model-usage.ts`). A
   * wrangler var holding a number. Unset means no check.
   */
  SPEND_ALERT_DAILY_TOKENS?: string;
  /** Notarized macOS zips, keyed `mac/<version>/Starlings-macOS.zip` (`Meet-macOS.zip` before) plus `mac/latest/`. */
  DOWNLOADS?: R2Bucket;
  /**
   * Profile pictures, keyed `avatars/<sub>`. Optional for the same reason
   * `DOWNLOADS` is: a deploy from a config that predates the bucket must
   * degrade to initials, not 500. See `avatars.ts`.
   */
  AVATARS?: R2Bucket;
  /** Public TestFlight invite URL; blank until the beta is available. */
  IOS_TESTFLIGHT_URL: string;
  /**
   * The page an Android build below `MIN_RECOMMENDED_VERSION_ANDROID` is
   * sent to (a signed APK by hand today, later the Play listing). Empty
   * sends no link; the banner still shows.
   */
  ANDROID_UPDATE_URL?: string;
  /** Empty disables native update recommendations for that platform. */
  MIN_RECOMMENDED_VERSION_MACOS?: string;
  MIN_RECOMMENDED_VERSION_IOS?: string;
  MIN_RECOMMENDED_VERSION_ANDROID?: string;
  /**
   * The GitHub connector's kill switch, `on` or `off`
   * (docs/GITHUB_CONNECTOR.md). The App itself is the `GITHUB` binding to
   * the token broker in starlings-auth; this Worker holds no App key.
   */
  GITHUB_SYNC_ENABLED: string;
  /**
   * The Slack import (docs/SLACK_IMPORT.md): a user token with read scopes,
   * and `SLACK_IMPORT_ENABLED` as the kill switch, `on` or `off`.
   */
  SLACK_USER_TOKEN?: string;
  SLACK_IMPORT_ENABLED: string;
  /** Public CRM origin for guest scheduling proxy (default the Core host). */
  CORE_API_ORIGIN?: string;
  /**
   * This workspace's own Docs: Envisioning's is
   * the workers.dev host — the served origin, not the Gandi redirect,
   * because a redirected POST loses its body and its HMAC headers. No default:
   * without it the Worker has no Docs.
   */
  DOCS_ORIGIN?: string;
  /**
   * Shared HMAC secret for the Meet → Docs token exchange. Its own pair, not
   * `INTERNAL_REQUEST_SECRET`, so Core and Docs rotate independently. Absent
   * in dev and tests, which makes `/api/docs/token` answer `not_configured`.
   */
  DOCS_INTERNAL_SECRET?: string;
  /**
   * Shared with this workspace's own Keep (KEEP_ORIGIN) and no
   * other. HMACs the device-token exchange
   * for the native Keep client (`/api/keep/token`). Its own secret, like
   * Docs', so Keep rotates independently. Absent in dev and tests, which
   * makes the route answer `not_configured`.
   */
  KEEP_INTERNAL_SECRET?: string;
  /**
   * Origin of Core's guest-facing pages (reschedule / cancel), when they are
   * not served from CORE_API_ORIGIN. Meet joins Core-supplied paths to this, so
   * the join card can only ever link to a host Meet was configured with.
   */
  CORE_WEB_ORIGIN?: string;
  /** `on` (default) or `off` — kill switch for the CRM meeting log. */
  CRM_SYNC_MODE?: string;
  /**
   * The Plausible site that counts use of the web app (docs/ANALYTICS.md).
   * Set on Envisioning only. Unset: no `/api/event`, no analytics meta.
   */
  PLAUSIBLE_DOMAIN?: string;
  /** The workspace's name in product chrome. Unset on Envisioning. */
  WORKSPACE_NAME?: string;
  /** `#rrggbb`, the workspace's accent on the web. Unset on Envisioning. */
  WORKSPACE_ACCENT?: string;
  /**
   * Who can join, as the applicant chose it on the signup page: `domains` or
   * `invite` (docs/ONBOARDING.md decision 12). Written by
   * `scripts/provision-workspace.mjs --from-request`; unset on a workspace
   * that predates signup. The setup checklist reads it.
   */
  WORKSPACE_MEMBERSHIP?: string;
  /** `core` or `d1` (work-store.ts). Typed loose so tests can set `d1`. */
  WORK_STORE?: string;
  /**
   * Where booking pages answer from, `core` or `d1` (work-store.ts
   * `bookingStore`). Unset follows WORK_STORE. Envisioning sets `d1` to flip
   * (docs/CORE_FOLD_PLAN.md §Phase 3d).
   */
  BOOKING_STORE?: string;
  /**
   * Where each table group answers from on a WORK_STORE=core workspace,
   * `core` or `d1` (work-store.ts `groupStore`). Unset follows
   * WORK_STORE. Set by a deploy, after the group's copy has verified.
   */
  WORK_STORE_SUBJECTS?: string;
  WORK_STORE_TASKS?: string;
  WORK_STORE_GOALS?: string;
  WORK_STORE_INTERACTIONS?: string;
  WORK_STORE_COMMERCIAL?: string;
  /** `owner/repo` the bug reports land in. Blank in dev and tests. */
  GITHUB_ISSUES_REPO?: string;
  /**
   * The agents this deployment knows about, as `{ "`vocab@example.com`":
   * "Vocab" }`. The `people` rows of `kind = 'agent'` are derived from it, so
   * adding an agent is a deploy rather than a migration. Widened from the
   * literal the generated types infer, exactly like `OPS_ALERT_EMAIL`.
   * See docs/AGENTS_SURFACE.md.
   */
  AGENT_ROSTER: string;
  /** Burst guards on the unauthenticated write routes; absent in tests. */
  FEEDBACK_LIMIT?: RateLimit;
  JOIN_LIMIT?: RateLimit;
  PRESENCE_LIMIT?: RateLimit;
  /** Burst guard on the signed inbound door. Absent in tests. */
  AGENT_LIMIT?: RateLimit;
  /** Burst guard on the MCP pairing routes and `/mcp` itself (docs/MCP.md). Absent in tests. */
  MCP_LIMIT?: RateLimit;
  /** Burst guard on bounded operational error batches. Absent in the test Worker. */
  ERROR_EVENT_LIMIT?: RateLimit;
  /** Burst guard on link unfurling — the one route that fetches an address a
   * message chose, rather than one of ours. Absent in tests. */
  LINK_PREVIEW_LIMITER?: RateLimit;
}
