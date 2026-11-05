#!/usr/bin/env -S node --experimental-strip-types
// Adopt Core's `notes` into Docs as native documents, by hand.
//
// The Worker does this hourly now (`src/adopt-notes.ts`, surface `core:note`);
// this script is the same mapping over HTTP, for a backfill before the next
// sweep, or when the Worker has no CRM credentials yet.
//
// Core's notes were the first draft of this product: markdown on a subject,
// shared by a uuid link. They become Docs documents that are *ours*: the
// body is editable here, the file sits under the subject it is about
// (`/work/<kind>/<subject-slug>/`), the subject link becomes a real relation,
// and `source_id` stays so the row can always be traced back. Notes linked to
// nothing land in `/notes/`.
//
// Idempotent, and non-destructive by construction: Docs returns a row that is
// already ours as `unchanged` and leaves it alone, so an edit made here can
// never be flattened by Core's older body.
//
//   SUPABASE_URL_CRM=… SUPABASE_SERVICE_ROLE_KEY_CRM=… \
//   DOCS_ORIGIN=https://<your-docs-host> INTERNAL_REQUEST_SECRET=… \
//   node --experimental-strip-types scripts/adopt-core-notes.ts [--dry-run]

import { createHmac } from 'node:crypto';
import process from 'node:process';
import { NOTE_SELECT, noteDocuments, readLabels, readTable, slugify } from '../src/adopt-notes.ts';

const BATCH = 50;

async function main(): Promise<number> {
  const dryRun = process.argv.includes('--dry-run');
  const docsOrigin = dryRun ? '' : need('DOCS_ORIGIN');
  const secret = dryRun ? '' : need('INTERNAL_REQUEST_SECRET');
  const url = need('SUPABASE_URL_CRM');
  const key = need('SUPABASE_SERVICE_ROLE_KEY_CRM');

  const notes = await readTable(url, key, 'notes', NOTE_SELECT);
  process.stderr.write(`notes: ${notes.length} rows\n`);

  // One label per linked row, for the folder name. Read whole tables rather
  // than one lookup per note: a few thousand short rows is one request each.
  const documents = noteDocuments(notes, await readLabels(url, key));
  process.stderr.write(`notes: ${documents.length} with content\n`);

  if (dryRun) {
    for (const document of documents.slice(0, 20)) {
      process.stdout.write(
        `  ${document.folder_path}/${slugify(document.title)}  [${document.subjects.map((s) => s.kind).join(',') || 'unlinked'}]\n`,
      );
    }
    return 0;
  }

  let adopted = 0;
  let created = 0;
  let unchanged = 0;
  for (let index = 0; index < documents.length; index += BATCH) {
    const result = await post(docsOrigin, secret, {
      source_system: 'core',
      documents: documents.slice(index, index + BATCH),
    });
    adopted += result.adopted;
    created += result.created;
    unchanged += result.unchanged;
  }
  process.stderr.write(`notes: ${adopted} adopted, ${created} created, ${unchanged} already ours\n`);
  return 0;
}

async function post(origin: string, secret: string, payload: unknown): Promise<{ adopted: number; created: number; unchanged: number }> {
  const body = JSON.stringify(payload);
  const timestamp = String(Date.now());
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  const response = await fetch(`${origin}/api/adopt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-timestamp': timestamp, 'x-internal-signature': signature },
    body,
  });
  if (!response.ok) throw new Error(`Docs adopt failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as { adopted: number; created: number; unchanged: number };
}

function need(name: string): string {
  const value = process.env[name];
  if (!value) {
    process.stderr.write(`${name} is not set.\n`);
    process.exit(2);
  }
  return value;
}

process.exit(await main());
