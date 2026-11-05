#!/usr/bin/env node
// Probe the Meet -> Core CRM integration from the outside.
//
// The Worker talks to Core with an HMAC over `${timestamp}.${body}` in
// `x-internal-signature`, keyed by the shared INTERNAL_REQUEST_SECRET (see
// services/control-plane/src/crm.ts). When the tasks panel says "Couldn't load
// tasks", the failure is one of four things, and they need different fixes:
//
//   1. secret missing on the Worker      -> 503 not_configured, no call made
//   2. secret present but != Core's      -> Core answers 401/403
//   3. Core has no such route/migration  -> Core answers 404
//   4. Core is fine, the Worker is not   -> Core answers 200 here
//
// This script isolates 2/3/4 by making the same signed calls Core sees from the
// Worker, straight from your Mac. GET only — nothing here writes to the CRM.
//
//   node scripts/crm-probe.mjs
//   node scripts/crm-probe.mjs --origin https://core.staging.example --kind project
//   node scripts/crm-probe.mjs --kind project --id <uuid>   # the channel lookup
//
// The secret is read from $INTERNAL_REQUEST_SECRET, or from
// services/control-plane/.dev.vars. It is never printed: what is printed is a
// short fingerprint, so you can run the same fingerprint against Core's copy
// and compare the two without either side revealing the value.

