#!/usr/bin/env node
/**
 * Branch-tracked Swift packages (core-kit, envisioning-ui) against their
 * branch heads. project.yml tracks `main`, but Package.resolved pins one
 * revision, and `-disableAutomaticPackageResolution` builds exactly that pin.
 * A fix pushed to the package therefore reaches Meet only when the pin
 * moves: core-kit's Docs crash fix sat two days unpicked this way.
 *
 *   node scripts/check-package-pins.mjs            # warn when a pin is behind
 *   node scripts/check-package-pins.mjs --update   # move each pin to its head
 *
 * Warns, never fails: moving a pin brings in every commit since, which is a
 * decision, and an offline machine must still build. After --update, run
 * `xcodebuild -resolvePackageDependencies` and the full `pnpm verify`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const resolvedPath = join(repoRoot, 'Starlings.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved');
const update = process.argv.includes('--update');

const text = readFileSync(resolvedPath, 'utf8');
const resolved = JSON.parse(text);
let next = text;
let behind = 0;

for (const pin of resolved.pins ?? []) {
  const { branch, revision } = pin.state ?? {};
  if (!branch || !revision) continue;
  let head;
  try {
    head = execFileSync('git', ['ls-remote', pin.location, `refs/heads/${branch}`], {
      encoding: 'utf8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).split('\t')[0].trim();
  } catch {
    console.warn(`package pins: could not reach ${pin.identity}; not checked`);
    continue;
  }
  if (!/^[0-9a-f]{40}$/u.test(head) || head === revision) continue;
  behind += 1;
  if (update) {
    next = next.replace(`"revision" : "${revision}"`, `"revision" : "${head}"`);
    console.log(`package pins: ${pin.identity} ${revision.slice(0, 7)} -> ${head.slice(0, 7)}`);
  } else {
    console.warn(`package pins: ${pin.identity} is pinned at ${revision.slice(0, 7)}; ${branch} is at ${head.slice(0, 7)}. Its fixes are not in this build. Move the pin: node scripts/check-package-pins.mjs --update`);
  }
}

if (update && next !== text) writeFileSync(resolvedPath, next);
if (!update && behind === 0) console.log('package pins: branch-tracked packages are at their heads');
