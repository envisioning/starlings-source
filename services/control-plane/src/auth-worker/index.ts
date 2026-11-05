// The `starlings-auth` Worker on the auth host (wrangler.auth.jsonc,
// docs/CENTRAL_AUTH.md). Two doors:
//
// - `fetch`: the browser's door: the sign-in screen and three Google
//   callbacks (google.ts, screen.ts).
// - `AuthService`: the workspaces' door, RPC over a service binding named
//   `AUTH`. It has no URL, so nothing on the internet can call it. The
//   binding's `props.origin` names the calling workspace; no
//   argument can.
// - `SignupService`: the product site's door for /start (signup.ts), over a
//   service binding named `SIGNUP` on starlings-site.
// - `SignupAdminService`: the operator console's door for its Requests page,
//   over a service binding named `SIGNUP_ADMIN` on starlings-ops, which
//   proves the operator with Cloudflare Access before it calls.
// - `GithubService`: the GitHub token broker (github.ts), over a service
//   binding named `GITHUB` on each workspace, with the same `props.origin`.
//   Its browser and webhook paths are under /api/github/ on this host.
// - `LiveKitService`: the LiveKit token broker (livekit.ts), over a service
//   binding named `LIVEKIT` on each workspace but Envisioning, with the same
//   `props.origin`.
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { AuthBeginResult, AuthBindingProps, AuthRedeemResult } from '@starlings/contracts/browser-auth';
import { beginAttempt, caller, redeemAttempt } from './attempts';
import type { AuthEnv } from './env';
import { githubBegin, githubCaller, githubComplete, githubDisconnect, githubStatus, githubToken, handleGithubFetch } from './github';
import { handleAuthFetch } from './google';
import { liveKitAdminToken, liveKitCaller, liveKitParticipantToken } from './livekit';
import { checkSignupSlugFree, decideSignup, listSignups, mintSignupLink, revokeSignupLinks, submitSignup, viewSignupLink } from './signup';

export class AuthService extends WorkerEntrypoint<AuthEnv, Partial<AuthBindingProps>> {
  /** A workspace or service asks for a ten-minute attempt for its own origin. The input is validated here, not trusted. */
  async begin(input: unknown): Promise<AuthBeginResult> {
    return beginAttempt(this.env, caller(this.ctx.props, this.env), input);
  }

  /** A workspace or service redeems a single-use code that was issued to its own origin. */
  async redeem(input: unknown): Promise<AuthRedeemResult> {
    return redeemAttempt(this.env, caller(this.ctx.props, this.env)?.origin ?? null, input);
  }
}

/**
 * The GitHub token broker. The workspace is the binding's `props.origin`;
 * every method answers for that workspace's installation and no other.
 */
export class GithubService extends WorkerEntrypoint<AuthEnv, unknown> {
  private get origin(): string | null {
    return githubCaller(this.ctx.props, this.env);
  }

  async begin(input: unknown) {
    return githubBegin(this.env, this.origin, input);
  }

  async complete(input: unknown) {
    return githubComplete(this.env, this.origin, input);
  }

  async status(input: unknown) {
    return githubStatus(this.env, this.origin, input);
  }

  async token(input: unknown) {
    return githubToken(this.env, this.origin, input);
  }

  async disconnect(input: unknown) {
    return githubDisconnect(this.env, this.origin, input);
  }
}

/**
 * The LiveKit token broker. The workspace is the binding's `props.origin`;
 * every method signs for that workspace's rooms and no other.
 */
export class LiveKitService extends WorkerEntrypoint<AuthEnv, unknown> {
  private get workspace(): string | null {
    return liveKitCaller(this.ctx.props, this.env);
  }

  async participant(input: unknown) {
    return liveKitParticipantToken(this.env, this.workspace, input);
  }

  async admin(input: unknown) {
    return liveKitAdminToken(this.env, this.workspace, input);
  }
}

export class SignupService extends WorkerEntrypoint<AuthEnv> {
  /** What /start shows for its token. */
  async view(token: unknown) {
    return viewSignupLink(this.env, token);
  }

  /** Whether a slug is free; only an open link may ask. */
  async checkSlug(token: unknown, slug: unknown) {
    return checkSignupSlugFree(this.env, token, slug);
  }

  /** The one submit. The site passes the caller's address for logs; the link is the gate. */
  async submit(input: unknown, _meta?: { ip?: string | null }) {
    return submitSignup(this.env, input);
  }
}

export class SignupAdminService extends WorkerEntrypoint<AuthEnv> {
  async mint(input: unknown) {
    return mintSignupLink(this.env, input);
  }

  /** Revoke every open signup link for an address. */
  async revoke(input: unknown) {
    return revokeSignupLinks(this.env, input);
  }

  async list() {
    return listSignups(this.env);
  }

  async decide(input: unknown) {
    return decideSignup(this.env, input);
  }
}

export default {
  fetch: async (request: Request, env: AuthEnv): Promise<Response> => (await handleGithubFetch(request, env)) ?? handleAuthFetch(request, env),
} satisfies ExportedHandler<AuthEnv>;
