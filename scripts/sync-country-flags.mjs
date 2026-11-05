import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'web', 'node_modules', 'flag-icons', 'flags', '4x3');
// Keep native flags as ordinary PNG resources. The generated Xcode project has
// a custom icon catalog, so an additional .xcassets folder is not compiled into
// the app reliably. A small 1x PNG is enough for the 18x12 native treatment
// and keeps Bundle lookup deterministic on both macOS and iOS.
const destination = path.join(root, 'Resources', 'Flags');
const webDestination = path.join(root, 'web', 'public', 'flags');
const requireFromWeb = createRequire(path.join(root, 'web', 'package.json'));
const sharp = requireFromWeb('sharp');

const flagFiles = (await readdir(source))
  .filter((file) => /^[a-z]{2}\.svg$/u.test(file))
  .sort();

await mkdir(destination, { recursive: true });
await mkdir(webDestination, { recursive: true });

for (const existing of await readdir(destination)) {
  if (/^[a-z]{2}\.png$/u.test(existing)) {
    await rm(path.join(destination, existing), { force: true });
  }
}

for (const file of flagFiles) {
  const code = path.basename(file, '.svg');
  await sharp(path.join(source, file))
    .resize({ width: 36 })
    .png()
    .toFile(path.join(destination, `${code}.png`));
  await cp(path.join(source, file), path.join(webDestination, file));
}

console.log(`Synced ${flagFiles.length} country flags into ${path.relative(root, destination)} and ${path.relative(root, webDestination)}.`);
