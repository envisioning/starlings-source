/**
 * The frontmatter every `docs/**\/*.md` carries (docs/DOCUMENTATION.md,
 * decision 2;), read by `check-docs.mjs` and `gen-doc-map.mjs`.
 *
 * The YAML subset is deliberate: `key: value`, `key: "quoted value"`, and
 * `key: [a, b]`. Nothing nested, so no YAML dependency.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export * from './docs-frontmatter-parse.mjs';
import { readFrontmatter, validateFields } from './docs-frontmatter-parse.mjs';

/** Every markdown file under `docs/`, repo-relative, sorted. */
export function listDocs(repoRoot) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.md')) out.push(relative(repoRoot, path));
    }
  };
  walk(join(repoRoot, 'docs'));
  return out.sort();
}

/** Every doc with its parsed frontmatter. Files that fail to parse carry `errors`. */
export function readAllDocs(repoRoot) {
  return listDocs(repoRoot).map((path) => {
    const { fields, errors } = readFrontmatter(readFileSync(join(repoRoot, path), 'utf8'));
    return { path, fields, errors: fields ? [...errors, ...validateFields(fields)] : errors };
  });
}
