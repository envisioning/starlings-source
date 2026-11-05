#!/usr/bin/env node
// docsctl — the command line for docs.org.example.
//
// Designed so an agent can use it without reading documentation: every command
// takes a path, prints either plain text or JSON (`--json`), and exits non-zero
// on failure. Anything that writes says exactly what it wrote.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { client, DocsAPIError, type DocsClient } from './client';
import { collectDrift, type DriftRow } from './drift';
import { loadConfig, saveConfig, configPath, type Config } from './config';
import { collect, localPathFor, sha256 } from './vault';
import { runWorkset } from './workset';

const BATCH = 50;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const flags = parseFlags(argv.slice(1));
  const positional = argv.slice(1).filter((value) => !value.startsWith('-'));
  const config = await loadConfig();

  switch (command) {
    case 'login':
      return login(config);
    case 'whoami':
      return print(await client(config).me(), flags);
    case 'ls':
      return list(client(config), positional[0], flags);
    case 'cat':
      return cat(client(config), required(positional[0], 'path'), flags);
    case 'search':
      return search(client(config), required(positional.join(' '), 'query'), flags);
    case 'new':
      return create(client(config), required(positional[0], 'path'), flags);
    case 'write':
      return write(client(config), required(positional[0], 'path'), flags);
    case 'drift':
      return drift(client(config), config, flags);
    case 'import':
      return importVault(client(config), required(positional[0], 'directory'), flags);
    case 'pull':
      return pull(client(config), config, flags);
    case 'push':
      return pushMirror(client(config), config, flags);
    case 'status':
      return status(client(config), config, flags);
    case 'workset':
      return runWorkset(client(config), positional[0], flags);
    case 'help':
    case undefined:
    case '--help':
    case '-h':
      usage();
      return 0;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n`);
      usage();
      return 2;
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function login(config: Config): Promise<number> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const typed = (await rl.question(`API origin [${config.origin}]: `)).trim();
  // A bare host is what someone means by an origin; https is the only scheme
  // this service answers on.
  const origin = typed ? (/^https?:\/\//u.test(typed) ? typed : `https://${typed}`) : config.origin;
  process.stdout.write(`\nMake a token at ${origin}/tokens, then paste it below.\n`);
  const token = (await rl.question('Token: ')).trim();
  const root = (await rl.question(`Local mirror directory [${config.root ?? '~/Envisioning'}]: `)).trim();
  rl.close();

  if (!token) {
    process.stderr.write('No token entered.\n');
    return 1;
  }
  // An origin that is not a URL is a token pasted one prompt too early. It
  // used to sail through to `Failed to parse URL from evd_…/api/me`, which
  // names neither the cause nor the field.
  if (typed.startsWith('evd_')) {
    process.stderr.write(
      `That is a token, and it went in the origin prompt. Run \`docsctl login\` again, press Enter to accept ${config.origin}, and paste it at "Token:".\n`,
    );
    return 1;
  }
  if (!URL.canParse(origin)) {
    process.stderr.write(`"${typed}" is not an origin.\n`);
    return 1;
  }

  const next: Config = { origin, token, ...(root ? { root: expand(root) } : config.root ? { root: config.root } : {}) };
  const identity = await client(next).me();
  await saveConfig(next);
  process.stdout.write(`\nSaved to ${configPath()}\nSigned in as ${JSON.stringify(identity)}\n`);
  return 0;
}

async function list(api: DocsClient, prefix: string | undefined, flags: Flags): Promise<number> {
  const result = await api.list({
    ...(prefix ? { prefix } : {}),
    limit: String(flags.limit ?? 100),
    ...(flags.source ? { source: String(flags.source) } : {}),
  });
  if (flags.json) return print(result, flags);
  for (const document of result.documents) {
    const mirrored = document.source_system !== 'native' ? ` (${document.source_kind})` : '';
    process.stdout.write(`${document.path}\t${document.title}${mirrored}\n`);
  }
  process.stderr.write(`${result.documents.length} of ${result.total}\n`);
  return 0;
}

async function cat(api: DocsClient, reference: string, flags: Flags): Promise<number> {
  if (flags.json) return print(await api.get(reference), flags);
  process.stdout.write(await api.raw(reference));
  return 0;
}

