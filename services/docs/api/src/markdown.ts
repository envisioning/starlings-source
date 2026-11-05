// Markdown handling: frontmatter, wikilinks, tags, excerpts.
//
// Everything here has to round-trip an Obsidian vault without losing anything.
// A note that goes in and comes back out must be byte-identical unless someone
// actually edited it — otherwise the first `docsctl pull` after an import
// rewrites 7,000 files and the diff is useless.

import { parse as parseYAML, stringify as stringifyYAML } from 'yaml';

export interface ParsedMarkdown {
  frontmatter: Record<string, unknown>;
  body: string;
  /** Whether the source actually carried a frontmatter block. */
  hadFrontmatter: boolean;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;

export function parseMarkdown(source: string): ParsedMarkdown {
  const match = FRONTMATTER_RE.exec(source);
  if (!match) return { frontmatter: {}, body: source, hadFrontmatter: false };
  let frontmatter: Record<string, unknown> = {};
  try {
    const parsed: unknown = parseYAML(match[1] ?? '');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      frontmatter = parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed frontmatter stays part of the body rather than being dropped.
    return { frontmatter: {}, body: source, hadFrontmatter: false };
  }
  return { frontmatter, body: source.slice(match[0].length), hadFrontmatter: true };
}

export function serializeMarkdown(frontmatter: Record<string, unknown>, body: string): string {
  if (!frontmatter || Object.keys(frontmatter).length === 0) return body;
  const yaml = stringifyYAML(frontmatter).trimEnd();
  return `---\n${yaml}\n---\n${body.startsWith('\n') ? body.slice(1) : body}`;
}

/**
 * `[[Target]]`, `[[Target|alias]]`, `[[Target#heading]]`.
 * Skips fenced code blocks and inline code so a snippet showing the syntax
 * does not manufacture graph edges.
 */
export function extractWikilinks(body: string): string[] {
  const stripped = stripCode(body);
  const targets = new Set<string>();
  const pattern = /\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|[^\]]*)?\]\]/gu;
  for (const match of stripped.matchAll(pattern)) {
    const target = match[1]?.trim();
    if (target) targets.add(target);
  }
  return [...targets];
}

/** Inline `#tag` plus whatever the frontmatter declares under `tags`. */
export function extractTags(body: string, frontmatter: Record<string, unknown>): string[] {
  const tags = new Set<string>();

  const declared = frontmatter.tags ?? frontmatter.tag;
  if (typeof declared === 'string') {
    for (const value of declared.split(/[,\s]+/u)) if (value) tags.add(normalizeTag(value));
  } else if (Array.isArray(declared)) {
    for (const value of declared) if (typeof value === 'string' && value) tags.add(normalizeTag(value));
  }

  const stripped = stripCode(body);
  // Require a non-word character before `#` so `C#` and URL fragments do not
  // become tags, and require at least one letter so `#1` does not either.
  for (const match of stripped.matchAll(/(?:^|[\s(>])#([a-z0-9][a-z0-9/_-]*[a-z][a-z0-9/_-]*)/giu)) {
    const value = match[1];
    if (value) tags.add(normalizeTag(value));
  }

  return [...tags].filter(Boolean).slice(0, 64);
}

export function normalizeTag(value: string): string {
  return value.trim().replace(/^#/u, '').toLowerCase().slice(0, 80);
}

/** First real prose line, for list views and search results. */
export function excerpt(body: string, limit = 240): string {
  const text = body
    .replace(/^---[\s\S]*?---/u, '')
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/^#{1,6}\s+.*$/gmu, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/gu, (_all, target: string, alias?: string) => alias ?? target)
    .replace(/[*_`>]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

/** Title from frontmatter, then first H1, then the filename the caller passes. */
export function inferTitle(
  frontmatter: Record<string, unknown>,
  body: string,
  fallback: string,
): string {
  const declared = frontmatter.title;
  if (typeof declared === 'string' && declared.trim()) return declared.trim().slice(0, 500);
  const heading = /^#\s+(.+)$/mu.exec(body);
  if (heading?.[1]?.trim()) return heading[1].trim().slice(0, 500);
  return fallback.slice(0, 500);
}

function stripCode(body: string): string {
  return body.replace(/```[\s\S]*?```/gu, ' ').replace(/`[^`\n]*`/gu, ' ');
}

/**
 * FTS5 MATCH input. User queries arrive as prose, and an unescaped `"` or a
 * bare `AND` turns into a syntax error rather than a search — so every term is
 * quoted, and a trailing partial word gets a prefix wildcard.
 */
export function toMatchQuery(input: string): string {
  const terms = input
    .trim()
    .split(/\s+/u)
    .map((term) => term.replace(/["*]/gu, ''))
    .filter(Boolean)
    .slice(0, 16);
  if (!terms.length) return '';
  return terms.map((term, index) => (index === terms.length - 1 ? `"${term}"*` : `"${term}"`)).join(' AND ');
}
