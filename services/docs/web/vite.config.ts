import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // The shadcn kit copied from Meet imports `@/lib/utils` and `@/ui/*`.
      '@': path.resolve(import.meta.dirname, 'src'),
      '@docs/contracts': path.resolve(import.meta.dirname, '../contracts/src/index.ts'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5174,
    // `pnpm dev` runs the Worker on 8788; the SPA talks to it through here so
    // cookies stay same-origin in development.
    proxy: {
      '/api': { target: 'http://127.0.0.1:8788', changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
});
