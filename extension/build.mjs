import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('.', import.meta.url));
const dist = fileURLToPath(new URL('./dist/', import.meta.url));
await rm(dist, { recursive: true, force: true });
await mkdir(`${dist}/src`, { recursive: true });
for (const path of ['manifest.json', '_locales', 'src/options.html', 'src/options.js', 'src/background.js', 'src/batching.js']) {
  await cp(`${root}/${path}`, `${dist}/${path}`, { recursive: true });
}
// Manifest content scripts are classic scripts, unlike the module Worker.
await build({
  entryPoints: [`${root}/src/content.js`], outfile: `${dist}/src/content.js`,
  bundle: true, format: 'iife', platform: 'browser', target: 'chrome120',
});
console.log('Extension built in extension/dist (Load unpacked).');
