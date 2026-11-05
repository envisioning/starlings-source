// Permission-checked projections of canonical requests. Source adapters own
// replies and Core effects; public commands never bypass their existing gates.
import {
  attentionFromDecision, attentionRequestSchema, sortAttentionRequests, selectAttentionOptions,
  type AttentionRequest, type AttentionListQuery, type AttentionResolveInput, type AttentionResolveResponse,
} from '@starlings/contracts';
import type { RoleSession } from './capabilities';
import { ControlError } from './errors';
import { readAttentionRequest, resolveAttentionRequest } from './attention-requests';
import { answerThreadQuestion, assertAttentionThreadAccess } from './threads';
import { answerDecisionAskWithResult, dismissDecisionAsk, decisionInboxItems, readDecisionAskForOwner, type RecordCoreDecision } from './decision-asks';

export async function readAttentionForOwner(env: Env, owner: RoleSession, id: string): Promise<AttentionRequest> {
  const request = await readAttentionRequest(env.USAGE, id);
  if (request.origin.type === 'thread_question') {
    await assertAttentionThreadAccess(env, owner, request.origin.thread_id);
  } else {
    await readDecisionAskForOwner(env, owner, request.origin.decision_id);
  }
  return readAttentionRequest(env.USAGE, id);
}

export async function listAttentionForOwner(env: Env, owner: RoleSession, query: AttentionListQuery): Promise<AttentionRequest[]> {
  if (query.thread_id) await assertAttentionThreadAccess(env, owner, query.thread_id);
  else await decisionInboxItems(env, owner); // import legacy open decisions without reopening terminal ones
  const binds: unknown[] = [];
  const bind = (value: unknown) => { binds.push(value); return `?${binds.length}`; };
  const where = query.thread_id
    ? [`json_extract(snapshot, '$.origin.thread_id') = ${bind(query.thread_id)}`]
    : [`recipient_email = ${bind(owner.email.trim().toLowerCase())}`];
  if (query.state === 'open') where.push("state = 'open'");
  if (query.subject_kind && query.subject_id) {
    where.push(`json_extract(snapshot, '$.subject.kind') = ${bind(query.subject_kind)}`,
      `json_extract(snapshot, '$.subject.id') = ${bind(query.subject_id)}`);
  }
  const { results } = await env.USAGE.prepare(`SELECT snapshot FROM attention_requests WHERE ${where.join(' AND ')} ORDER BY created_at, id`)
    .bind(...binds).all<{ snapshot: string }>();
  const readable: AttentionRequest[] = [];
  for (const row of results) {
    const request = attentionRequestSchema.parse(JSON.parse(row.snapshot));
    try { readable.push(await readAttentionForOwner(env, owner, request.id)); }
    catch (error) {
      if (error instanceof ControlError && (error.status === 403 || error.status === 404)) continue;
      throw error; // a failed store must not look like a quiet queue
    }
  }
  return sortAttentionRequests(readable.filter((request) => query.state === 'all' || request.state === 'open'));
}

export async function resolveAttentionForOwner(
  env: Env, owner: RoleSession, id: string, command: AttentionResolveInput, record: RecordCoreDecision | null, ctx?: ExecutionContext,
): Promise<AttentionResolveResponse> {
  const request = await readAttentionForOwner(env, owner, id);
  if (request.recipient_email !== owner.email.trim().toLowerCase()) {
    throw new ControlError('Only the recipient can answer or dismiss this request.', 403, 'capability_denied');
  }
  if (command.action === 'dismiss') {
    return request.origin.type === 'decision'
      ? dismissDecisionAsk(env, owner, request.origin.decision_id)
      : resolveAttentionRequest(env.USAGE, id, owner.email, { action: 'dismiss' });
  }
  if (request.kind === 'question') {
    if (command.custom_text || command.note) throw new ControlError('A question requires its listed choices.', 400, 'invalid_request');
    if (request.state !== 'open') return { request, accepted: false };
    if (request.origin.type !== 'thread_question') throw new Error('Invalid question origin.');
    try {
      const result = await answerThreadQuestion(owner, env, request.origin.thread_id, request.origin.message_id, command.option_ids, ctx);
      return { request: await readAttentionRequest(env.USAGE, id), accepted: result.accepted };
    } catch (error) {
      if (error instanceof ControlError && error.status === 409) {
        const winner = await readAttentionRequest(env.USAGE, id);
        if (winner.state !== 'open') return { request: winner, accepted: false };
      }
      throw error;
    }
  }
  if (request.origin.type !== 'decision') throw new Error('Invalid decision origin.');
  const selected = command.custom_text ? [] : selectAttentionOptions('single', request.options, command.option_ids);
  if (!selected || (command.custom_text && command.option_ids.length)) throw new ControlError('Choose a valid answer.', 400, 'invalid_request');
  const answer = command.custom_text ?? selected[0]?.id;
  if (!answer) throw new ControlError('Choose a valid answer.', 400, 'invalid_request');
  try {
    const result = await answerDecisionAskWithResult(env, owner, request.origin.decision_id, { answer, note: command.note }, record);
    return { request: await readAttentionRequest(env.USAGE, attentionFromDecision(result.ask).id), accepted: result.accepted };
  } catch (error) {
    if (error instanceof ControlError && error.status === 409) return { request: await readAttentionRequest(env.USAGE, id), accepted: false };
    throw error;
  }
}
