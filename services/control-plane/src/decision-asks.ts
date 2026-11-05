// Open decisions — questions waiting on one member (migration 0063,
// docs/help/howto/answer-a-decision.md). An agent asks through MCP
// `ask_decision`; the member answers from INBOX on any client; the agent
// reads the answer back.
//
// The shared attention request owns resolution; decision_asks keeps the old
// client projection and Core sync metadata. Lazy imports preserve legacy state.
//
// The answer is stored first, always. A decision on a subject is then
// written to Core's decisions as the permanent record, best effort: a Core
// that is down keeps `core_decision_id` null and `core_error` set, and the
// same answer sent again retries the write. An answer is never lost to Core.
//
// The default-by day marks an open decision overdue. It is never applied on
// its own: `apply_default` is an explicit call, allowed once the day passed.

import { subjectAccessFor } from './subject-access';
import {
  DECISION_BODY_MAX_CHARS,
  attentionFromDecision,
  type AttentionRequest,
  type AttentionResolveResponse,
  decisionAskOptionLabel,
  isDecisionAskPastDefault,
  sortDecisionAsks,
  type CrmDecisionCreateInput,
  type DecisionAsk,
  type DecisionAskAnswerInput,
  type DecisionAskCreateInput,
  type DecisionAskOption,
  type DecisionAskStatus,
  type DecisionAsksQuery,
  type DecisionAskWithdrawInput,
  type InboxItem,
} from '@starlings/contracts';
import type { RoleSession } from './capabilities';
import { ControlError } from './errors';
import { importAttentionRequest, readAttentionRequest, resolveAttentionRequest, type AttentionResolutionTransaction } from './attention-requests';

/** Writes the permanent record in Core and answers its id. `index.ts` passes `recordDecision`, which also narrates. */
export type RecordCoreDecision = (body: CrmDecisionCreateInput) => Promise<{ id: string }>;

interface DecisionAskRow {
  id: string;
  waits_on_email: string;
  question: string;
  context: string | null;
  options: string;
  recommendation: string;
  default_by: string;
  subject_kind: string | null;
  subject_id: string | null;
  subject_title: string | null;
  links: string;
  asked_by_email: string;
  asked_by_label: string;
  created_at: number;
  status: DecisionAskStatus;
  answer: string | null;
  answer_note: string | null;
  answered_at: number | null;
  answered_by_email: string | null;
  core_decision_id: string | null;
  core_error: string | null;
  updated_at: number;
}

const COLUMNS = `id, waits_on_email, question, context, options, recommendation, default_by, subject_kind, subject_id, subject_title,
  links, asked_by_email, asked_by_label, created_at, status, answer, answer_note, answered_at, answered_by_email,
  core_decision_id, core_error, updated_at`;

function parseJSON<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

export function decisionAskFromRow(row: DecisionAskRow, now = Date.now()): DecisionAsk {
  const options = parseJSON<DecisionAskOption[]>(row.options, []);
  const links = parseJSON<Array<{ url: string; title?: string | null }>>(row.links, []);
  const subjectKind = row.subject_kind as 'lead' | 'project' | 'organization' | 'event' | null;
  return {
    id: row.id,
    status: row.status,
    question: row.question,
    context: row.context,
    options,
    recommendation: row.recommendation,
    default_by: row.default_by,
    overdue: row.status === 'open' && isDecisionAskPastDefault(row.default_by, now),
    subject: subjectKind && row.subject_id ? { kind: subjectKind, id: row.subject_id, title: row.subject_title } : null,
    links: links.map((link) => ({ url: link.url, title: link.title ?? null })),
    waits_on_email: row.waits_on_email,
    asked_by: row.asked_by_label,
    asked_by_email: row.asked_by_email,
    created_at: new Date(row.created_at).toISOString(),
    answer: row.answer,
    answer_label: decisionAskOptionLabel({ options }, row.answer),
    answer_note: row.answer_note,
    answered_at: iso(row.answered_at),
    answered_by_email: row.answered_by_email,
    core_decision_id: row.core_decision_id,
  };
}

async function readRawRow(env: Env, id: string): Promise<DecisionAskRow> {
  const row = await env.USAGE.prepare(`SELECT ${COLUMNS} FROM decision_asks WHERE id = ?1`).bind(id).first<DecisionAskRow>();
  if (!row) throw new ControlError('No decision with that id.', 404, 'request_not_found');
  return row;
}

