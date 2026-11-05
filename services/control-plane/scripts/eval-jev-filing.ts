#!/usr/bin/env node
/**
 * Jev filing eval: can a decision model file a meeting the way a person did?
 * (JEV (HQ Docs), recommended order 1.)
 *
 *   pnpm eval:jev                      # every filed Granola meeting
 *   pnpm eval:jev --limit 40           # the newest 40
 *   pnpm eval:jev --dry-run            # counts and state sizes, no model call
 *   pnpm eval:jev --out results.jsonl  # keep every answer (labels and numbers only)
 *   pnpm eval:jev --verbose            # print each miss by title
 *
 * The question this answers is not "is Jev right" but "does its probability
 * mean anything on our text". The labels are meetings a person already filed
 * in Core: `meeting_kind` plus the lead or project it hangs off. The report
 * buckets every answer by the probability Jev gave it and prints the hit rate
 * per bucket. A calibrated model's 0.9 bucket is right about nine times in
 * ten; that table is the deliverable.
 *
 * Data: the Granola ledger through Core's signed read
 * (`/api/public/meet-crm-interactions?source=granola`), the same call the
 * import list makes, plus the lead and project lists. Needs
 * `INTERNAL_REQUEST_SECRET` (env, or `.dev.vars` like `scripts/crm-probe.mjs`).
 * GET only; nothing here writes to Core.
 *
 * Model: `typesafe-ai/jev` through Vercel AI Gateway (`AI_GATEWAY_API_KEY`),
 * via the AI SDK's `experimental_evaluate`. What goes to the model per
 * meeting: title, date, participant display names and email *domains*, the
 * note body, and the transcript preview. Never an email address, never audio.
 * This is transcript-class text leaving for a subprocessor Meet does not use
 * today — run it knowing that (`docs/PRIVACY.md`).
 */
import { experimental_evaluate as evaluate, type JSONValue } from 'ai';
import { createHmac } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CORE_API_ORIGIN } from '@starlings/contracts/deployment';
import type { CrmSubject } from '../src/contracts.ts';
import type { CrmLedgerRow } from '../src/crm.ts';

const DEFAULT_MODEL = 'typesafe-ai/jev';
const REQUEST_TIMEOUT_MS = 20_000;
/** Jev's ceiling on one choice; the rest of a long list goes in a second call. */
const CHOICE_CEILING = 255;
const NOTE_CHARS = 8_000;
const TRANSCRIPT_PREVIEW_CHARS = 2_000;
/** Vendor rate: $0.042 per million input tokens, output free. */
const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

const KINDS = ['status', 'lead', 'project', 'internal'] as const;
type Kind = (typeof KINDS)[number];

/** The kinds, described the way MEETING_LOG.md §Meeting categorization does. */
const KIND_CRITERIA: Record<Kind | 'uncategorized', string> = {
  status: 'A company-wide or general status meeting, usually recurring, about how the team and the business are doing overall',
  lead: 'An external sales or discovery conversation with a prospective client about work Envisioning might do for them',
  project: 'A delivery or working session on a client project that is already under way',
  internal: 'Envisioning-only work on its own product, design, operations, hiring or tooling, with no client in the room',
  uncategorized: 'None of the above fits',
};

interface Options {
  limit: number | null;
  only: string | null;
  verbose: boolean;
  dryRun: boolean;
  model: string;
  out: string | null;
  origin: string;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    limit: null,
    only: null,
    verbose: false,
    dryRun: false,
    model: process.env.JEV_MODEL ?? DEFAULT_MODEL,
    out: null,
    origin: (process.env.CORE_API_ORIGIN ?? CORE_API_ORIGIN).replace(/\/$/, ''),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--') continue;
    if (arg === '--limit') options.limit = Number.parseInt(argv[++index] ?? '', 10) || null;
    else if (arg === '--only') options.only = argv[++index] ?? null;
    else if (arg === '--verbose' || arg === '-v') options.verbose = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--model') options.model = argv[++index] ?? options.model;
    else if (arg === '--out') options.out = argv[++index] ?? null;
    else if (arg === '--origin') options.origin = (argv[++index] ?? options.origin).replace(/\/$/, '');
    else throw new Error(`Unknown argument ${arg}`);
  }
  return options;
}

