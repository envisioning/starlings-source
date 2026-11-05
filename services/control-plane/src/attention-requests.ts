/**
 * Internal repository for #773. Route adapters must verify their own session /
 * thread membership before calling this module. Decision routes use it through
 * their compatibility adapter; chat question routes are connected separately.
 * The shared contract is the only snapshot shape; index columns are checked
 * against it by D1. An open-row compare-and-swap owns every terminal transition.
 */
import {
  attentionRequestID, attentionRequestSchema, isDecisionAskPastDefault, selectAttentionOptions,
  type AttentionRequest,
} from '@starlings/contracts';
import { ControlError } from './errors';

const lower = (email: string) => email.trim().toLowerCase();

export async function readAttentionRequest(db: D1Database, id: string): Promise<AttentionRequest> {
  const row = await db.prepare('SELECT snapshot FROM attention_requests WHERE id = ?1')
    .bind(id).first<{ snapshot: string }>();
  if (!row) throw new ControlError('No request with that id.', 404, 'request_not_found');
  return attentionRequestSchema.parse(JSON.parse(row.snapshot));
}

/** Immutable content excludes only resolution; retries cannot change a request. */
function content(request: AttentionRequest): string {
  const { state: _state, revision: _revision, answer: _answer, ...immutable } = request;
  return JSON.stringify(immutable);
}

/**
 * Persist a new source record or import a legacy snapshot, including terminal
 * records. Stable source identity is the creation key. A replay never resets
 * state or revision; conflicting reuse is an error, even after resolution.
 */
export async function ensureAttentionRequest(db: D1Database, snapshot: AttentionRequest): Promise<AttentionRequest> {
  const request = attentionRequestSchema.parse({
    ...snapshot, recipient_email: lower(snapshot.recipient_email), asked_by_email: lower(snapshot.asked_by_email),
    answer: snapshot.answer ? { ...snapshot.answer, answered_by_email: lower(snapshot.answer.answered_by_email) } : null,
  });
  if (request.id !== attentionRequestID(request.origin) || request.revision !== 0) {
    throw new ControlError('A new request needs its source id and revision zero.', 400, 'invalid_request');
  }
  await db.prepare(`INSERT INTO attention_requests (id, recipient_email, state, revision, created_at, snapshot)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(id) DO NOTHING`)
    .bind(request.id, request.recipient_email, request.state, request.revision, request.created_at, JSON.stringify(request)).run();
  const stored = await readAttentionRequest(db, request.id);
  if (content(stored) !== content(request)) {
    throw new ControlError('This source id already belongs to a different request.', 409, 'invalid_request');
  }
  return stored;
}

/**
 * Import a trusted legacy source, including an old worker's completed answer
 * during rollout. This reconciles a stored resolution, never a read receipt.
 * A canonical terminal winner always stands; only an open record may adopt it.
 */
export async function importAttentionRequest(db: D1Database, snapshot: AttentionRequest): Promise<AttentionRequest> {
  const stored = await ensureAttentionRequest(db, snapshot);
  if (stored.state !== 'open' || snapshot.state === 'open') return stored;
  const next = attentionRequestSchema.parse({ ...stored, state: snapshot.state, answer: snapshot.answer
    ? { ...snapshot.answer, answered_by_email: lower(snapshot.answer.answered_by_email) } : null, revision: stored.revision + 1 });
  await db.prepare(`UPDATE attention_requests SET state = ?2, revision = ?3, snapshot = ?4
    WHERE id = ?1 AND state = 'open' AND revision = ?5`)
    .bind(stored.id, next.state, next.revision, JSON.stringify(next), stored.revision).run();
  return readAttentionRequest(db, stored.id);
}

/** Storage order only. Presentation adapters owe the shared queue policy. Reads never resolve. */
export async function pendingAttentionRequests(db: D1Database, recipientEmail: string): Promise<AttentionRequest[]> {
  const { results } = await db.prepare(`SELECT snapshot FROM attention_requests
    WHERE recipient_email = ?1 AND state = 'open' ORDER BY created_at, id`)
    .bind(lower(recipientEmail)).all<{ snapshot: string }>();
  return results.map((row) => attentionRequestSchema.parse(JSON.parse(row.snapshot)));
}

/** Internal command, never a wire shape. Wire schemas belong in packages/contracts. */
export type AttentionResolution =
  | { action: 'answer'; option_ids: string[]; custom_text?: string; note?: string }
  | { action: 'dismiss' | 'withdraw' | 'apply_default' };

