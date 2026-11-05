// `docsctl drift` — which curated documents no longer match what they were
// copied from.
//
// A curated document is a copy. `/method` came from a vault folder,
// `/policies` from two files in the meet repo, the promoted `/strategy`
// briefs from single vault files. Each records where it came from in
// `frontmatter.source`, and until now nothing ever looked again. That is the
// same shape as the note adoption that ran once in February and was still
// reporting success in September: a copy made once, declared done, with no
// mechanism that could ever say otherwise.
//
// This is the mechanism. It runs here rather than in the Worker because the
// sources are on this machine — a Cloudflare Worker cannot read `~/Vaults` or
// a git checkout, and pretending otherwise would mean pushing the vault
// somewhere just to check it against itself.
//
// Three answers per document: `same`, `drifted`, `missing`. Nothing is
// written; deciding which side is right is a person's job, because a drifted
// document may well be the better text now.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { DocsClient } from './client';

/** `vault:Research-Methodology/01-Strategic-Foresight.md` → a file under the vault root. */
const VAULT = /^vault:(.+)$/u;
/** `repo:envisioning/meet:docs/PRIVACY.md` → a file under a local checkout. */
const REPO = /^repo:([^:]+):(.+)$/u;

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u;

export type Verdict = 'same' | 'drifted' | 'missing';

export interface DriftRow {
  docPath: string;
  source: string;
  file: string | null;
  verdict: Verdict;
  detail?: string;
}

export interface DriftOptions {
  /** Where `vault:` sources resolve — the Obsidian vault root. */
  vaultRoot?: string;
  /** Where `repo:<owner>/<name>:` sources resolve, by repository name. */
  repoRoots?: Record<string, string>;
  /** Only look under this Docs prefix. */
  prefix?: string;
}

/**
 * Compare bodies, not bytes on disk. A staged vault file carries a
 * frontmatter block that the curated document deliberately does not — the
 * block became metadata on the row. Comparing raw files would report every
 * curated document as drifted on the first run, which is the fastest way to
 * make a check nobody reads.
 */
export function normalize(markdown: string): string {
  return markdown.replace(FRONTMATTER, '').replace(/\r\n/gu, '\n').trim();
}

export function digest(markdown: string): string {
  return createHash('sha256').update(normalize(markdown), 'utf8').digest('hex');
}

/**
 * Not every `source` names one file. Several documents were synthesized from
 * a handful of notes and say so in prose — "…envisioning-sales.md +
 * sales-process.md + crm-workflows.md (merged 2026-09-22)". Treating that
 * sentence as a filename reports a missing file, which is a lie about a
 * document that is fine. A provenance note is not a pointer, and the honest
 * answer for one is that it cannot be checked.
 */
function isOneFile(reference: string): boolean {
  return /\.md$/u.test(reference.trim()) && !/[;+]|\s\(/u.test(reference);
}

/** Where a `source` value points on this machine, or null if it is not a file. */
export function resolveSource(source: string, options: DriftOptions): string | null {
  const vault = VAULT.exec(source);
  if (vault?.[1]) {
    if (!options.vaultRoot || !isOneFile(vault[1])) return null;
    return path.join(options.vaultRoot, vault[1].trim());
  }

  const repo = REPO.exec(source);
  if (repo?.[1] && repo[2]) {
    const root = options.repoRoots?.[repo[1]] ?? options.repoRoots?.[repo[1].split('/').at(-1)!];
    if (!root || !isOneFile(repo[2])) return null;
    return path.join(root, repo[2].trim());
  }

  return null;
}

export async function collectDrift(api: DocsClient, options: DriftOptions): Promise<DriftRow[]> {
  const rows: DriftRow[] = [];
  const limit = 200;

  for (let offset = 0; ; offset += limit) {
    const page = await api.list({
      limit: String(limit),
      offset: String(offset),
      has_source: '',
      ...(options.prefix ? { prefix: options.prefix } : {}),
    });
    if (!page.documents.length) break;

    for (const summary of page.documents) {
      const source = sourceOf(summary);
      if (!source) continue;

      const file = resolveSource(source, options);
      if (!file) {
        // Not addressable from here — a source that names a system rather
        // than a file, or a root this invocation was not told about.
        continue;
      }

      let contents: string;
      try {
        contents = await readFile(file, 'utf8');
      } catch {
        rows.push({ docPath: summary.path, source, file, verdict: 'missing', detail: 'source file is gone' });
        continue;
      }

      // The summary carries the source but not the body; fetch only the
      // documents that are actually candidates for comparison.
      const detail = await api.get(summary.id);
      const same = digest(String(detail.body_md ?? '')) === digest(contents);
      rows.push({ docPath: summary.path, source, file, verdict: same ? 'same' : 'drifted' });
    }

    if (page.documents.length < limit) break;
  }

  return rows.sort((left, right) => left.docPath.localeCompare(right.docPath));
}

function sourceOf(summary: Record<string, any>): string | null {
  // On the summary itself — a list of a thousand documents should not mean a
  // thousand round trips to read one frontmatter key.
  const value = summary.source ?? summary.frontmatter?.source;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
