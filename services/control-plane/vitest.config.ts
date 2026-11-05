import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));

/*
 * The pool loads `services/control-plane/.dev.vars` next to the wrangler
 * config, so a developer's local secrets would reach the suite and a local run
 * would take a different path from CI. There is no switch to turn
 * that load off, so every optional secret that unlocks an outside call is set
 * here, to empty, which every reader treats as "not configured" — the same as
 * CI, where the file does not exist. A test that wants one sets it itself. Add
 * a new optional secret from `src/secrets.d.ts` here when it unlocks a call.
 * `test/no-network.ts` is the backstop for anything this list misses.
 */
const UNSET_SECRETS = [
  'MANAGED_AGENT_PROVISIONING_KEY',
  'PUBLIC_LEAD_SECRET',
  'AGENT_WEBHOOK_SECRET',
  'AI_GATEWAY_API_KEY',
  'ANTHROPIC_API_KEY',
  'DOCS_INTERNAL_SECRET',
  'GITHUB_ISSUES_TOKEN',
  'GOOGLE_CONNECTOR_CLIENT_SECRET',
  'GRANOLA_API_KEY',
  'INTERNAL_REQUEST_SECRET',
  'KEEP_INTERNAL_SECRET',
  'POSTMARK_API_KEY',
  'REVIEW_SIGN_IN_EMAIL',
  'REVIEW_SIGN_IN_PASSWORD_HASH',
  'SLACK_USER_TOKEN',
  'TURNSTILE_SECRET_KEY',
];

export default defineConfig({
  // The tests run inside workerd, which has no process.env: say here whether this run records.
  define: { __RECORD_RESPONSES__: JSON.stringify(process.env.RESPONSE_FIXTURES === 'write') },
  /*
   * Vitest's 5s default is not enough here, and the way it failed was the
   * expensive part: every test in this suite awaits a `fetch` into workerd, so
   * a cold pool or a loaded machine times out whole files at once, with no
   * assertion failure to point at a cause. Locally that produced 13/74 on one
   * run and 6/74 on the next while a standalone run passed 74/74 in 13s — and
   * because `cf:build` gates `cf:deploy` on this suite, a flake here stops
   * production deploys rather than just annoying somebody.
   *
   * 30s is well clear of the ~13s a warm full-suite run takes, and still fails
   * fast enough to catch a genuine hang. The import of the Worker itself is not
   * in that budget: `test/load-main.ts` does it in a hook first.
   */
  test: {
    // Recorded responses (test/response-fixtures.test.ts) are compared, never written, unless
    // `node scripts/record-response-fixtures.mjs --write` asks.
    update: process.env.RESPONSE_FIXTURES === 'write' ? 'all' : 'none',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    setupFiles: ['./test/no-network.ts', './test/apply-migrations.ts', './test/reset-core-gate.ts', './test/load-main.ts'],
  },
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.join(root, 'migrations'));
      const authMigrations = await readD1Migrations(path.join(root, 'auth-migrations'));
      return {
        wrangler: { configPath: './wrangler.test.jsonc' },
        miniflare: {
          bindings: {
            ...Object.fromEntries(UNSET_SECRETS.map((name) => [name, ''])),
            SESSION_SIGNING_SECRET: 'test-session-signing-secret-with-at-least-32-characters',
            GOOGLE_WEB_CLIENT_SECRET: 'test-google-client-secret',
            GOOGLE_TOKEN_ENCRYPTION_KEY: 'test-google-token-encryption-key-32b+',
            LIVEKIT_API_KEY: 'devkey',
            LIVEKIT_API_SECRET: 'secret',
            // One inbound key per caller: Core's, and the test
            // roster's own agent (wrangler.test.jsonc), named by
            // `x-internal-key-id`.
            INBOUND_KEY_CORE: 'inbound-test-secret-with-at-least-32-characters',
            INBOUND_KEY_AGENT_VOCAB_EXAMPLE_COM: 'vocab-inbound-test-key-with-at-least-32-characters',
            // The Granola door. Base64 after `whsec_`, like Granola's own, so
            // the tests exercise the key decoding and not just the HMAC.
            GRANOLA_WEBHOOK_SECRET: 'whsec_Z3Jhbm9sYS10ZXN0LXNpZ25pbmcta2V5LWJ5dGVz',
            TEST_MIGRATIONS: migrations,
            AUTH_TEST_MIGRATIONS: authMigrations,
          },
        },
      };
    }),
  ],
});
