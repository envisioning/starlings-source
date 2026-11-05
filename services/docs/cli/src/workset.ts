// A safe local editing set for native Docs notes. Unlike the Obsidian mirror,
// a workset contains clean Markdown bodies and never round-trips metadata.
import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { DocsAPIError, type DocsClient } from './client';
import { sha256 } from './vault';

const STATE_FILE = '.docs-workset.json';
const BASELINE_DIR = '.docs-workset/baseline';
const PAGE_SIZE = 200;

interface WorksetDocument {
  id: string;
  path: string;
  title: string;
  base_hash: string;
  base_version: number;
}

interface WorksetState {
  format: 'docsctl-workset';
  version: 1;
  prefix: string;
  documents: WorksetDocument[];
}

type Flags = Record<string, string | boolean | undefined>;

interface WorksetRow {
  document: WorksetDocument;
  localBody: string | null;
  localHash: string | null;
  remote: Record<string, any> | null;
  error?: string;
}

export async function runWorkset(api: DocsClient, action: string | undefined, flags: Flags): Promise<number> {
  switch (action) {
    case 'pull':
      return pullWorkset(api, flags);
    case 'status':
      return statusWorkset(api, flags);
    case 'push':
      return pushWorkset(api, flags);
    case 'audit':
      return auditWorkset(api, flags);
    default:
      process.stderr.write('Use `docsctl workset pull|status|push|audit`.\n');
      return 2;
  }
}