// --- Core, signed GET only (mirrors scripts/crm-probe.mjs) ---

async function resolveSecret(): Promise<string> {
  const fromEnv = process.env.INTERNAL_REQUEST_SECRET?.trim();
  if (fromEnv) return fromEnv;
  const path = join(import.meta.dirname, '..', '.dev.vars');
  let contents = '';
  try {
    contents = await readFile(path, 'utf8');
  } catch {
    // fall through to the error below
  }
  for (const line of contents.split('\n')) {
    const match = line.match(/^\s*INTERNAL_REQUEST_SECRET\s*=\s*(.+)\s*$/u);
    if (!match) continue;
    const value = match[1]!.trim().replace(/^["']|["']$/gu, '');
    if (value && !value.startsWith('replace-with')) return value;
  }
  throw new Error('INTERNAL_REQUEST_SECRET is not set (env or services/control-plane/.dev.vars).');
}

async function signedGet<T>(origin: string, secret: string, path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`${origin}${path}`);
  for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value);
  const timestamp = String(Date.now());
  const signature = createHmac('sha256', secret).update(`${timestamp}.`).digest('hex');
  const response = await fetch(url, {
    method: 'GET',
    headers: { accept: 'application/json', 'x-internal-timestamp': timestamp, 'x-internal-signature': signature },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Core ${path} answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return await response.json() as T;
}

async function loadLedger(origin: string, secret: string): Promise<CrmLedgerRow[]> {
  const data = await signedGet<{ interactions?: CrmLedgerRow[] }>(origin, secret, '/api/public/meet-crm-interactions', {
    source: 'granola',
    limit: '1000',
  });
  return Array.isArray(data.interactions) ? data.interactions : [];
}

/** Core caps one subjects read at 100 rows and has no paging (core-web
 * `meet-crm-subjects/route.ts`). One page of every status, then an exact
 * lookup for each filed subject the page missed, so every truth is an option. */
async function loadSubjects(origin: string, secret: string, kind: 'lead' | 'project', wanted: Set<string>): Promise<CrmSubject[]> {
  const data = await signedGet<{ subjects?: CrmSubject[]; has_more?: boolean }>(origin, secret, '/api/public/meet-crm-subjects', {
    kind,
    status: 'all',
    limit: '100',
  });
  const subjects = Array.isArray(data.subjects) ? data.subjects : [];
  const listed = new Set(subjects.map((subject) => subject.id));
  let added = 0;
  for (const id of wanted) {
    if (listed.has(id)) continue;
    const one = await signedGet<{ subjects?: CrmSubject[] }>(origin, secret, '/api/public/meet-crm-subjects', { kind, id, status: 'all' });
    const subject = one.subjects?.[0];
    if (subject) {
      subjects.push(subject);
      added += 1;
    }
  }
  if (data.has_more) console.warn(`warning: Core lists more than 100 ${kind}s; the options are the newest 100 plus ${added} filed ${kind}s fetched by id.`);
  return subjects;
}

// --- The state: what the model reads about one meeting ---

function isFiledKind(value: string | null): value is Kind {
  return (KINDS as readonly string[]).includes(value ?? '');
}

function domainOf(email: string | null): string | null {
  const at = email?.lastIndexOf('@') ?? -1;
  return at > 0 ? email!.slice(at + 1).toLowerCase() : null;
}

function buildState(row: CrmLedgerRow): Record<string, JSONValue> {
  const participants = row.contacts.map((contact) => ({
    name: contact.name ?? 'unknown',
    domain: domainOf(contact.email) ?? 'unknown',
  }));
  return {
    title: row.title,
    date: (row.occurred_at ?? row.created_at ?? '').slice(0, 10),
    duration_minutes: row.duration_minutes,
    participants,
    notes: (row.summary_markdown ?? '').slice(0, NOTE_CHARS),
    transcript_start: (row.transcript_preview ?? '').slice(0, TRANSCRIPT_PREVIEW_CHARS),
  };
}

// --- Questions ---

interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
}

function kindQuestion() {
  return {
    type: 'choice' as const,
    instructions: 'Which kind of meeting is this, the way Envisioning files it? Judge from who is in the room and what is discussed.',
    criteria: KIND_CRITERIA,
  };
}

function subjectQuestion(kind: 'lead' | 'project', subjects: CrmSubject[]) {
  const criteria: Record<string, string> = {};
  for (const subject of subjects) {
    criteria[subject.id] = subject.subtitle ? `${subject.title} (${subject.subtitle})` : subject.title;
  }
  criteria.none = kind === 'lead'
    ? 'This meeting is not about any of the listed leads'
    : 'This meeting is not about any of the listed projects';
  return {
    type: 'choice' as const,
    instructions: kind === 'lead'
      ? 'Which prospective client (lead) is this meeting about, if any? Match on the organisation and people in the room, not on similar-sounding names.'
      : 'Which client project is this meeting about, if any? Match on the organisation and people in the room, not on similar-sounding names.',
    criteria,
  };
}

/** Lists past Jev's ceiling are asked in slices; the best non-`none` across slices wins. */
function slices<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out.length > 0 ? out : [[]];
}

