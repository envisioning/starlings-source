// A workspace whose `GITHUB` binding answers as the token broker does for a
// connected workspace (docs/GITHUB_CONNECTOR.md "One App, one broker"). The
// broker itself is tested in github-broker.test.ts; tests of what a
// workspace does with a token use this instead of an App key.
import { resetGithubTokenCache } from '../src/github-app';

export function connectedGithub(base: Env, options: { token?: string; account?: string } = {}): Env {
  resetGithubTokenCache();
  const connection = { installation_id: 2, account: options.account ?? 'envisioning', connected_at: 1 };
  return {
    ...base,
    GITHUB: {
      begin: async () => ({ ok: false, reason: 'invalid_request' }),
      complete: async () => ({ ok: false, reason: 'invalid_request' }),
      status: async () => ({ ok: true, connection }),
      token: async () => ({ ok: true, token: options.token ?? 'ghs_test', expiresAt: Date.now() + 3_600_000 }),
      disconnect: async () => ({ ok: true, removed: true }),
    },
  } as unknown as Env;
}
