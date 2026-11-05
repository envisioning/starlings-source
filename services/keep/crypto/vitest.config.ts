import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@keep/contracts': path.resolve(import.meta.dirname, '../contracts/src/index.ts'),
    },
  },
  test: { environment: 'node' },
});