function best(answers: ChoiceAnswer[]): { choice: string; probability: number } {
  let choice = 'none';
  let probability = 0;
  let noneFloor = 1;
  for (const answer of answers) {
    for (const [option, p] of Object.entries(answer.probabilities)) {
      if (option === 'none') {
        noneFloor = Math.min(noneFloor, p);
        continue;
      }
      if (p > probability) {
        choice = option;
        probability = p;
      }
    }
  }
  return probability >= noneFloor ? { choice, probability } : { choice: 'none', probability: noneFloor };
}

// --- One meeting ---

interface Verdict {
  id: string;
  title: string;
  truth: { kind: Kind; subject: string | null };
  kind: { choice: string; probability: number };
  subject: { choice: string; probability: number } | null;
  inputTokens: number;
  calls: number;
}

async function judge(
  model: string,
  row: CrmLedgerRow,
  leads: CrmSubject[],
  projects: CrmSubject[],
): Promise<Verdict> {
  const state = buildState(row);
  const truthKind = row.meeting_kind as Kind;
  const truthSubject = truthKind === 'lead' ? row.lead_id : truthKind === 'project' ? row.project_id : null;

  // Speculative fan-out: kind, lead and project in one call when the lists
  // fit; the answer the kind does not need is ignored in code.
  let inputTokens = 0;
  let calls = 0;
  const leadSlices = slices(leads, CHOICE_CEILING - 1);
  const projectSlices = slices(projects, CHOICE_CEILING - 1);
  const leadAnswers: ChoiceAnswer[] = [];
  const projectAnswers: ChoiceAnswer[] = [];
  let kindAnswer: ChoiceAnswer | null = null;

  const rounds = Math.max(leadSlices.length, projectSlices.length);
  for (let round = 0; round < rounds; round += 1) {
    const questions: Record<string, ReturnType<typeof kindQuestion> | ReturnType<typeof subjectQuestion>> = {};
    if (round === 0) questions.kind = kindQuestion();
    if (leadSlices[round]?.length) questions.lead = subjectQuestion('lead', leadSlices[round]!);
    if (projectSlices[round]?.length) questions.project = subjectQuestion('project', projectSlices[round]!);
    const result = await evaluate({ model, state, questions });
    calls += 1;
    inputTokens += result.usage.inputTokens ?? 0;
    const answers = result.answers as Record<string, ChoiceAnswer>;
    if (answers.kind) kindAnswer = answers.kind;
    if (answers.lead) leadAnswers.push(answers.lead);
    if (answers.project) projectAnswers.push(answers.project);
  }
  if (!kindAnswer) throw new Error('no kind answer');

  const kind = { choice: kindAnswer.choice, probability: kindAnswer.probabilities[kindAnswer.choice] ?? 0 };
  const subject = truthKind === 'lead' ? best(leadAnswers) : truthKind === 'project' ? best(projectAnswers) : null;
  return { id: row.id, title: row.title, truth: { kind: truthKind, subject: truthSubject }, kind, subject, inputTokens, calls };
}

