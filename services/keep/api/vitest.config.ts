import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

// Read at config time so the SQL travels into the worker as a binding — the
// test worker has no filesystem of its own.
const migrations = await readD1Migrations('./migrations');

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.test.jsonc' },
      miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
    }),
  ],
  resolve: {
    alias: {
      '@keep/contracts': path.resolve(import.meta.dirname, '../contracts/src/index.ts'),
      '@keep/crypto': path.resolve(import.meta.dirname, '../crypto/src/index.ts'),
    },
  },
  test: {
    setupFiles: ['./test/apply-migrations.ts'],
  },
});