async function search(api: DocsClient, query: string, flags: Flags): Promise<number> {
  const result = await api.search(query, Number(flags.limit ?? 20));
  if (flags.json) return print(result, flags);
  for (const hit of result.hits) {
    const snippet = String(hit.snippet ?? '').replace(/<\/?mark>/gu, '');
    process.stdout.write(`${hit.path}\n  ${hit.title}\n  ${snippet}\n\n`);
  }
  return 0;
}

async function create(api: DocsClient, docPath: string, flags: Flags): Promise<number> {
  const body = flags.file ? await readFile(String(flags.file), 'utf8') : await readStdin();
  const created = await api.create({
    path: docPath,
    title: String(flags.title ?? path.basename(docPath).replace(/-/gu, ' ')),
    body_md: body,
    ...(flags.message ? { message: String(flags.message) } : {}),
  });
  process.stderr.write(`created ${created.path} v${created.version}\n`);
  return flags.json ? print(created, flags) : 0;
}

async function write(api: DocsClient, docPath: string, flags: Flags): Promise<number> {
  const body = flags.file ? await readFile(String(flags.file), 'utf8') : await readStdin();

  let existing: Record<string, any> | null = null;
  try {
    existing = await api.get(docPath);
  } catch (error) {
    if (!(error instanceof DocsAPIError) || error.status !== 404) throw error;
  }

  if (!existing) return create(api, docPath, { ...flags, file: undefined, _stdin: body });

  const updated = await api.update(existing.id, {
    body_md: body,
    ...(flags.title ? { title: String(flags.title) } : {}),
    ...(flags.message ? { message: String(flags.message) } : {}),
    // The hash read above is the default guard. A caller that edited from an
    // earlier read can pass --if-hash to keep that earlier baseline instead.
    if_content_hash: String(flags['if-hash'] ?? existing.content_hash),
  });
  process.stderr.write(`wrote ${updated.path} v${updated.version}\n`);
  return flags.json ? print(updated, flags) : 0;
}

/**
 * One-time (and repeatable) import of a local markdown vault.
 *
 * Re-running is safe: content hashes decide what actually changes, so a second
 * run over an unchanged vault writes nothing.
 */
/**
 * Which curated documents no longer match the file they were copied from.
 *
 * Runs here rather than in the Worker because the sources are on this
 * machine. Reports and exits non-zero on anything that differs, so it can be
 * a step in a check rather than something a person has to remember.
 */
async function drift(api: DocsClient, config: Config, flags: Flags): Promise<number> {
  const vaultRoot = flags.vault ? expand(String(flags.vault)) : expand('~/Vaults/Envisioning');
  const repoRoots = { meet: expand(String(flags.meet ?? '~/Dev/Starlings/starlings')) };

  const rows = await collectDrift(api, {
    vaultRoot,
    repoRoots,
    ...(flags.prefix ? { prefix: String(flags.prefix) } : {}),
  });
  if (flags.json) return print(rows, flags);

  const problems = rows.filter((row) => row.verdict !== 'same');
  for (const row of problems) {
    process.stdout.write(`${row.verdict === 'missing' ? 'gone   ' : 'drifted'} ${row.docPath}\n         ${row.file}\n`);
  }

  const same = rows.length - problems.length;
  process.stderr.write(
    rows.length === 0
      ? 'No documents record a source this invocation can resolve.\n'
      : `${same} unchanged, ${problems.filter((r) => r.verdict === 'drifted').length} drifted, ${problems.filter((r) => r.verdict === 'missing').length} gone.\n`,
  );
  // Non-zero on drift: a check that always succeeds is not a check.
  return problems.length ? 1 : 0;
}