/** Old clients lack dismissed: it projects as withdrawn without inventing an answer. */
function projectAttention(row: DecisionAskRow, request: AttentionRequest): DecisionAskRow {
  const answer = request.answer;
  return {
    ...row, status: request.state === 'dismissed' ? 'withdrawn' : request.state,
    answer: answer ? answer.option_ids[0] ?? answer.custom_text : null,
    answer_note: answer ? answer.note : row.answer_note,
    answered_at: answer ? Date.parse(answer.answered_at) : row.answered_at,
    answered_by_email: answer ? answer.answered_by_email : row.answered_by_email,
    updated_at: answer ? Math.max(row.updated_at, Date.parse(answer.answered_at)) : row.updated_at,
  };
}

/** Request links preserve subject visibility and the standalone party boundary. */
export async function readDecisionAskForOwner(env: Env, owner: RoleSession, id: string): Promise<DecisionAsk> {
  const row = await readRow(env, id);
  if (row.subject_kind && row.subject_id) (await subjectAccessFor(env, owner)).requireSee(row.subject_kind, row.subject_id);
  else assertParty(owner, row);
  return decisionAskFromRow(row);
}

/** Lazy imports keep legacy terminal records terminal. Reads never resolve a request. */
async function authoritativeRow(env: Env, row: DecisionAskRow): Promise<DecisionAskRow> {
  const request = await importAttentionRequest(env.USAGE, attentionFromDecision(decisionAskFromRow(row)));
  return projectAttention(row, request);
}

async function readRow(env: Env, id: string): Promise<DecisionAskRow> {
  return authoritativeRow(env, await readRawRow(env, id));
}

/**
 * This row is a compatibility/Core-metadata projection, not a second authority.
 * Reads and queries consult the canonical winner even if this write fails.
 */
function projectionStatement(env: Env, row: DecisionAskRow, request?: AttentionRequest): D1PreparedStatement {
  return env.USAGE.prepare(`UPDATE decision_asks SET status = ?2, answer = ?3,
    answer_note = CASE WHEN ?2 = 'withdrawn' THEN COALESCE(answer_note, ?4) ELSE ?4 END,
    answered_at = CASE WHEN ?2 = 'withdrawn' THEN COALESCE(answered_at, ?5) ELSE ?5 END,
    answered_by_email = CASE WHEN ?2 = 'withdrawn' THEN COALESCE(answered_by_email, ?6) ELSE ?6 END,
    updated_at = MAX(updated_at, ?7) WHERE id = ?1${request ? ` AND status = 'open'
      AND EXISTS (SELECT 1 FROM attention_requests WHERE id = ?8 AND snapshot = ?9)` : ''}`)
    .bind(row.id, row.status, row.answer, row.answer_note, row.answered_at, row.answered_by_email, row.updated_at,
      ...(request ? [request.id, JSON.stringify(request)] : []));
}

async function saveProjection(env: Env, row: DecisionAskRow): Promise<void> {
  await projectionStatement(env, row).run();
}

function decisionTransaction(env: Env, row: DecisionAskRow, metadata: Partial<DecisionAskRow> = {}): AttentionResolutionTransaction {
  return {
    guard: { sql: "EXISTS (SELECT 1 FROM decision_asks WHERE id = ? AND status = 'open')", values: [row.id] },
    projection: (request) => projectionStatement(env, { ...projectAttention(row, request), ...metadata }, request),
  };
}

// Decision ids minted by Meet are UUIDs: escaping leaves these source ids unchanged.
const EFFECTIVE_ANSWER_AT = `COALESCE((SELECT ROUND((julianday(json_extract(snapshot, '$.answer.answered_at')) - 2440587.5) * 86400000)
  FROM attention_requests WHERE id = 'decision:' || decision_asks.id), answered_at)`;
const EFFECTIVE_STATUS = `COALESCE((SELECT CASE WHEN state = 'open' THEN decision_asks.status WHEN state = 'dismissed' THEN 'withdrawn' ELSE state END
  FROM attention_requests WHERE id = 'decision:' || decision_asks.id), status)`;

const lower = (email: string) => email.trim().toLowerCase();

/** An ask on a subject is a write there (docs/ACCESS.md): the caller must reach the subject to file, answer or withdraw it. */
async function requireSubjectWrite(env: Env, owner: RoleSession, kind: string | null, id: string | null): Promise<void> {
  if (!kind || !id) return;
  (await subjectAccessFor(env, owner)).requireWrite(kind, id);
}