async function pullWorkset(api: DocsClient, flags: Flags): Promise<number> {
  const prefix = String(flags.prefix ?? '');
  if (!prefix || !prefix.startsWith('/') || prefix.endsWith('/') || prefix.includes('..')) {
    process.stderr.write('Pass a Docs path prefix such as --prefix /strategy.\n');
    return 2;
  }
  const root = await requireRoot(flags);
  const statePath = path.join(root, STATE_FILE);
  const previous = await readState(statePath, root);
  if (previous && previous.prefix !== prefix) {
    throw new Error(`This workset is for ${previous.prefix}; use a separate directory for ${prefix}.`);
  }

  const summaries = await listAllNativeMarkdown(api, prefix);
  const details = await mapLimit(summaries, 8, async (summary) => api.get(summary.id));
  const candidates = details.filter((doc) =>
    doc.source_system === 'native' && doc.kind === 'markdown' && doc.editable === true &&
    doc.private !== true && doc.source_kind !== 'link' && typeof doc.body_md === 'string',
  );
  const tracked = new Map((previous?.documents ?? []).map((doc) => [doc.id, doc]));
  const plan: Array<{ detail: Record<string, any>; prior?: WorksetDocument; localPath: string; baselinePath: string; current: string | null }> = [];
  const protectedPaths: string[] = [];

  // Check every target before writing any of them. A first export must never
  // silently replace an unrelated file someone already had in the directory.
  for (const detail of candidates) {
    const prior = tracked.get(detail.id);
    if (prior && prior.path !== detail.path) {
      protectedPaths.push(`${prior.path} (now ${detail.path}; path move needs manual handling)`);
      continue;
    }
    const localPath = documentFile(root, detail.path);
    const baselinePath = baselineFile(root, detail.path);
    const current = await readRegularFile(localPath, root);
    if (!prior && current !== null && sha256(current) !== detail.content_hash) {
      protectedPaths.push(`${detail.path} (untracked local file already exists)`);
      continue;
    }
    plan.push({ detail, ...(prior ? { prior } : {}), localPath, baselinePath, current });
  }
  if (protectedPaths.length) {
    process.stderr.write('Pull stopped before writing because these paths need attention:\n');
    for (const item of protectedPaths) process.stderr.write(`  ${item}\n`);
    return 1;
  }

  const next = new Map((previous?.documents ?? []).map((doc) => [doc.id, doc]));
  let added = 0;
  let refreshed = 0;
  let localEditsKept = 0;

  for (const item of plan) {
    const detail = item.detail;
    const body = String(detail.body_md);
    const prior = item.prior;
    if (prior && item.current !== null && sha256(item.current) !== prior.base_hash) {
      // Keep the user's uncommitted work and its original hash. `push` will
      // report a conflict if the remote changed while that work was in flight.
      localEditsKept += 1;
      continue;
    }

    await writeText(item.baselinePath, body, root);
    await writeText(item.localPath, body, root);
    const updated: WorksetDocument = {
      id: String(detail.id),
      path: String(detail.path),
      title: String(detail.title),
      base_hash: String(detail.content_hash),
      base_version: Number(detail.version),
    };
    next.set(updated.id, updated);
    if (prior) refreshed += 1;
    else added += 1;
    await saveState(statePath, { format: 'docsctl-workset', version: 1, prefix, documents: sorted(next.values()) }, root);
  }

  // Preserve prior entries that are now archived, out of scope, or no longer
  // visible. A pull never deletes local work or silently shrinks the set.
  await saveState(statePath, { format: 'docsctl-workset', version: 1, prefix, documents: sorted(next.values()) }, root);
  const result = { prefix, added, refreshed, local_edits_kept: localEditsKept, documents: next.size };
  if (flags.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stderr.write(`Workset ${prefix}: ${added} added, ${refreshed} refreshed, ${localEditsKept} local edits kept (${next.size} tracked).\n`);
  return 0;
}

async function statusWorkset(api: DocsClient, flags: Flags): Promise<number> {
  const { root, state } = await openWorkset(flags);
  const rows = await inspectRows(api, root, state);
  const counts = countStates(rows);
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ prefix: state.prefix, ...counts, documents: rows.map(publicRow) }, null, 2)}\n`);
    return counts.conflicts || counts.local_changed || counts.remote_changed || counts.local_missing || counts.remote_missing ? 1 : 0;
  }
  for (const row of rows) {
    const stateName = rowState(row);
    if (stateName !== 'clean') process.stdout.write(`${stateName.padEnd(16)} ${row.document.path}\n`);
  }
  process.stderr.write(`${counts.clean} clean, ${counts.local_changed} local edits, ${counts.remote_changed} remote edits, ${counts.conflicts} conflicts, ${counts.local_missing} local missing, ${counts.remote_missing} remote missing.\n`);
  return counts.conflicts || counts.local_changed || counts.remote_changed || counts.local_missing || counts.remote_missing ? 1 : 0;
}

async function pushWorkset(api: DocsClient, flags: Flags): Promise<number> {
  const { root, state } = await openWorkset(flags);
  const rows = await inspectRows(api, root, state);
  const dirty = rows.filter((row) => row.localHash !== null && row.localHash !== row.document.base_hash);
  const cleanRemote = dirty.filter((row) => remoteIsEditableAndUnchanged(row));
  const blocked = dirty.filter((row) => !remoteIsEditableAndUnchanged(row));
  const missingLocal = rows.filter((row) => row.localHash === null);

  if (!flags.apply || flags['dry-run']) {
    if (!flags.json) {
      for (const row of cleanRemote) {
        const baseline = await readRegularFile(baselineFile(root, row.document.path), root);
        if (baseline === null || row.localBody === null) continue;
        process.stdout.write(unifiedDiff(baseline, row.localBody, row.document.path));
      }
    }
    for (const row of blocked) process.stderr.write(`CONFLICT ${row.document.path}${row.error ? ` (${row.error})` : ' (remote changed, moved, or is no longer editable)'}\n`);
    for (const row of missingLocal) process.stderr.write(`MISSING ${row.document.path} (restore the local file; workset push does not delete documents)\n`);
    if (!cleanRemote.length && !blocked.length && !missingLocal.length) process.stderr.write('No local edits to apply.\n');
    else process.stderr.write(`${cleanRemote.length} ready to apply, ${blocked.length} blocked, ${missingLocal.length} local files missing. Preview only; add --apply to write.\n`);
    if (flags.json) {
      process.stdout.write(`${JSON.stringify({
        prefix: state.prefix,
        ready: cleanRemote.map(publicRow),
        blocked: blocked.map(publicRow),
        local_missing: missingLocal.map(publicRow),
      }, null, 2)}\n`);
    }
    return blocked.length || missingLocal.length ? 1 : 0;
  }

  let written = 0;
  const conflicts: string[] = [];
  const next = new Map(state.documents.map((doc) => [doc.id, doc]));
  for (const row of blocked) {
    process.stderr.write(`blocked ${row.document.path}${row.error ? ` (${row.error})` : ' — remote changed, moved, or is no longer editable.'}\n`);
  }
  for (const row of cleanRemote) {
    if (row.localBody === null || !row.remote) continue;
    try {
      const updated = await api.update(row.document.id, {
        body_md: row.localBody,
        if_content_hash: row.document.base_hash,
        message: String(flags.message ?? 'docsctl workset push'),
      });
      const hash = typeof updated.content_hash === 'string' ? updated.content_hash : sha256(row.localBody);
      const record: WorksetDocument = {
        ...row.document,
        title: String(updated.title ?? row.document.title),
        base_hash: hash,
        base_version: Number(updated.version ?? row.document.base_version + 1),
      };
      await writeText(baselineFile(root, record.path), row.localBody, root);
      next.set(record.id, record);
      await saveState(path.join(root, STATE_FILE), { ...state, documents: sorted(next.values()) }, root);
      written += 1;
      process.stderr.write(`wrote ${record.path} v${record.base_version}\n`);
    } catch (error) {
      if (error instanceof DocsAPIError && (error.status === 409 || error.code === 'hash_mismatch')) {
        conflicts.push(row.document.path);
        process.stderr.write(`conflict ${row.document.path} — remote changed; merge against the latest version.\n`);
        continue;
      }
      throw error;
    }
  }

  for (const row of missingLocal) process.stderr.write(`missing ${row.document.path} — restore the local file; workset push does not delete documents.\n`);
  const result = { written, conflicts, blocked: blocked.length + missingLocal.length };
  if (flags.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stderr.write(`Done. ${written} written, ${conflicts.length + blocked.length + missingLocal.length} blocked.\n`);
  return conflicts.length || blocked.length || missingLocal.length ? 1 : 0;
}

async function auditWorkset(api: DocsClient, flags: Flags): Promise<number> {
  const { root, state } = await openWorkset(flags);
  const details = await mapLimit(state.documents, 8, async (doc) => {
    try {
      return await api.get(doc.id);
    } catch (error) {
      if (error instanceof DocsAPIError && error.status === 404) return null;
      throw error;
    }
  });
  const active = details.filter((doc): doc is Record<string, any> => doc !== null);
  const unresolved = active.flatMap((doc) => (doc.links ?? [])
    .filter((link: Record<string, unknown>) => !link.to_id)
    .map((link: Record<string, unknown>) => ({ path: doc.path, target: link.target })));
  const isolated = active.filter((doc) =>
    !(doc.links ?? []).some((link: Record<string, unknown>) => Boolean(link.to_id)) && !(doc.backlinks?.length),
  ).map((doc) => doc.path);
  const mostLinked = active
    .map((doc) => ({ path: String(doc.path), incoming: (doc.backlinks ?? []).length }))
    .filter((doc) => doc.incoming > 0)
    .sort((a, b) => b.incoming - a.incoming || a.path.localeCompare(b.path))
    .slice(0, 10);
  const result = {
    prefix: state.prefix,
    documents: active.length,
    resolved_links: active.reduce((count, doc) => count + (doc.links ?? []).filter((link: Record<string, unknown>) => Boolean(link.to_id)).length, 0),
    unresolved_links: unresolved,
    isolated_documents: isolated,
    most_linked: mostLinked,
  };
  if (flags.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    process.stdout.write(`Graph audit for ${state.prefix}: ${result.documents} documents, ${result.resolved_links} resolved links, ${unresolved.length} unresolved links, ${isolated.length} isolated documents.\n`);
    for (const link of unresolved) process.stdout.write(`unresolved ${link.path} → ${String(link.target)}\n`);
    for (const docPath of isolated) process.stdout.write(`isolated   ${docPath}\n`);
    for (const doc of mostLinked) process.stdout.write(`inbound ${String(doc.incoming).padStart(3)} ${doc.path}\n`);
  }
  return unresolved.length || isolated.length ? 1 : 0;
}

async function inspectRows(api: DocsClient, root: string, state: WorksetState): Promise<WorksetRow[]> {
  return mapLimit(state.documents, 8, async (document) => {
    const localBody = await readRegularFile(documentFile(root, document.path), root);
    let remote: Record<string, any> | null = null;
    let error: string | undefined;
    try {
      remote = await api.get(document.id);
    } catch (cause) {
      if (cause instanceof DocsAPIError && cause.status === 404) error = 'remote document unavailable';
      else throw cause;
    }
    return { document, localBody, localHash: localBody === null ? null : sha256(localBody), remote, ...(error ? { error } : {}) };
  });
}

async function listAllNativeMarkdown(api: DocsClient, prefix: string): Promise<Array<Record<string, any>>> {
  const documents: Array<Record<string, any>> = [];
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;
  while (offset < total) {
    const page = await api.list({ prefix, source: 'native', kind: 'markdown', limit: String(PAGE_SIZE), offset: String(offset) });
    documents.push(...page.documents);
    total = page.total;
    if (page.documents.length === 0) break;
    offset += page.documents.length;
  }
  return documents;
}

function rowState(row: WorksetRow): string {
  if (row.error || !row.remote) return 'remote-missing';
  if (row.localHash === null) return 'local-missing';
  const localChanged = row.localHash !== row.document.base_hash;
  const remoteChanged = row.remote.content_hash !== row.document.base_hash || !remoteIsEditableAndUnchanged(row);
  if (localChanged && remoteChanged) return 'conflict';
  if (localChanged) return 'local-changed';
  if (remoteChanged) return 'remote-changed';
  return 'clean';
}

function remoteIsEditableAndUnchanged(row: WorksetRow): boolean {
  const remote = row.remote;
  if (!remote) return false;
  return (
    remote.path === row.document.path &&
    remote.content_hash === row.document.base_hash &&
    remote.source_system === 'native' && remote.kind === 'markdown' &&
    remote.editable === true && remote.private !== true && remote.source_kind !== 'link'
  );
}

function countStates(rows: WorksetRow[]): Record<string, number> {
  const counts: Record<string, number> = { clean: 0, local_changed: 0, remote_changed: 0, conflicts: 0, local_missing: 0, remote_missing: 0 };
  for (const row of rows) {
    const state = rowState(row);
    const key = state === 'local-changed' ? 'local_changed'
      : state === 'remote-changed' ? 'remote_changed'
        : state === 'conflict' ? 'conflicts'
          : state === 'local-missing' ? 'local_missing'
            : state === 'remote-missing' ? 'remote_missing' : 'clean';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function publicRow(row: WorksetRow): Record<string, unknown> {
  return {
    path: row.document.path,
    state: rowState(row),
    base_version: row.document.base_version,
    local_hash: row.localHash,
    remote_hash: row.remote?.content_hash ?? null,
    ...(row.error ? { error: row.error } : {}),
  };
}

async function openWorkset(flags: Flags): Promise<{ root: string; state: WorksetState }> {
  const root = await requireRoot(flags, false);
  const state = await readState(path.join(root, STATE_FILE), root);
  if (!state) throw new Error(`No ${STATE_FILE} in ${root}; run docsctl workset pull first.`);
  return { root, state };
}

async function requireRoot(flags: Flags, create = true): Promise<string> {
  const raw = String(flags.dir ?? '');
  if (!raw) throw new Error('Pass --dir <workset-directory>.');
  const expanded = raw.startsWith('~') ? path.join(process.env.HOME ?? '', raw.slice(1)) : path.resolve(raw);
  if (create) await mkdir(expanded, { recursive: true });
  return realpath(expanded);
}

async function readState(file: string, root: string): Promise<WorksetState | null> {
  const raw = await readRegularFile(file, root) ?? '';
  if (!raw) return null;
  const state = JSON.parse(raw) as Partial<WorksetState>;
  if (state.format !== 'docsctl-workset' || state.version !== 1 || !state.prefix || !Array.isArray(state.documents)) {
    throw new Error(`${file} is not a supported docsctl workset.`);
  }
  return state as WorksetState;
}

async function saveState(file: string, state: WorksetState, root: string): Promise<void> {
  await writeText(file, `${JSON.stringify({ ...state, documents: sorted(state.documents) }, null, 2)}\n`, root);
}

async function readRegularFile(file: string, root: string): Promise<string | null> {
  try {
    await assertSafeParents(root, path.dirname(file));
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Refusing to read a non-regular workset file: ${file}`);
    return await readFile(file, 'utf8');
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function assertSafeParents(root: string, target: string): Promise<void> {
  const relative = path.relative(root, target);
  if (isOutside(relative)) throw new Error(`Refusing to read outside the workset: ${target}`);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Refusing to follow a non-directory workset path: ${current}`);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return;
      throw error;
    }
  }
}

async function writeText(file: string, contents: string, root: string): Promise<void> {
  const relative = path.relative(root, file);
  if (!relative || isOutside(relative)) {
    throw new Error(`Refusing to write outside the workset: ${file}`);
  }
  const parent = path.dirname(file);
  await ensureSafeDirectory(root, parent);
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, contents, { encoding: 'utf8', flag: 'wx' });
  await rename(temp, file);
}

async function ensureSafeDirectory(root: string, target: string): Promise<void> {
  const relative = path.relative(root, target);
  if (isOutside(relative)) {
    throw new Error(`Refusing to create a directory outside the workset: ${target}`);
  }
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Refusing to follow a non-directory workset path: ${current}`);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
        await mkdir(current);
      } else {
        throw error;
      }
    }
  }
}