// --- The report ---

const BUCKETS = [
  { label: '< 0.5', min: 0, max: 0.5 },
  { label: '0.5–0.7', min: 0.5, max: 0.7 },
  { label: '0.7–0.9', min: 0.7, max: 0.9 },
  { label: '≥ 0.9', min: 0.9, max: 1.01 },
];

function calibrationTable(name: string, rows: Array<{ probability: number; hit: boolean }>): string {
  const lines = [`${name}  (n=${rows.length})`, '  bucket     n    hit rate'];
  for (const bucket of BUCKETS) {
    const inBucket = rows.filter((row) => row.probability >= bucket.min && row.probability < bucket.max);
    const hits = inBucket.filter((row) => row.hit).length;
    const rate = inBucket.length ? `${((hits / inBucket.length) * 100).toFixed(0)}%` : '—';
    lines.push(`  ${bucket.label.padEnd(9)} ${String(inBucket.length).padStart(4)}    ${rate}`);
  }
  const hits = rows.filter((row) => row.hit).length;
  lines.push(`  overall    ${String(rows.length).padStart(4)}    ${rows.length ? ((hits / rows.length) * 100).toFixed(0) : 0}%`);
  return lines.join('\n');
}

function confusion(verdicts: Verdict[]): string {
  const labels = [...KINDS, 'uncategorized'];
  const header = `  truth \\ jev ${labels.map((label) => label.slice(0, 8).padStart(9)).join('')}`;
  const lines = [header];
  for (const truth of KINDS) {
    const row = verdicts.filter((verdict) => verdict.truth.kind === truth);
    if (row.length === 0) continue;
    const cells = labels.map((label) => String(row.filter((verdict) => verdict.kind.choice === label).length).padStart(9));
    lines.push(`  ${truth.padEnd(12)}${cells.join('')}`);
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const secret = await resolveSecret();
  if (!options.dryRun && !process.env.AI_GATEWAY_API_KEY?.trim()) {
    throw new Error('AI_GATEWAY_API_KEY is not set (Vercel AI Gateway).');
  }

  const ledger = await loadLedger(options.origin, secret);
  let filed = ledger.filter((row) => isFiledKind(row.meeting_kind));
  const [leads, projects] = await Promise.all([
    loadSubjects(options.origin, secret, 'lead', new Set(filed.flatMap((row) => (row.lead_id ? [row.lead_id] : [])))),
    loadSubjects(options.origin, secret, 'project', new Set(filed.flatMap((row) => (row.project_id ? [row.project_id] : [])))),
  ]);
  if (options.only) filed = filed.filter((row) => row.id === options.only);
  filed.sort((a, b) => (b.occurred_at ?? '').localeCompare(a.occurred_at ?? ''));
  if (options.limit) filed = filed.slice(0, options.limit);

  const leadIds = new Set(leads.map((subject) => subject.id));
  const projectIds = new Set(projects.map((subject) => subject.id));
  const unlisted = filed.filter((row) => (row.lead_id && !leadIds.has(row.lead_id)) || (row.project_id && !projectIds.has(row.project_id)));

  console.log(`ledger: ${ledger.length} Granola meetings, ${filed.length} filed by a person (${ledger.length - filed.length} uncategorized)`);
  console.log(`options: ${leads.length} leads, ${projects.length} projects${leads.length + 1 > CHOICE_CEILING || projects.length + 1 > CHOICE_CEILING ? ' (over the 255 ceiling: sliced across calls)' : ''}`);
  if (unlisted.length) console.log(`note: ${unlisted.length} filed meetings point at a subject Core did not list; those count as subject misses`);
  const byKind = Object.fromEntries(KINDS.map((kind) => [kind, filed.filter((row) => row.meeting_kind === kind).length]));
  console.log(`truth: ${JSON.stringify(byKind)}`);

  if (options.dryRun) {
    const sizes = filed.map((row) => JSON.stringify(buildState(row)).length);
    const total = sizes.reduce((sum, size) => sum + size, 0);
    console.log(`state: ${filed.length} meetings, ${(total / 1024).toFixed(0)} KiB total, ${(total / Math.max(1, filed.length) / 1024).toFixed(1)} KiB mean, ${(Math.max(0, ...sizes) / 1024).toFixed(1)} KiB max`);
    console.log(`estimate: ~${Math.round(total / 4).toLocaleString()} input tokens ≈ $${((total / 4) * USD_PER_INPUT_TOKEN).toFixed(3)} at the vendor rate`);
    return;
  }

  const verdicts: Verdict[] = [];
  const started = Date.now();
  for (const [index, row] of filed.entries()) {
    try {
      const verdict = await judge(options.model, row, leads, projects);
      verdicts.push(verdict);
      if (options.out) {
        const { title: _title, ...record } = verdict;
        await appendFile(options.out, `${JSON.stringify(record)}\n`);
      }
      const kindMark = verdict.kind.choice === verdict.truth.kind ? 'ok  ' : 'MISS';
      const subjectMark = verdict.subject
        ? verdict.subject.choice === (verdict.truth.subject ?? 'none') ? 'ok  ' : 'MISS'
        : '    ';
      if (options.verbose || kindMark === 'MISS' || subjectMark === 'MISS') {
        const subjectText = verdict.subject ? `  subject ${subjectMark} p=${verdict.subject.probability.toFixed(2)}` : '';
        console.log(`${String(index + 1).padStart(4)}  kind ${kindMark} ${verdict.truth.kind.padEnd(8)} → ${verdict.kind.choice.padEnd(13)} p=${verdict.kind.probability.toFixed(2)}${subjectText}  ${verdict.title.slice(0, 60)}`);
      }
    } catch (error) {
      console.error(`${String(index + 1).padStart(4)}  error  ${row.title.slice(0, 60)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const elapsedMs = Date.now() - started;
  const inputTokens = verdicts.reduce((sum, verdict) => sum + verdict.inputTokens, 0);
  const calls = verdicts.reduce((sum, verdict) => sum + verdict.calls, 0);

  console.log('');
  console.log(calibrationTable('meeting_kind', verdicts.map((verdict) => ({ probability: verdict.kind.probability, hit: verdict.kind.choice === verdict.truth.kind }))));
  console.log('');
  console.log(confusion(verdicts));
  console.log('');
  const withSubject = verdicts.filter((verdict) => verdict.subject !== null);
  console.log(calibrationTable('subject (lead / project rows)', withSubject.map((verdict) => ({
    probability: verdict.subject!.probability,
    hit: verdict.subject!.choice === (verdict.truth.subject ?? 'none'),
  }))));
  console.log('');
  const both = withSubject.filter((verdict) => verdict.kind.choice === verdict.truth.kind && verdict.subject!.choice === (verdict.truth.subject ?? 'none'));
  console.log(`filed exactly as the person did (kind and subject): ${both.length}/${withSubject.length}`);
  console.log(`${calls} calls, ${inputTokens.toLocaleString()} input tokens ≈ $${(inputTokens * USD_PER_INPUT_TOKEN).toFixed(4)}, ${(elapsedMs / Math.max(1, calls)).toFixed(0)} ms per call, model ${options.model}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