/** The asker or the member it waits on; nobody else changes an ask. */
function assertParty(owner: RoleSession, row: DecisionAskRow): void {
  const me = lower(owner.email);
  if (me !== row.waits_on_email && me !== row.asked_by_email) {
    throw new ControlError('Only the member it waits on, or whoever asked, can change this decision.', 403, 'capability_denied');
  }
}

export async function createDecisionAsk(env: Env, owner: RoleSession, input: DecisionAskCreateInput): Promise<DecisionAsk> {
  await requireSubjectWrite(env, owner, input.subject?.kind ?? null, input.subject?.id ?? null);
  const me = lower(owner.email);
  const waitsOn = input.waits_on ? lower(input.waits_on) : me;
  if (waitsOn !== me) {
    // Somebody else's queue: only a person in the roster, never an agent.
    const person = await env.USAGE.prepare(
      "SELECT email FROM people WHERE lower(email) = ?1 AND kind = 'human' AND revoked_at IS NULL",
    ).bind(waitsOn).first<{ email: string }>();
    if (!person) throw new ControlError('Nobody on the roster has that address.', 404, 'person_not_found');
  }
  const now = Date.now();
  const id = crypto.randomUUID();
  const label = input.asked_by ?? (owner.name?.trim() || owner.email);
  await env.USAGE.prepare(
    `INSERT INTO decision_asks (id, waits_on_email, question, context, options, recommendation, default_by, subject_kind, subject_id,
       subject_title, links, asked_by_email, asked_by_label, created_at, status, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 'open', ?14)`,
  ).bind(
    id,
    waitsOn,
    input.question,
    input.context ?? null,
    JSON.stringify(input.options),
    input.recommendation,
    input.default_by,
    input.subject?.kind ?? null,
    input.subject?.id ?? null,
    input.subject?.title ?? null,
    JSON.stringify((input.links ?? []).map((link) => ({ url: link.url, title: link.title ?? null }))),
    me,
    label,
    now,
  ).run();
  return decisionAskFromRow(await readRow(env, id), now);
}

/**
 * Yours — asked by you or waiting on you — or, with a subject, every one
 * on that subject: the subject's readers are every member with Work.
 */
export async function listDecisionAsks(env: Env, owner: RoleSession, query: DecisionAsksQuery): Promise<DecisionAsk[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  const bind = (value: unknown) => {
    binds.push(value);
    return `?${binds.length}`;
  };
  if (query.subject_kind && query.subject_id) {
    where.push(`subject_kind = ${bind(query.subject_kind)} AND subject_id = ${bind(query.subject_id)}`);
  } else if (query.subject_kind || query.subject_id) {
    throw new ControlError('Pass both subject_kind and subject_id, or neither.', 400, 'invalid_request');
  } else {
    const me = bind(lower(owner.email));
    where.push(`(waits_on_email = ${me} OR asked_by_email = ${me})`);
  }
  if (query.status === 'resolved') where.push(`${EFFECTIVE_STATUS} IN ('answered', 'defaulted')`);
  else if (query.status !== 'all') where.push(`${EFFECTIVE_STATUS} = ${bind(query.status)}`);
  if (query.since) where.push(`${EFFECTIVE_ANSWER_AT} >= ${bind(Date.parse(query.since))}`);
  const { results } = await env.USAGE.prepare(
    `SELECT ${COLUMNS} FROM decision_asks WHERE ${where.join(' AND ')} ORDER BY MAX(updated_at, COALESCE(${EFFECTIVE_ANSWER_AT}, updated_at)) DESC LIMIT ${bind(query.limit)}`,
  ).bind(...binds).all<DecisionAskRow>();
  const now = Date.now();
  const access = await subjectAccessFor(env, owner);
  const asks = access.filter(
    await Promise.all(results.map(async (row) => decisionAskFromRow(await authoritativeRow(env, row), now))),
    (ask) => ask.subject,
  );
  // Open ones in queue order; the rest newest change first, as read.
  const matching = asks.filter((ask) => query.status === 'all' || (query.status === 'resolved'
    ? ask.status === 'answered' || ask.status === 'defaulted' : ask.status === query.status));
  return query.status === 'open' ? sortDecisionAsks(matching) : matching;
}

/** The Core record's body: the question and what was chosen, then the note. */
function coreBody(row: DecisionAskRow, defaulted: boolean): string {
  const options = parseJSON<DecisionAskOption[]>(row.options, []);
  const chosen = decisionAskOptionLabel({ options }, row.answer) ?? row.answer ?? '';
  const head = `${row.question} → ${chosen}${defaulted ? ' (the recommendation, applied after the default-by day)' : ''}`;
  const body = row.answer_note ? `${head}\n\n${row.answer_note}` : head;
  return body.length > DECISION_BODY_MAX_CHARS ? `${body.slice(0, DECISION_BODY_MAX_CHARS - 1)}…` : body;
}

