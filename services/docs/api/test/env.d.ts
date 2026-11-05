import type { D1Migration } from 'cloudflare:test';

// `cloudflare:test` types `env` as `Cloudflare.Env`, so a test-only binding has
// to be declared on that interface. It exists only under vitest — nothing in
// src/ may read it.
declare global {
  namespace Cloudflare {
    interface Env {
      /** Injected by vitest.config.ts from ./migrations. */
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
