// Reading a local markdown tree the way Obsidian leaves it on disk, and
// mapping it onto Docs paths.
//
// The mapping has to be deterministic and reversible enough that running an
// import twice updates the same documents instead of making a second copy.
// `Clients/Greiner/Kick-off notes.md` → `/vault/clients/greiner/kick-off-notes`.

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYAML } from 'yaml';

export interface VaultFile {
  absolutePath: string;
  /** Path relative to the vault root, POSIX-separated. */
  relativePath: string;
  docPath: string;
  title: string;
  body: string;
  frontmatter: Record<string, unknown>;
  tags: string[];
  hash: string;
}

const SKIP_DIRECTORIES = new Set(['.obsidian', '.git', '.trash', 'node_modules', '.DS_Store', '.smart-env']);

export function slugify(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .replace(/['’]/gu, '')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 120)
    .replace(/-+$/u, '');
  return slug || 'untitled';
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Depth-first walk yielding every `.md` file, skipping Obsidian plumbing. */
export async function* walk(root: string): AsyncGenerator<string> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP_DIRECTORIES.has(entry.name)) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      yield full;
    }
  }
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;

export function parseFrontmatter(source: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = FRONTMATTER_RE.exec(source);
  if (!match) return { frontmatter: {}, body: source };
  try {
    const parsed: unknown = parseYAML(match[1] ?? '');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { frontmatter: parsed as Record<string, unknown>, body: source.slice(match[0].length) };
    }
  } catch {
    /* malformed frontmatter stays in the body rather than being dropped */
  }
  return { frontmatter: {}, body: source };
}

export async function readVaultFile(absolutePath: string, root: string, prefix: string): Promise<VaultFile> {
  const source = await readFile(absolutePath, 'utf8');
  const { frontmatter, body } = parseFrontmatter(source);
  const relativePath = path.relative(root, absolutePath).split(path.sep).join('/');

  const segments = relativePath.replace(/\.md$/u, '').split('/').map(slugify);
  const docPath = `${prefix.replace(/\/$/u, '')}/${segments.join('/')}`;

  const basename = path.basename(absolutePath, '.md');
  const declared = typeof frontmatter.title === 'string' ? frontmatter.title.trim() : '';
  const heading = /^#\s+(.+)$/mu.exec(body)?.[1]?.trim();
  const title = (declared || heading || basename).slice(0, 500);

  const tags = new Set<string>();
  const declaredTags = frontmatter.tags ?? frontmatter.tag;
  if (typeof declaredTags === 'string') {
    for (const value of declaredTags.split(/[,\s]+/u)) if (value) tags.add(value.replace(/^#/u, '').toLowerCase());
  } else if (Array.isArray(declaredTags)) {
    for (const value of declaredTags) if (typeof value === 'string') tags.add(value.replace(/^#/u, '').toLowerCase());
  }

  return {
    absolutePath,
    relativePath,
    docPath,
    title,
    // The whole file, frontmatter included: Docs stores the source verbatim so
    // a pull writes back byte-identical text.
    body: source,
    frontmatter,
    tags: [...tags].slice(0, 64),
    hash: sha256(source),
  };
}

export async function collect(root: string, prefix: string): Promise<VaultFile[]> {
  const info = await stat(root);
  if (!info.isDirectory()) throw new Error(`${root} is not a directory.`);

  const files: VaultFile[] = [];
  const seen = new Map<string, string>();

  for await (const absolutePath of walk(root)) {
    const file = await readVaultFile(absolutePath, root, prefix);
    // Two differently-named files can slugify to the same path; keep both by
    // suffixing the loser deterministically rather than silently dropping it.
    const previous = seen.get(file.docPath);
    if (previous) {
      const suffix = sha256(file.relativePath).slice(0, 6);
      file.docPath = `${file.docPath}-${suffix}`;
    }
    seen.set(file.docPath, file.relativePath);
    files.push(file);
  }

  return files.sort((left, right) => left.docPath.localeCompare(right.docPath));
}

/** Docs path → local file path, used by `pull`. */
export function localPathFor(root: string, prefix: string, docPath: string): string {
  const relative = docPath.startsWith(prefix) ? docPath.slice(prefix.length) : docPath;
  return path.join(root, `${relative.replace(/^\//u, '')}.md`);
}
