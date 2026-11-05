import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vitest/config';

/*
 * The tests do not use `vite.config.ts`: its plugins fetch the MediaPipe
 * model, count commits, and read changelog/, none of which a render test
 * needs. The two virtual modules the app imports are answered with fixed
 * values instead.
 */
function virtualStubs(): Plugin {
  const stubs: Record<string, string> = {
    'virtual:meet-version': "export const meetVersion = '0.0.0';\nexport const meetBuild = '0';\n",
    'virtual:meet-changelog': "export const meetChangelog = { releases: [], updates: [] };\n",
    'virtual:meet-help': "export const helpDocs = [{ path: 'docs/help/surfaces/home.md', slug: 'surfaces/home', kind: 'reference', status: 'active', verified: '2026-09-22', summary: 'Home: the clock', surface: 'home', capabilities: ['owner-home'], body: '# Home\\n\\nToday. See [team](team.md).\\n' }, { path: 'docs/help/howto/join-a-room.md', slug: 'howto/join-a-room', kind: 'howto', status: 'active', verified: '2026-09-22', summary: 'Enter a room', capabilities: [], body: '# Join a room\\n\\n1. Open the link.\\n' }];\n",
  };
  return {
    name: 'meet-virtual-stubs',
    resolveId(id) {
      if (id in stubs) return `\0${id}`;
    },
    load(id) {
      const key = id.startsWith('\0') ? id.slice(1) : id;
      if (key in stubs) return stubs[key];
    },
  };
}

/*
 * `styles.css` as text, for the colour-token test. Vitest blanks a
 * stylesheet's `?raw` import, so the file is read here instead.
 */
function stylesSource(): Plugin {
  const id = 'virtual:meet-styles-source';
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'src', 'styles.css');
  return {
    name: 'meet-styles-source',
    resolveId(requested) {
      if (requested === id) return `\0${id}`;
    },
    load(requested) {
      if (requested === `\0${id}`) return `export const stylesSource = ${JSON.stringify(readFileSync(file, 'utf8'))};\n`;
    },
  };
}

export default defineConfig({
  resolve: {
    alias: { '@shared': path.join(path.dirname(fileURLToPath(import.meta.url)), 'src'), '@': path.join(path.dirname(fileURLToPath(import.meta.url)), 'src') },
  },
  plugins: [react(), virtualStubs(), stylesSource()],
  test: {
    environment: 'jsdom',
    // The gate runs on the efficiency cores (`taskpolicy -c background`,
    // scripts/gate-lock.sh, 2026-10-05). With other sessions loading the
    // Mac, a jsdom render test that takes under 2s alone passed the 5s
    // default and failed the gate (2026-10-06). The limit catches a hang,
    // not a slow core.
    testTimeout: 30_000,
    include: ['src/**/*.test.{ts,tsx}', 'marketing/src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test-setup.ts'],
    server: {
      deps: {
        // `vi.mock('livekit-client')` only reaches modules vitest transforms.
        // components-react is what constructs the Room, so it has to go
        // through the transform, not Node's own loader.
        inline: ['@livekit/components-react'],
      },
    },
  },
});