/**
 * The permanent record, once. Best effort: a failure is kept on the row and
 * the answer stands. Nothing to write without a subject.
 */
async function writeCoreDecision(env: Env, row: DecisionAskRow, record: RecordCoreDecision | null): Promise<DecisionAskRow> {
  if (row.core_decision_id || !row.subject_kind || !row.subject_id) return row;
  if (row.status !== 'answered' && row.status !== 'defaulted') return row;
  const now = Date.now();
  if (!record) {
    await env.USAGE.prepare('UPDATE decision_asks SET core_error = ?2, updated_at = ?3 WHERE id = ?1')
      .bind(row.id, 'CRM sync is not configured.', now).run();
    return { ...row, core_error: 'CRM sync is not configured.', updated_at: now };
  }
  try {
    const decision = await record({
      subject_kind: row.subject_kind as CrmDecisionCreateInput['subject_kind'],
      subject_id: row.subject_id,
      body: coreBody(row, row.status === 'defaulted'),
      source: 'manual',
      source_ref: row.id,
    });
    await env.USAGE.prepare('UPDATE decision_asks SET core_decision_id = ?2, core_error = NULL, updated_at = ?3 WHERE id = ?1')
      .bind(row.id, decision.id, now).run();
    return { ...row, core_decision_id: decision.id, core_error: null, updated_at: now };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.warn(JSON.stringify({ level: 'warn', message: 'decision_ask.core_write.failed', id: row.id, error: message }));
    await env.USAGE.prepare('UPDATE decision_asks SET core_error = ?2, updated_at = ?3 WHERE id = ?1')
      .bind(row.id, message.slice(0, 500), now).run();
    return { ...row, core_error: message, updated_at: now };
  }
}

/** The stored answer: an option key when it names one (case-blind), else the member's words. */
function normalizedAnswer(row: DecisionAskRow, answer: string): string {
  const options = parseJSON<DecisionAskOption[]>(row.options, []);
  const key = options.find((option) => option.key === answer.toLowerCase())?.key;
  return key ?? answer;
}

export async function answerDecisionAsk(
  env: Env,
  owner: RoleSession,
  id: string,
  input: DecisionAskAnswerInput,
  record: RecordCoreDecision | null,
): Promise<DecisionAsk> {
  return (await answerDecisionAskWithResult(env, owner, id, input, record)).ask;
}

export async function answerDecisionAskWithResult(
  env: Env,
  owner: RoleSession,
  id: string,
  input: DecisionAskAnswerInput,
  record: RecordCoreDecision | null,
): Promise<{ ask: DecisionAsk; accepted: boolean }> {
  const row = await readRow(env, id);
  await requireSubjectWrite(env, owner, row.subject_kind, row.subject_id);
  if (lower(owner.email) !== row.waits_on_email) {
    throw new ControlError(`Only ${row.waits_on_email} can answer this decision.`, 403, 'capability_denied');
  }
  const answer = normalizedAnswer(row, input.answer);
  const note = input.note?.trim() || null;
  if (row.status !== 'open') {
    // The same answer again is a retry: it owes nothing but the Core write.
    if ((row.status === 'answered' || row.status === 'defaulted') && row.answer === answer) {
      await saveProjection(env, row);
      return { ask: decisionAskFromRow(await writeCoreDecision(env, row, record)), accepted: false };
    }
    throw new ControlError(`This decision is already ${row.status}.`, 409, 'request_already_decided');
  }
  const option = parseJSON<DecisionAskOption[]>(row.options, []).find((choice) => choice.key === answer);
  const result = await resolveAttentionRequest(env.USAGE, attentionFromDecision(decisionAskFromRow(row)).id, owner.email, {
    action: 'answer', option_ids: option ? [option.key] : [], ...(option ? {} : { custom_text: answer }),
    ...(note ? { note } : {}),
  }, Date.now(), decisionTransaction(env, row));
  const winner = result.request.state === 'open' ? await readRow(env, id) : projectAttention(row, result.request);
  if (winner.status !== 'answered' || winner.answer !== answer) {
    throw new ControlError(`This decision is already ${winner.status}.`, 409, 'request_already_decided');
  }
  await saveProjection(env, winner);
  return { ask: decisionAskFromRow(await writeCoreDecision(env, winner, record)), accepted: result.accepted };
}

