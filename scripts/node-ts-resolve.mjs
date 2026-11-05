// Node loader hook so `node --import ./scripts/node-ts-resolve.mjs x.ts` can
// run TypeScript that imports siblings without an extension, the way
// `packages/contracts/src/index.ts` does (`./work-items`), and JSON without an
// import attribute (`./upcoming-config.json`). Vite and tsc accept both; plain
// Node does not. Tries `.ts`, then `/index.ts`, then falls through to the
// default resolver.
import { register } from 'node:module';

register(
  'data:text/javascript,' +
    encodeURIComponent(`
      import { existsSync, readFileSync } from 'node:fs';
      import { fileURLToPath, pathToFileURL } from 'node:url';
      export async function resolve(specifier, context, next) {
        if (specifier.startsWith('.') && !/\\.[a-z]+$/i.test(specifier) && context.parentURL?.startsWith('file:')) {
          const base = new URL(specifier, context.parentURL);
          for (const suffix of ['.ts', '/index.ts']) {
            const candidate = fileURLToPath(base) + suffix;
            if (existsSync(candidate)) return next(pathToFileURL(candidate).href, context);
          }
        }
        return next(specifier, context);
      }
      export async function load(url, context, next) {
        if (url.startsWith('file:') && url.endsWith('.json')) {
          return { format: 'json', source: readFileSync(fileURLToPath(url)), shortCircuit: true };
        }
        return next(url, context);
      }
    `),
  import.meta.url,
);
