#!/usr/bin/env -S node --experimental-strip-types
// Mirror Core's markdown surfaces into Docs.
//
// Core keeps finished writing in a dozen tables with a dozen different column
// names: `newsletter_issue.body`, `report.content`, `signals_briefs
// .description_markdown`, `faq.answer` (an array), `research` spread over five
// prose columns. None of that shape should leak into Docs — so the whole
// mapping lives in ADAPTERS below, and adding a new surface is one entry.
//
// Reads Supabase over PostgREST (no client library, so this stays dependency
// free) and posts batches to /api/ingest with the same HMAC handshake Meet
// uses to post meeting logs into Core.
//
//   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
//   DOCS_ORIGIN=https://<your-docs-host> INTERNAL_REQUEST_SECRET=… \
//   node --experimental-strip-types scripts/mirror-core.ts [surface…] [--dry-run]
//
// Idempotent: unchanged rows are recognized by content hash and skipped. The
// Worker runs the same sweep on a Cron Trigger (`src/mirror.ts`); this is the
// by-hand version for a first fill, a re-fill after an adapter change, or one
// surface at a time.

import { createHmac } from 'node:crypto';
import process from 'node:process';
import { ADAPTERS, mirrorDocuments, readAll, type Project } from '../src/mirror-adapters.ts';

const BATCH = 50;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const requested = argv.filter((value) => !value.startsWith('--'));
  const surfaces = requested.length ? requested : Object.keys(ADAPTERS);
  const failures: string[] = [];

  // The served origin, not the vanity redirect — /api/ingest is a POST, and a
  // 302 would drop the method, the body, and the HMAC headers with it.
  const docsOrigin = dryRun ? '' : need('DOCS_ORIGIN');
  const secret = dryRun ? '' : need('INTERNAL_REQUEST_SECRET');

  const projects: Record<Project, { url: string; key: string } | null> = { cms: null, crm: null };
  const credentialsFor = (project: Project) => {
    const cached = projects[project];
    if (cached) return cached;
    const suffix = project.toUpperCase();
    const value = {
      url: need(`SUPABASE_URL_${suffix}`),
      key: need(`SUPABASE_SERVICE_ROLE_KEY_${suffix}`),
    };
    projects[project] = value;
    return value;
  };

  for (const surface of surfaces) {
    const adapter = ADAPTERS[surface];
    if (!adapter) {
      process.stderr.write(`Unknown surface "${surface}". Known: ${Object.keys(ADAPTERS).join(', ')}\n`);
      return 2;
    }

    const { url, key } = credentialsFor(adapter.project);

    // One unreadable surface must not abort the sweep — `work` is a view the
    // service role cannot select today, and the other seven still need to
    // sync. Failures are collected and reported in the exit code instead.
    let rows: Awaited<ReturnType<typeof readAll>>;
    try {
      rows = await readAll(url, key, adapter);
    } catch (error) {
      failures.push(surface);
      process.stderr.write(`${surface}: SKIPPED — ${error instanceof Error ? error.message : String(error)}\n\n`);
      continue;
    }
    process.stderr.write(`${surface}: ${rows.length} rows\n`);

    const documents = mirrorDocuments(surface, adapter, rows);

    process.stderr.write(`${surface}: ${documents.length} with content\n`);

    if (dryRun) {
      for (const document of documents.slice(0, 5)) {
        process.stdout.write(`  ${document.source_id}  ${document.title}  (${document.body_md.length} chars)\n`);
      }
      continue;
    }

    let written = 0;
    let unchanged = 0;
    for (let index = 0; index < documents.length; index += BATCH) {
      const result = await post(docsOrigin, secret, {
        source_system: 'core',
        documents: documents.slice(index, index + BATCH),
      });
      written += result.written;
      unchanged += result.unchanged;
    }

    // A trailing, document-free call records the run. Folding it into the last
    // batch would report totals that exclude that batch's own writes.
    await post(docsOrigin, secret, {
      source_system: 'core',
      source_kind: surface,
      documents: [],
      complete: true,
      run_seen: documents.length,
      run_written: written,
    });
    process.stderr.write(`${surface}: ${written} written, ${unchanged} unchanged\n\n`);
  }

  if (failures.length) {
    process.stderr.write(`Could not read: ${failures.join(', ')}\n`);
    return 1;
  }
  return 0;
}

async function post(
  origin: string,
  secret: string,
  payload: unknown,
): Promise<{ written: number; unchanged: number; deleted: number }> {
  const body = JSON.stringify(payload);
  const timestamp = String(Date.now());
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

  const response = await fetch(`${origin}/api/ingest`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-timestamp': timestamp,
      'x-internal-signature': signature,
    },
    body,
  });
  if (!response.ok) throw new Error(`Docs ingest failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as { written: number; unchanged: number; deleted: number };
}

function need(name: string): string {
  const value = process.env[name];
  if (!value) {
    process.stderr.write(`${name} is not set.\n`);
    process.exit(2);
  }
  return value;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
