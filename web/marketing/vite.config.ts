import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { meetChangelogPlugin, meetHelpPlugin, meetStandardPlugin, meetVersionPlugin } from '../vite.config';
import { PRODUCT_SITE_ORIGIN } from '@starlings/contracts/deployment';
import { fieldNotesPlugin } from './field-notes';
const root = path.dirname(fileURLToPath(import.meta.url));
/** Public bundles may share presentation code, never workspace sessions, media or API clients. */
function publicBoundary(): Plugin {
  return { name: 'public-workspace-boundary', moduleParsed(info) {
    if (/\/web\/src\/(?:owner-session|api|config|navigation|SearchPaletteHost|SiteChrome|App|GuestSession|HostSession)\.[jt]sx?$/.test(info.id)
        || /\/node_modules\/(?:\.pnpm\/)?(?:livekit|@livekit|@mediapipe)/.test(info.id)) {
      this.error(`Workspace module reached the marketing bundle: ${info.id}`);
    }
  }};
}
export default defineConfig({ root, publicDir: false,
  resolve: { alias: { '@shared': path.resolve(root, '../src'), '@': path.resolve(root, '../src') } },
  plugins: [react(), tailwindcss(), meetVersionPlugin(), meetChangelogPlugin(), meetHelpPlugin(PRODUCT_SITE_ORIGIN), meetStandardPlugin(), fieldNotesPlugin(), publicBoundary()],
  build: { outDir: 'dist', emptyOutDir: true, rollupOptions: { input: { pages: path.join(root, 'pages.html'), hero: path.join(root, 'hero.html') } } },
});