/** Dismissal closes the compatibility row in the same guarded transaction. */
export async function dismissDecisionAsk(env: Env, owner: RoleSession, id: string): Promise<AttentionResolveResponse> {
  const row = await readRow(env, id);
  await requireSubjectWrite(env, owner, row.subject_kind, row.subject_id);
  if (lower(owner.email) !== row.waits_on_email) {
    throw new ControlError('Only the recipient can dismiss this decision.', 403, 'capability_denied');
  }
  const requestID = attentionFromDecision(decisionAskFromRow(row)).id;
  const result = await resolveAttentionRequest(env.USAGE, requestID, owner.email,
    { action: 'dismiss' }, Date.now(), decisionTransaction(env, row));
  if (result.request.state === 'open') {
    // A legacy writer won the source guard. Import that winner before returning.
    await readRow(env, id);
    return { request: await readAttentionRequest(env.USAGE, requestID), accepted: false };
  }
  return result;
}

export async function withdrawDecisionAsk(env: Env, owner: RoleSession, id: string, input: DecisionAskWithdrawInput): Promise<DecisionAsk> {
  const row = await readRow(env, id);
  assertParty(owner, row);
  await requireSubjectWrite(env, owner, row.subject_kind, row.subject_id);
  if (row.status === 'withdrawn') {
    await saveProjection(env, row);
    return decisionAskFromRow(row);
  }
  if (row.status !== 'open') throw new ControlError(`This decision is already ${row.status}.`, 409, 'request_already_decided');
  const now = Date.now();
  const result = await resolveAttentionRequest(env.USAGE, attentionFromDecision(decisionAskFromRow(row)).id, owner.email, { action: 'withdraw' }, now,
    decisionTransaction(env, row, { answer_note: input.reason?.trim() || null, answered_at: now,
      answered_by_email: lower(owner.email), updated_at: now }));
  if (!result.accepted) {
    const current = await readRow(env, id);
    throw new ControlError(`This decision is already ${current.status}.`, 409, 'request_already_decided');
  }
  const winner = { ...projectAttention(row, result.request), answer_note: input.reason?.trim() || null,
    answered_at: now, answered_by_email: lower(owner.email), updated_at: now };
  await saveProjection(env, winner);
  return decisionAskFromRow(winner);
}

/** The recommendation, applied by hand once the default-by day has passed. */
export async function applyDecisionAskDefault(env: Env, owner: RoleSession, id: string, record: RecordCoreDecision | null): Promise<DecisionAsk> {
  const row = await readRow(env, id);
  assertParty(owner, row);
  await requireSubjectWrite(env, owner, row.subject_kind, row.subject_id);
  if (row.status === 'defaulted') {
    await saveProjection(env, row);
    return decisionAskFromRow(await writeCoreDecision(env, row, record));
  }
  if (row.status !== 'open') throw new ControlError(`This decision is already ${row.status}.`, 409, 'request_already_decided');
  const now = Date.now();
  if (!isDecisionAskPastDefault(row.default_by, now)) {
    throw new ControlError(`The default applies after ${row.default_by}. Until then only the member can answer.`, 400, 'invalid_request');
  }
  const result = await resolveAttentionRequest(env.USAGE, attentionFromDecision(decisionAskFromRow(row)).id, owner.email, { action: 'apply_default' }, now, decisionTransaction(env, row));
  const winner = result.request.state === 'open' ? await readRow(env, id) : projectAttention(row, result.request);
  if (winner.status !== 'defaulted') throw new ControlError(`This decision is already ${winner.status}.`, 409, 'request_already_decided');
  await saveProjection(env, winner);
  return decisionAskFromRow(await writeCoreDecision(env, winner, record));
}

/** INBOX: every open decision waiting on this member, in queue order. */
export async function decisionInboxItems(env: Env, owner: RoleSession): Promise<InboxItem[]> {
  const { results } = await env.USAGE.prepare(
    `SELECT ${COLUMNS} FROM decision_asks WHERE waits_on_email = ?1 AND ${EFFECTIVE_STATUS} = 'open' ORDER BY created_at ASC LIMIT 200`,
  ).bind(lower(owner.email)).all<DecisionAskRow>();
  const now = Date.now();
  const asks = await Promise.all(results.map(async (row) => decisionAskFromRow(await authoritativeRow(env, row), now)));
  return sortDecisionAsks(asks.filter((ask) => ask.status === 'open'))
    .map((ask): InboxItem => ({ key: `decision:${ask.id}`, at: Date.parse(ask.created_at), source: 'decision', ask }));
}