/**
 * Internal source adapter: its projection joins the same atomic D1 batch.
 * The projection must be guarded by the candidate snapshot and source state,
 * so a losing compare-and-swap cannot write it. SQL is authored by the adapter,
 * never provided by a caller over the wire.
 */
export interface AttentionResolutionTransaction {
  guard: { sql: string; values: unknown[] };
  projection: (request: AttentionRequest) => D1PreparedStatement;
}

/**
 * Only the recipient answers or dismisses. A question's author withdraws it;
 * decisions preserve their existing party permissions for withdrawal/default.
 * A terminal winner is returned unchanged on replay or a competing resolution.
 */
export async function resolveAttentionRequest(
  db: D1Database, id: string, actorEmail: string, command: AttentionResolution, now = Date.now(),
  transaction?: AttentionResolutionTransaction,
): Promise<{ request: AttentionRequest; accepted: boolean }> {
  const request = await readAttentionRequest(db, id);
  const actor = lower(actorEmail);
  const recipient = actor === request.recipient_email;
  const asker = actor === request.asked_by_email;
  const allowed = command.action === 'answer' || command.action === 'dismiss'
    ? recipient
    : command.action === 'withdraw'
      ? asker || (request.kind === 'decision' && recipient)
      : request.kind === 'decision' && (recipient || asker);
  if (!allowed) throw new ControlError('You cannot resolve this request.', 403, 'capability_denied');
  if (request.state !== 'open') return { request, accepted: false };

  let state: AttentionRequest['state'];
  let answer: AttentionRequest['answer'] = null;
  if (command.action === 'answer' || command.action === 'apply_default') {
    state = command.action === 'apply_default' ? 'defaulted' : 'answered';
    if (command.action === 'apply_default' && (!request.default_by || !isDecisionAskPastDefault(request.default_by, now))) {
      throw new ControlError('The default applies only after the default-by day.', 400, 'invalid_request');
    }
    const ids = command.action === 'answer' ? command.option_ids : [request.recommendation!];
    const custom = command.action === 'answer' ? command.custom_text?.trim() || null : null;
    const selected = custom === null ? selectAttentionOptions(request.selection_mode, request.options, ids) : [];
    if (!selected || (custom !== null && (!request.allows_custom_answer || ids.length > 0))) {
      throw new ControlError('Choose valid options for this request.', 400, 'invalid_request');
    }
    answer = {
      option_ids: selected.map((option) => option.id), option_labels: selected.map((option) => option.label),
      custom_text: custom, note: command.action === 'answer' ? command.note?.trim() || null : null,
      answered_by_email: actor, answered_at: new Date(now).toISOString(),
    };
  } else {
    state = command.action === 'dismiss' ? 'dismissed' : 'withdrawn';
  }
  const parsed = attentionRequestSchema.safeParse({ ...request, state, answer, revision: request.revision + 1 });
  if (!parsed.success) throw new ControlError('Invalid request answer.', 400, 'invalid_request');
  const next = parsed.data;
  const update = db.prepare(`UPDATE attention_requests SET state = ?, revision = ?, snapshot = ?
    WHERE id = ? AND state = 'open' AND revision = ?${transaction ? ` AND (${transaction.guard.sql})` : ''}`)
    .bind(next.state, next.revision, JSON.stringify(next), id, request.revision, ...(transaction?.guard.values ?? []));
  // A batch is one D1 transaction: legacy writers cannot slip between claiming
  // the canonical winner and closing its old-client projection.
  const result = transaction ? (await db.batch([update, transaction.projection(next)]))[0]! : await update.run();
  return { request: await readAttentionRequest(db, id), accepted: (result.meta.changes ?? 0) === 1 };
}

/** Existing message withdrawal erases a question's answer without reopening it. */
export async function retractQuestionAnswer(db: D1Database, id: string, actorEmail: string): Promise<void> {
  const request = await readAttentionRequest(db, id);
  if (request.kind !== 'question' || request.recipient_email !== lower(actorEmail)) {
    throw new ControlError('You cannot withdraw this answer.', 403, 'capability_denied');
  }
  if (request.state !== 'answered') return;
  const next = attentionRequestSchema.parse({ ...request, state: 'withdrawn', answer: null, revision: request.revision + 1 });
  await db.prepare(`UPDATE attention_requests SET state = ?2, revision = ?3, snapshot = ?4
    WHERE id = ?1 AND state = 'answered' AND revision = ?5`)
    .bind(id, next.state, next.revision, JSON.stringify(next), request.revision).run();
}
