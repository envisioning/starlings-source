// The guest's first load, measured: the entry script plus every module the
// built index.html preloads, gzipped. A guest opening an invite pays this
// before the meeting chunk, so it has a ceiling. Raise the number
// here on purpose, in the same change that explains why.
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { resolve } from 'node:path';

// 160 KB: Zod and the contracts index stay off the guest entry path. The
// shadcn component packages (Radix and others) are kept off it by the build
// itself: see GUEST_ENTRY_FORBIDDEN in web/vite.config.ts.
const BUDGET_GZIP_BYTES = 160 * 1024;
const dist = resolve(process.cwd(), 'web/dist');
const html = readFileSync(resolve(dist, 'index.html'), 'utf8');
const files = [
  ...html.matchAll(/<script[^>]*src="\/(assets\/[^"]+\.js)"/gu),
  ...html.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="\/(assets\/[^"]+\.js)"/gu),
].map((match) => match[1]);

let total = 0;
for (const file of new Set(files)) {
  const source = readFileSync(resolve(dist, file));
  if (source.includes('_zod')) {
    console.error(`${file} contains the Zod runtime marker _zod`);
    process.exit(1);
  }
  const size = gzipSync(source).length;
  total += size;
  console.log(`${String(size).padStart(8)} gz  ${file}`);
}
console.log(`${String(total).padStart(8)} gz  entry + preloads (budget ${BUDGET_GZIP_BYTES})`);
if (total > BUDGET_GZIP_BYTES) {
  console.error(`web entry path is ${total - BUDGET_GZIP_BYTES} bytes gzip over budget`);
  process.exit(1);
}