import { CORE_API_ORIGIN } from '../packages/contracts/src/deployment-values.ts';
import { createHmac, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_ORIGIN = CORE_API_ORIGIN;
const TIMEOUT_MS = 10_000;

function parseArgs(argv) {
  const args = { origin: DEFAULT_ORIGIN, kind: 'lead', query: '', id: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--origin' && value) { args.origin = value.replace(/\/$/, ''); index += 1; }
    else if (flag === '--kind' && value) { args.kind = value; index += 1; }
    else if (flag === '--q' && value) { args.query = value; index += 1; }
    else if (flag === '--id' && value) { args.id = value; index += 1; }
    else if (flag === '--help' || flag === '-h') { args.help = true; }
  }
  return args;
}

/** $INTERNAL_REQUEST_SECRET, else the uncommented line in .dev.vars. */
function resolveSecret() {
  const fromEnv = process.env.INTERNAL_REQUEST_SECRET?.trim();
  if (fromEnv) return { secret: fromEnv, source: '$INTERNAL_REQUEST_SECRET' };
  const path = join(repoRoot, 'services/control-plane/.dev.vars');
  let contents;
  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    return { secret: null, source: null };
  }
  for (const line of contents.split('\n')) {
    const match = line.match(/^\s*INTERNAL_REQUEST_SECRET\s*=\s*(.+)\s*$/u);
    if (!match) continue;
    const value = match[1].trim().replace(/^["']|["']$/gu, '');
    if (value && !value.startsWith('replace-with')) {
      return { secret: value, source: 'services/control-plane/.dev.vars' };
    }
  }
  return { secret: null, source: null };
}

/**
 * Comparable without disclosing. Run the same over Core's secret; equal
 * fingerprints mean equal secrets, and nothing else leaves either machine.
 */
function fingerprint(secret) {
  return createHash('sha256').update(secret).digest('hex').slice(0, 12);
}

function sign(secret, timestamp, body = '') {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

async function signedGet(origin, path, searchParams, secret, { corruptSignature = false } = {}) {
  const url = new URL(`${origin}${path}`);
  for (const [key, value] of Object.entries(searchParams)) {
    if (value) url.searchParams.set(key, value);
  }
  const timestamp = String(Date.now());
  let signature = sign(secret, timestamp);
  if (corruptSignature) signature = signature.replace(/^./u, (c) => (c === '0' ? '1' : '0'));

  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'x-internal-timestamp': timestamp,
        'x-internal-signature': signature,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text();
    return { url, status: response.status, ms: Date.now() - startedAt, text };
  } catch (error) {
    return { url, status: 0, ms: Date.now() - startedAt, text: String(error?.message ?? error) };
  }
}

function snippet(text, limit = 220) {
  const collapsed = text.replace(/\s+/gu, ' ').trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit)}…` : collapsed;
}

function report(label, result) {
  const verdict = result.status === 0 ? 'UNREACHABLE'
    : result.status === 200 ? 'ok'
    : result.status === 401 || result.status === 403 ? 'REJECTED (signature/secret)'
    : result.status === 404 ? 'NOT FOUND (route or migration missing)'
    : 'unexpected';
  console.log(`\n${label}`);
  console.log(`  ${result.url.pathname}${result.url.search}`);
  console.log(`  ${result.status} ${verdict} · ${result.ms}ms`);
  if (result.text) console.log(`  ${snippet(result.text)}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: node scripts/crm-probe.mjs [--origin <core origin>] [--kind lead|project] [--q <query>] [--id <uuid>]');
    return 0;
  }

  const { secret, source } = resolveSecret();
  if (!secret) {
    console.error('No INTERNAL_REQUEST_SECRET found.');
    console.error('Set $INTERNAL_REQUEST_SECRET, or add it to services/control-plane/.dev.vars.');
    console.error('The deployed Worker keeps its own copy — check with:');
    console.error('  pnpm --filter @starlings/control-plane exec wrangler secret list');
    return 2;
  }

  console.log(`Core origin:  ${args.origin}`);
  console.log(`Secret from:  ${source}`);
  console.log(`Fingerprint:  ${fingerprint(secret)}  (sha256 head — compare with Core's, never the secret)`);

  const subjects = await signedGet(
    args.origin,
    '/api/public/meet-crm-subjects',
    { kind: args.kind, q: args.query },
    secret,
  );
  report(`subjects (${args.kind})`, subjects);

  // The roster behind the assignee picker. An empty list here and a 200 is
  // the failure that reads as "no team" in the app.
  const team = await signedGet(args.origin, '/api/public/meet-team', {}, secret);
  report('team roster', team);

  // Exact lookup. This is the call a channel depends on: it decides whether a
  // subject exists before Meet creates a conversation about it, and it hands
  // back the title that conversation is named after. An empty `subjects` array
  // here means Core answered "no such subject", which is different from the
  // 404 a missing route gives.
  if (args.id) {
    const one = await signedGet(
      args.origin,
      '/api/public/meet-crm-subjects',
      { kind: args.kind, id: args.id },
      secret,
    );
    report(`subject by id (${args.id})`, one);
  }

  // A deliberately wrong signature. Core must reject it — if this comes back
  // 200, Core is not verifying at all and a matching secret proves nothing.
  const forged = await signedGet(
    args.origin,
    '/api/public/meet-crm-subjects',
    { kind: args.kind },
    secret,
    { corruptSignature: true },
  );
  report('negative control (corrupted signature — expect 401/403)', forged);

  let subjectId = null;
  if (subjects.status === 200) {
    try {
      const first = JSON.parse(subjects.text)?.subjects?.[0];
      if (first?.id) subjectId = first.id;
    } catch {
      console.log('\n  (subjects returned 200 but the body did not parse as JSON)');
    }
  }

  if (subjectId) {
    const key = args.kind === 'project' ? 'project_id' : 'lead_id';
    const tasks = await signedGet(
      args.origin,
      '/api/public/meet-crm-tasks',
      { [key]: subjectId },
      secret,
    );
    report(`tasks (${key}=${subjectId})`, tasks);
  } else {
    console.log('\ntasks: skipped — no subject id to ask about.');
  }

  console.log('\nNot probed: POST /api/public/meet-crm-tasks and the meeting-log ingest.');
  console.log('Both write to the CRM, so they are not something a diagnostic should do on its own.');

  const failed = subjects.status !== 200;
  if (failed) {
    console.log('\nNext step by symptom:');
    console.log('  401/403 -> secrets differ. Compare fingerprints, then re-put both sides.');
    console.log('  404     -> Core lacks the route or the migration. Check Core, not Meet.');
    console.log('  0       -> network/DNS/timeout from this Mac; the Worker may still reach Core.');
  }
  return failed ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
