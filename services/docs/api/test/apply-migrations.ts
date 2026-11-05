import { applyD1Migrations, env } from 'cloudflare:test';

// Runs before every test file. `TEST_MIGRATIONS` is injected by vitest.config.ts.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