async function importVault(api: DocsClient, directory: string, flags: Flags): Promise<number> {
  const prefix = String(flags.prefix ?? '/vault');
  const root = expand(directory);
  process.stderr.write(`Reading ${root}…\n`);

  const files = await collect(root, prefix);
  process.stderr.write(`${files.length} markdown files → ${prefix}\n`);

  if (flags['dry-run']) {
    for (const file of files.slice(0, Number(flags.limit ?? 20))) {
      process.stdout.write(`${file.docPath}\t${file.title}\n`);
    }
    if (files.length > Number(flags.limit ?? 20)) {
      process.stderr.write(`… and ${files.length - Number(flags.limit ?? 20)} more (dry run — nothing written)\n`);
    }
    return 0;
  }

  let written = 0;
  let skipped = 0;
  const conflicts: string[] = [];

  for (let index = 0; index < files.length; index += BATCH) {
    const batch = files.slice(index, index + BATCH);
    const result = await api.push({
      documents: batch.map((file) => ({
        path: file.docPath,
        title: file.title,
        body_md: file.body,
        frontmatter: file.frontmatter,
        tags: file.tags,
      })),
      message: String(flags.message ?? `import from ${path.basename(root)}`),
    });
    written += result.written.length;
    skipped += result.skipped.length;
    for (const conflict of result.conflicts) conflicts.push(conflict.path);
    process.stderr.write(`\r${Math.min(index + BATCH, files.length)}/${files.length} — ${written} written, ${skipped} unchanged`);
  }

  process.stderr.write(`\nDone. ${written} written, ${skipped} unchanged.\n`);
  if (conflicts.length) process.stderr.write(`${conflicts.length} conflicts: ${conflicts.slice(0, 5).join(', ')}\n`);
  return conflicts.length ? 1 : 0;
}

/** Write the remote tree down to the local mirror. */
async function pull(api: DocsClient, config: Config, flags: Flags): Promise<number> {
  const root = expand(String(flags.dir ?? config.root ?? ''));
  if (!root) {
    process.stderr.write('No mirror directory. Pass --dir or set one with `docsctl login`.\n');
    return 2;
  }
  const prefix = String(flags.prefix ?? '/vault');

  const { entries, truncated } = await api.manifest(prefix);
  if (truncated) process.stderr.write('Warning: manifest was truncated — narrow with --prefix.\n');

  let updated = 0;
  let unchanged = 0;

  for (const entry of entries) {
    if (entry.kind === 'pdf') continue;
    const local = localPathFor(root, prefix, entry.path);
    let current: string | null = null;
    try {
      current = await readFile(local, 'utf8');
    } catch {
      current = null;
    }
    if (current !== null && sha256(current) === entry.content_hash) {
      unchanged += 1;
      continue;
    }
    const body = await api.raw(entry.path);
    await mkdir(path.dirname(local), { recursive: true });
    await writeFile(local, body, 'utf8');
    updated += 1;
    if (flags.verbose) process.stderr.write(`↓ ${entry.path}\n`);
  }

  process.stderr.write(`Pulled ${updated} file(s), ${unchanged} already current.\n`);
  return 0;
}

/** Send local edits up, refusing to clobber anything changed underneath. */
async function pushMirror(api: DocsClient, config: Config, flags: Flags): Promise<number> {
  const root = expand(String(flags.dir ?? config.root ?? ''));
  if (!root) {
    process.stderr.write('No mirror directory. Pass --dir or set one with `docsctl login`.\n');
    return 2;
  }
  const prefix = String(flags.prefix ?? '/vault');

  const [files, { entries }] = await Promise.all([collect(root, prefix), api.manifest(prefix)]);
  const remote = new Map(entries.map((entry) => [entry.path, entry]));

  const changed = files.filter((file) => remote.get(file.docPath)?.content_hash !== file.hash);
  if (!changed.length) {
    process.stderr.write('Nothing to push.\n');
    return 0;
  }
  if (flags['dry-run']) {
    for (const file of changed) process.stdout.write(`${remote.has(file.docPath) ? 'M' : 'A'} ${file.docPath}\n`);
    return 0;
  }

  let written = 0;
  const conflicts: Array<{ path: string }> = [];

  for (let index = 0; index < changed.length; index += BATCH) {
    const batch = changed.slice(index, index + BATCH);
    const result = await api.push({
      documents: batch.map((file) => ({
        path: file.docPath,
        title: file.title,
        body_md: file.body,
        frontmatter: file.frontmatter,
        tags: file.tags,
        // The hash we saw in the manifest. If the server has moved on since,
        // this comes back as a conflict rather than overwriting.
        ...(remote.has(file.docPath) ? { base_hash: remote.get(file.docPath)!.content_hash } : {}),
      })),
      message: String(flags.message ?? 'docsctl push'),
    });
    written += result.written.length;
    conflicts.push(...result.conflicts);
  }

  process.stderr.write(`Pushed ${written} file(s).\n`);
  if (conflicts.length) {
    process.stderr.write(`\n${conflicts.length} conflict(s) — pull these and merge before pushing again:\n`);
    for (const conflict of conflicts) process.stderr.write(`  ${conflict.path}\n`);
    return 1;
  }
  return 0;
}

