/**
 * The bindings of the `starlings-ops` Worker (wrangler.ops.jsonc). Written by
 * hand: `wrangler types` generates the workspace Worker's `Env` only, and a
 * second generated file would declare a second global `Env`.
 *
 * The Worker holds no storage. Its only bindings are vars, one service
 * binding per workspace, `WORKSPACE_<SLUG>`, to that workspace's `OpsService`
 * entrypoint (fleet.ts), one `DOCS_<SLUG>` and `KEEP_<SLUG>` binding per
 * workspace that has them, to that Worker's `OpsService`, `SIGNUP_ADMIN` to starlings-auth's
 * `SignupAdminService` (requests.ts), `HQ_INTERESTS` to hq's `InterestService`, and `ASSETS`, the dashboard's static files.
 */
export interface OpsEnv {
  ENVIRONMENT: string;
  /** The Cloudflare Access team domain, `<team>.cloudflareaccess.com`. Empty: every request is refused. */
  OPS_ACCESS_TEAM_DOMAIN: string;
  /** The Access application's AUD tag (64 hex characters). Empty: every request is refused. */
  OPS_ACCESS_AUD: string;
  /** The operators, a comma list of addresses. Empty: every request is refused. */
  OPS_OPERATORS: string;
  /** The dashboard's files (web/ops/dist). Absent in tests: the dashboard answers 503. */
  ASSETS?: unknown;
  /** starlings-auth's `SignupAdminService` (requests.ts). Absent: the Requests page says so. */
  SIGNUP_ADMIN?: unknown;
  /** hq's `InterestService`: the interest requests the Requests page answers. Absent: the page says so. */
  HQ_INTERESTS?: unknown;
  /** The service bindings, `WORKSPACE_<SLUG>`, `DOCS_<SLUG>` and `KEEP_<SLUG>`. */
  [binding: string]: unknown;
}
