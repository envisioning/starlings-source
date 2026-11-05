// The operator dashboard on the ops host (docs/OPS_CONSOLE.md
// §Dashboard). A separate bundle: the starlings-ops Worker serves web/ops/dist
// as its static assets, behind its own Access check. It reads one route,
// `GET /api/fleet`, and shares only the shadcn components with the web app.
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { opsTokensCSS } from '@starlings/contracts/ops-theme';

const root = path.dirname(fileURLToPath(import.meta.url));

/** The dashboard holds no workspace session and no media: it reads the fleet JSON and nothing else. */
function opsBoundary(): Plugin {
  return { name: 'ops-boundary', moduleParsed(info) {
    if (/\/web\/src\/(?:owner-session|api|config|navigation|App|GuestSession|HostSession)\.[jt]sx?$/.test(info.id)
        || /\/node_modules\/(?:\.pnpm\/)?(?:livekit|@livekit|@mediapipe)/.test(info.id)) {
      this.error(`Workspace module reached the ops bundle: ${info.id}`);
    }
  } };
}

/**
 * `virtual:ops-tokens.css`: the console's design tokens from their one source,
 * packages/contracts/src/ops-theme.ts, which the Worker's server-rendered
 * pages also read.
 */
function opsTokens(): Plugin {
  const id = 'virtual:ops-tokens.css';
  const resolved = `\0${id}`;
  return {
    name: 'ops-tokens',
    resolveId: (source) => (source === id ? resolved : undefined),
    load: (loaded) => (loaded === resolved ? opsTokensCSS() : undefined),
  };
}

export default defineConfig({
  root,
  publicDir: false,
  resolve: { alias: { '@': path.resolve(root, '../src') } },
  plugins: [react(), tailwindcss(), opsTokens(), opsBoundary()],
  // One bundle for one internal page: React, zod and recharts, about 215 kB
  // gzipped. Splitting it saves the operator nothing.
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1000 },
});