function isOutside(relative: string): boolean {
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function documentFile(root: string, docPath: string): string {
  const segments = docPath.split('/').filter(Boolean);
  if (!docPath.startsWith('/') || !segments.length || segments.some((part) => part === '.' || part === '..' || part.includes(path.sep))) {
    throw new Error(`Unsafe Docs path in workset: ${docPath}`);
  }
  return path.resolve(root, ...segments) + '.md';
}

function baselineFile(root: string, docPath: string): string {
  const relative = path.relative(root, documentFile(root, docPath));
  return path.join(root, BASELINE_DIR, relative);
}

function sorted(documents: Iterable<WorksetDocument>): WorksetDocument[] {
  return [...documents].sort((a, b) => a.path.localeCompare(b.path));
}

async function mapLimit<T, U>(items: T[], limit: number, task: (item: T) => Promise<U>): Promise<U[]> {
  const output = new Array<U>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      const item = items[index];
      if (item !== undefined) output[index] = await task(item);
    }
  }));
  return output;
}

function unifiedDiff(before: string, after: string, name: string): string {
  const oldLines = lines(before);
  const newLines = lines(after);
  const width = newLines.length + 1;
  if (oldLines.length * newLines.length > 1_000_000) {
    return `--- a${name}\n+++ b${name}\n(diff omitted: ${oldLines.length} lines → ${newLines.length} lines)\n`;
  }
  const table = new Uint32Array((oldLines.length + 1) * width);
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = oldLines[i] === newLines[j]
        ? 1 + table[(i + 1) * width + j + 1]!
        : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  const operations: Array<{ kind: ' ' | '+' | '-'; line: string }> = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      operations.push({ kind: ' ', line: oldLines[i]! }); i += 1; j += 1;
    } else if (j < newLines.length && (i === oldLines.length || table[i * width + j + 1]! >= table[(i + 1) * width + j]!)) {
      operations.push({ kind: '+', line: newLines[j]! }); j += 1;
    } else {
      operations.push({ kind: '-', line: oldLines[i]! }); i += 1;
    }
  }
  const changed = operations.flatMap((op, index) => op.kind === ' ' ? [] : [index]);
  if (!changed.length) return '';
  const ranges: Array<[number, number]> = [];
  for (const index of changed) {
    const start = Math.max(0, index - 3);
    const end = Math.min(operations.length, index + 4);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1]) last[1] = end;
    else ranges.push([start, end]);
  }
  let output = `--- a${name}\n+++ b${name}\n`;
  for (const [start, end] of ranges) {
    const beforeStart = operations.slice(0, start).filter((op) => op.kind !== '+').length;
    const afterStart = operations.slice(0, start).filter((op) => op.kind !== '-').length;
    const chunk = operations.slice(start, end);
    const beforeCount = chunk.filter((op) => op.kind !== '+').length;
    const afterCount = chunk.filter((op) => op.kind !== '-').length;
    const oldStart = beforeCount ? beforeStart + 1 : beforeStart;
    const newStart = afterCount ? afterStart + 1 : afterStart;
    output += `@@ -${oldStart},${beforeCount} +${newStart},${afterCount} @@\n`;
    output += chunk.map((op) => `${op.kind}${op.line}\n`).join('');
  }
  return output;
}

function lines(text: string): string[] {
  const normalized = text.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n');
  if (!normalized) return [];
  return (normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized).split('\n');
}