async function status(api: DocsClient, config: Config, flags: Flags): Promise<number> {
  const root = expand(String(flags.dir ?? config.root ?? ''));
  const prefix = String(flags.prefix ?? '/vault');
  const { entries } = await api.manifest(prefix);
  const remote = new Map(entries.map((entry) => [entry.path, entry]));

  if (!root) {
    process.stdout.write(`${entries.length} documents under ${prefix}. No local mirror configured.\n`);
    return 0;
  }

  const files = await collect(root, prefix);
  const local = new Map(files.map((file) => [file.docPath, file]));

  const added = files.filter((file) => !remote.has(file.docPath));
  const modified = files.filter((file) => remote.has(file.docPath) && remote.get(file.docPath)!.content_hash !== file.hash);
  const missing = entries.filter((entry) => !local.has(entry.path));

  if (flags.json) return print({ added: added.length, modified: modified.length, missing: missing.length }, flags);

  for (const file of added) process.stdout.write(`A  ${file.docPath}\n`);
  for (const file of modified) process.stdout.write(`M  ${file.docPath}\n`);
  for (const entry of missing) process.stdout.write(`?  ${entry.path} (remote only)\n`);
  process.stderr.write(`\n${added.length} added, ${modified.length} modified, ${missing.length} remote-only\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

type Flags = Record<string, string | boolean | undefined>;

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith('--')) continue;
    const [key, inline] = arg.slice(2).split('=');
    if (!key) continue;
    if (inline !== undefined) {
      flags[key] = inline;
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

function required(value: string | undefined, name: string): string {
  if (!value) {
    process.stderr.write(`Missing required <${name}>.\n`);
    process.exit(2);
  }
  return value;
}

function expand(value: string): string {
  if (value.startsWith('~')) return path.join(process.env.HOME ?? '', value.slice(1));
  return path.resolve(value);
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    process.stderr.write('Reading from stdin — end with Ctrl-D.\n');
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function print(value: unknown, _flags: Flags): number {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  return 0;
}

function usage(): void {
  process.stdout.write(`docsctl — docs.org.example

  docsctl login                          Store an API token and mirror directory
  docsctl whoami                         Show the identity behind the current token

  docsctl ls [prefix] [--source core]    List documents
  docsctl cat <path|id> [--json]         Print a document (markdown by default)
  docsctl search <query> [--limit 20]    Full-text search across everything
  docsctl new <path> --title "…"         Create a document from stdin or --file
  docsctl write <path> [--file f]        Create or overwrite; --if-hash to be safe

  docsctl drift [--prefix /method]       Curated copies that no longer match their source
  docsctl import <dir> --prefix /vault   Import a markdown vault (repeatable)
  docsctl pull  [--prefix] [--dir]       Write the remote tree to the local mirror
  docsctl push  [--prefix] [--dir]       Send local edits up, reporting conflicts
  docsctl status [--prefix] [--dir]      What differs between local and remote

  docsctl workset pull --prefix /strategy --dir ./docs-workset
  docsctl workset status --dir ./docs-workset
  docsctl workset push --dir ./docs-workset [--apply]
  docsctl workset audit --dir ./docs-workset
                                         Curate native notes with guarded writes

Flags: --json  --dry-run  --apply  --verbose  --message "…"  --limit N

Environment: DOCS_ORIGIN, DOCS_TOKEN (both override the config file).
`);
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    if (error instanceof DocsAPIError) {
      process.stderr.write(`${error.message} (${error.code})\n`);
      process.exit(error.status >= 500 ? 70 : 1);
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
