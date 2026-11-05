// The one door something outside Meet may write a conversation through.
//
// Every other trust edge in this Worker runs outward: `signedCoreFetch` calls
// Core, the artifact queue calls email, the room calls LiveKit. This is the
// reverse, and it is the only route where a caller with no session can put
// words in front of a person. Treat it the way `/api/dev/session` is treated.
//
// Two callers, one route (docs/AGENTS_SURFACE.md, docs/CHANNELS.md §Webhook):
//
// - **Core's GitHub webhook** posts `type: 'event'` with no sender — a quiet
//   system line in a project channel, exactly what `postSubjectEvent` writes.
// - **An agent** posts `type: 'text'` and names itself, which is resolved
//   against `AGENT_ROSTER` here. The caller never chooses a sender freely and
//   a human address is refused, so possession of the secret does not let
//   anything speak as a colleague.
//
// Four locks, in this order: the route does not exist without its secret; a
// request carrying any session token is refused outright; the burst guard;
// then the signature over timestamp and body, inside a clock window.

import { isGuestThread, takeMachineTurn } from './guests';
import { agentsReachingThread } from './subject-access';
import { touchConnector } from './import-ledger';
import {
  INTERNAL_SIGNATURE_SKEW_MILLISECONDS,
  internalChannelEventSchema,
  internalKeepReleaseFetchSchema,
  type InternalChannelEventInput,
  type InternalChannelEventResponse,
  type InternalKeepReleaseFetchResponse,
  type InternalPingResponse,
  type ThreadMessageRef,
} from './contracts';
import { purgeCoreCache, subjectCacheKeys } from './core-cache';
import { isFinished, writeStage, type WorkStage } from '@starlings/contracts/work-items';
import { agentFreeze, frozenMessage } from './agent-freezes';
import { recordCardHold } from './card-holds';
import { agentByEmail, clearWorking, recordAgentActivity, runCards } from './agents';
import { fetchCrmIssue, githubIssuesEnabled, updateCrmTask, workModelEnabled, writeCrmIssue } from './crm';
import { constantTimeEqualSync, hmacSHA256Hex } from './crypto';
import { bindInboundIdentity, resolveInboundKey, type InboundCaller } from './inbound-keys';
import { CORE_CALLER, recordInboundAccepted, recordInboundRefusal } from './ops';
import { AuthError, ControlError } from './errors';
import { exchangeKeepToken, fetchKeepRelease, keepEnabled, readKeepRelease } from './keep';
import { assertUnderRateLimit, readBoundedText } from './http';
import {
  appendInboundMessage,
  inboundMessageId,
  messageSender,
  postIssueEvent,
  resolveSubjectThread,
  threadEventSender,
  threadStub,
  type GithubIssueVerb,
} from './threads';

// The secret is not one value for every caller: `resolveInboundKey`
// picks it by `x-internal-key-id`, and `bindInboundIdentity` holds each key to
// the one identity it may claim. Still separate from `INTERNAL_REQUEST_SECRET`,
// deliberately: that one is the Meet -> Core pair, and anything able to call
// Core as Meet must not also be able to write into a conversation. A request
// with no key id answers 404, not 401: a door should not advertise itself.

export async function handleInternalChannelEvent(
  request: Request,
  env: Env,
): Promise<InternalChannelEventResponse> {
  const caller = await resolveInboundKey(request, env);

  // A session token here is a caller confusing two doors, and the only way a
  // guest, lobby, booking, or artifact principal could ever reach this code.
  // Refusing the header outright is stronger than checking which kind it is.
  if (request.headers.get('authorization')) {
    throw new AuthError('This route does not take a session.', 403, 'owner_auth_required');
  }
  await assertUnderRateLimit(env.AGENT_LIMIT, request, 'internal-channel-event');

  const rawBody = await readBoundedText(request);
  await assertSignature(request, caller, rawBody, env);

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody === '' ? '{}' : rawBody);
  } catch {
    throw new ControlError('Request body must be valid JSON.', 400, 'invalid_request');
  }
  const body = internalChannelEventSchema.parse(parsed);
  // The key may only claim its own identity: Core's names no sender, an
  // agent's names itself and nobody else.
  await bindInboundIdentity(env, caller, 'channel-events', body.sender ?? null);
  // Core's calls name no sender; an agent's do. The hourly cron reads this
  // to say when Core has gone quiet.
  if (!body.sender) await recordInboundAccepted(env, CORE_CALLER);

  // The sender is resolved, never accepted. An address that is not in the
  // roster is refused whether or not somebody by that name exists in `people`
  // — which is what stops a leaked secret from writing as a colleague.
  const sender = body.sender ? (await agentByEmail(env, body.sender)) : null;
  if (body.sender && !sender) {
    throw new AuthError('Unknown sender.', 403, 'owner_auth_required');
  }
  // A frozen agent says nothing. Read on every call, and a read
  // that fails throws, so a freeze is never skipped.
  if (sender && await agentFreeze(env, sender.sub)) {
    throw new AuthError(frozenMessage(sender.name), 403, 'capability_denied');
  }
  // Delivery is not acceptance (docs/OWNERSHIP.md decisions 12 and 13). An
  // agent takes a card as far as Review and a person accepts it, so a move to
  // Done or Dropped is refused before anything is written, and the runtime
  // moves the card to Review instead. A member's own Claude never comes
  // through this door: it acts as the member through /mcp.
  if (body.move && isFinished(body.move.stage)) {
    throw new AuthError('An agent moves a card as far as Review. A person accepts it.', 403, 'capability_denied');
  }

  // Where it lands. A subject is resolved here so a runtime narrating work on
  // a project never has to know a channel id — the same find-or-create a
  // person opening the channel gets, with the same 404 for a subject Core
  // does not have.
  // With both, `thread_id` is the address and `subject` names the project a
  // move is about — see the schema's refinement.
  let threadId = body.thread_id;
  if (!threadId) {
    threadId = (await resolveSubjectThread(env, body.subject!)).id;
  }
  // An agent writes into a restricted subject's channel only with a `write`
  // grant there (docs/ACCESS.md slice 2); the same 404 as a missing subject.
  if (sender) {
    const reaching = await agentsReachingThread(env, threadId, 'write');
    if (reaching && !reaching.has(sender.sub)) throw new ControlError('No such subject.', 404, 'subject_not_found');
    // Our agent writing where another company's Claude reads: a machine turn.
    if (await isGuestThread(env, threadId)) await takeMachineTurn(env, threadId);
  }
  const messageId = await inboundMessageId(threadId, body.idempotency_key);
  // Core's GitHub webhook and an agent's move are the news the board's cached
  // pages for this subject do not yet know (core-cache.ts).
  if (body.subject) await purgeCoreCache(subjectCacheKeys(body.subject));
  const refs = (body.refs ?? []) as ThreadMessageRef[];
  // An agent's line that names no card is about the card its run was handed
  // (migration 0109), so the task page finds it. A move names its own.
  if (sender && !body.move && !refs.some((ref) => ref.kind === 'task' || ref.kind === 'issue')) {
    refs.push(...await runCards(env, sender.sub, threadId));
  }
  // A line with no sender carrying a GitHub ref is Core's webhook edge
  // reporting; the connector card reads this pulse for its stale check.
  if (!sender && refs.some((ref) => ref.kind === 'issue' || ref.kind === 'pull' || ref.kind === 'commit' || ref.kind === 'run' || ref.kind === 'release')) {
    await touchConnector(env, 'github', 'webhook');
  }

  let moved: MovedIssue | null = null;
  if (body.move && sender) {
    // The move is made before the line that reports it, so a Core outage
    // leaves no event claiming something that did not happen — the runtime
    // retries the whole call with the same key. A retry that lands after
    // both succeeded finds its message already there and moves nothing twice.
    const already = await messageSender(env, threadId, sender.sub, messageId);
    if (!already) {
      const actor = await resolveMoveActor(env, sender.sub, body.in_reply_to!);
      moved = await moveCard(env, body.move.ref, body.move.stage, actor);
      // The person whose authority the move used holds the card; a Review or
      // Blocked card raises their INBOX row (card-holds.ts).
      await recordCardHold(env, {
        refKind: body.move.ref.kind as 'task' | 'issue',
        refId: body.move.ref.id,
        holderEmail: actor,
        agentEmail: sender.email,
        subject: body.subject ? { kind: body.subject.kind, id: body.subject.id } : null,
      });
    }
    if (!refs.some((ref) => ref.kind === body.move!.ref.kind && ref.id === body.move!.ref.id)) {
      refs.push({ kind: body.move.ref.kind, id: body.move.ref.id });
    }
  }

  // Moved before the line lands, as an explicit move is: a Core outage
  // leaves no line claiming a stage the card is not in. A retry, or the final
  // post of a streamed answer, finds `auto_stage` already there and moves
  // nothing twice.
  if (sender && !body.move && body.partial !== true) {
    await advanceRunCards(env, sender, threadId, body.question ? 'blocked' : body.type === 'event' ? 'doing' : 'review');
  }

  const result = await appendInboundMessage(env, {
    threadId,
    messageId,
    sender: sender ?? threadEventSender(env),
    text: body.text,
    type: body.type,
    refs,
    partial: body.partial === true,
    ...(body.question ? { question: body.question } : {}),
    ...(body.question_recipient_email ? { questionRecipientEmail: body.question_recipient_email } : {}),
    ...(body.release_request ? { releaseRequest: body.release_request } : {}),
  });

  // An agent closing an issue is the project's news whether or not the agent
  // was talking in the project's channel at the time — and a runtime answering
  // a hand-off is usually in a DM, where the channel would otherwise never
  // hear about it. So the same line a person's close leaves gets written here
  // too, unless the agent's own line already landed in that very channel, in
  // which case the channel has been told once and does not need telling twice.
  //
  // `body.subject` is the only thing that can say which project: GitHub's issue
  // does not know about ours, and there is no repository-to-project lookup. A
  // runtime that moves a card without naming a subject still moves it — the
  // channel simply hears nothing, the same gap a person's move from Mine has.
  if (moved && body.subject?.kind === 'project') {
    const { id: subjectThreadId } = await resolveSubjectThread(env, body.subject);
    if (subjectThreadId !== threadId) {
      await postIssueEvent(env, {
        projectID: body.subject.id,
        // The person the agent borrowed authority from is the actor on the
        // write; the line says the agent, because the agent is what moved it.
        actor: sender!.name,
        owner: moved.owner,
        repo: moved.repo,
        number: moved.number,
        title: moved.title,
        verb: moved.verb,
      });
    }
  }

  // Answering is the end of working. Cleared even on a duplicate: a retry that
  // lands after the first answer means the agent is answering, whichever copy
  // of it won. An event is not an answer — "moved #142 to Doing" is said
  // mid-run — so it leaves the row as it was. Nor is a partial: the answer is
  // still being written, and the pane draws it growing *under* the working
  // row until the final post lands.
  if (sender && body.type === 'text' && !result.partial) {
    const repliedAt = Date.now();
    await recordAgentActivity(env, {
      eventId: `${sender.sub}:${result.messageId}:reply`,
      runId: body.in_reply_to ? `${sender.sub}:${body.in_reply_to.message_id}` : null,
      agentSub: sender.sub,
      threadId,
      sourceMessageId: result.messageId,
      kind: 'reply',
      occurredAt: repliedAt,
    });
    await clearWorking(env, sender.sub, threadId);
  }

  // Kind and thread only — never the text, and never the sender's address.
  console.log(JSON.stringify({
    level: 'info',
    message: 'internal.channel-event.accepted',
    type: body.type,
    moved: Boolean(body.move),
    duplicate: result.duplicate,
    partial: result.partial,
  }));

  return { ok: true, message_id: result.messageId, thread_id: threadId, duplicate: result.duplicate };
}

/**
 * An agent fetches the Keep release a member approved on its card (,
 * ADR 0007 decision 5). The agent never holds a Keep token: there is no
 * broker yet, so Meet mints an `agent` token at Keep for this one
 * call, fetches, and drops it. What comes back is sealed to the session key
 * the agent made for the request; Meet cannot open it.
 *
 * The same locks as channel-events, then: only an agent's own key (never
 * Core's), the card must be this agent's own release request, and the card
 * must say a member approved it. Keep then holds the real line: one fetch,
 * the named agent, before the expiry.
 */
export async function handleInternalKeepRelease(request: Request, env: Env): Promise<InternalKeepReleaseFetchResponse> {
  const caller = await resolveInboundKey(request, env);
  if (request.headers.get('authorization')) {
    throw new AuthError('This route does not take a session.', 403, 'owner_auth_required');
  }
  await assertUnderRateLimit(env.AGENT_LIMIT, request, 'internal-keep-release');
  const rawBody = await readBoundedText(request);
  await assertSignature(request, caller, rawBody, env);
  if (caller.key.kind !== 'agent') {
    // Counted like every other identity refusal: Core's key is a
    // real key asking for a door it does not carry.
    await recordInboundRefusal(env, CORE_CALLER, 'identity');
    throw new AuthError('Only an agent’s own key fetches a release.', 403, 'owner_auth_required');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody === '' ? '{}' : rawBody);
  } catch {
    throw new ControlError('Request body must be valid JSON.', 400, 'invalid_request');
  }
  const body = internalKeepReleaseFetchSchema.parse(parsed);
  await bindInboundIdentity(env, caller, 'keep-release', body.sender);
  const agent = await agentByEmail(env, body.sender);
  if (!agent) throw new AuthError('Unknown sender.', 403, 'owner_auth_required');
  if (await agentFreeze(env, agent.sub)) throw new AuthError(frozenMessage(agent.name), 403, 'capability_denied');
  if (!keepEnabled(env)) throw new ControlError('This workspace has no Keep.', 404, 'not_configured');

  // The card: this agent's own request, approved, in a thread it may read.
  const card = await threadStub(env, body.thread_id).releaseCard(agent.sub, body.message_id).catch(() => null);
  if (!card || card.authorSub !== agent.sub) throw new ControlError('No such request.', 404, 'room_not_found');
  if (card.state?.status !== 'approved') throw new ControlError('That request is not approved.', 409, 'release_request_closed');

  const token = await exchangeKeepToken(env, { email: agent.email, name: agent.name }, 'Meet release', 'agent');
  let payload: InternalKeepReleaseFetchResponse;
  try {
    payload = await fetchKeepRelease(env, token.token, card.request.request_id);
  } catch (error) {
    // Ended in Keep's own list: the card learns it here, the first time anyone asks.
    if (error instanceof ControlError && error.status === 410) {
      const release = await readKeepRelease(env, { email: agent.email, name: agent.name }, card.request.request_id).catch(() => null);
      if (release?.status === 'ended') {
        await threadStub(env, body.thread_id)
          .updateRelease({ sub: agent.sub, email: agent.email, name: agent.name }, body.message_id, { action: 'end', endedBy: release.ended_by ?? release.approver }, Date.now())
          .catch(() => null);
      }
    }
    throw error;
  }
  // Keep has closed it; the card says so. A failed card write loses only the word "Used".
  await threadStub(env, body.thread_id)
    .updateRelease({ sub: agent.sub, email: agent.email, name: agent.name }, body.message_id, { action: 'used' }, Date.now())
    .catch(() => null);
  console.log(JSON.stringify({ level: 'info', message: 'internal.keep-release.fetched' }));
  return payload;
}

/**
 * The signed no-op: Core's hourly canary.
 *
 * It runs the same four locks as the door above and stops where that door
 * would write: nothing is resolved, nothing is posted, no line appears in any
 * channel. A 200 therefore proves exactly what a real event needs — the route
 * exists, the secret matches, the clock is within the window — and a 404 or
 * 403 says which of them broke. The body is not read for meaning; it is only
 * part of what is signed.
 *
 * An accepted ping counts as Core having called (`recordInboundAccepted`), so
 * `core_events_silent` means Core's scheduler stopped, not that nothing
 * happened to be worth a line for three days. A refused one is counted under
 * its own caller, `ping`, beside `channel-events`.
 */
export async function handleInternalPing(request: Request, env: Env): Promise<InternalPingResponse> {
  const caller = await resolveInboundKey(request, env);
  if (request.headers.get('authorization')) {
    throw new AuthError('This route does not take a session.', 403, 'owner_auth_required');
  }
  await assertUnderRateLimit(env.AGENT_LIMIT, request, 'internal-ping');
  const rawBody = await readBoundedText(request);
  await assertSignature(request, caller, rawBody, env);
  await bindInboundIdentity(env, caller, 'ping', null);
  await recordInboundAccepted(env, CORE_CALLER);
  return { ok: true, pong: true };
}

/**
 * The person a move is made on behalf of.
 *
 * An agent has no authority of its own (docs/AGENTS_SURFACE.md): every write
 * it causes carries the email of the human who asked. The hand-off named the
 * message that asked, and this reads it back — as the agent, through the
 * same reader lock a page read applies, so the message has to be in a
 * conversation the agent is in. It has to be a person's own words: not an
 * event, not another agent, not Meet.
 */
/**
 * A handed-off card follows its agent. For a run that began with
 * a Hand off (`agent_handoffs.auto_stage`), the agent's lines move the card:
 * a step moves it from Queued or Blocked to Doing, a question to Blocked, the
 * answer to Review. The actor is the person whose message the run answers,
 * as for an explicit move, and the Review or Blocked row goes to them
 * (card-holds.ts). Never to Done: a person accepts the work. Best effort: a
 * failed move is logged, and the line still lands.
 */
async function advanceRunCards(
  env: Env,
  sender: { sub: string; email: string },
  threadId: string,
  wanted: 'doing' | 'blocked' | 'review',
): Promise<void> {
  try {
    const run = await env.USAGE.prepare(
      'SELECT card_refs, auto_stage, request_message_id FROM agent_handoffs WHERE agent_sub = ?1 AND thread_id = ?2',
    ).bind(sender.sub, threadId).first<{ card_refs: string | null; auto_stage: string | null; request_message_id: string | null }>();
    if (!run?.auto_stage || !run.request_message_id) return;
    // A step pulls the card back to Doing only from where work waits: never
    // out of Review, where the person is reading the answer.
    if (run.auto_stage === wanted) return;
    if (wanted === 'doing' && run.auto_stage !== 'queued' && run.auto_stage !== 'blocked') return;
    const cards = await runCards(env, sender.sub, threadId);
    if (cards.length === 0) return;
    const actor = await resolveMoveActor(env, sender.sub, { thread_id: threadId, message_id: run.request_message_id });
    const subject = await env.USAGE.prepare("SELECT kind, parent_id FROM threads WHERE id = ?1 AND kind IN ('project', 'lead', 'organization', 'event')")
      .bind(threadId).first<{ kind: string; parent_id: string | null }>();
    for (const card of cards) {
      await moveCard(env, card, wanted, actor);
      await recordCardHold(env, {
        refKind: card.kind as 'task' | 'issue',
        refId: card.id,
        holderEmail: actor,
        agentEmail: sender.email,
        subject: subject?.parent_id ? { kind: subject.kind, id: subject.parent_id } : null,
      });
    }
    await env.USAGE.prepare('UPDATE agent_handoffs SET auto_stage = ?3 WHERE agent_sub = ?1 AND thread_id = ?2')
      .bind(sender.sub, threadId, wanted).run();
  } catch (error) {
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'internal.run-card.move.failed',
      stage: wanted,
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
  }
}

async function resolveMoveActor(
  env: Env,
  agentSub: string,
  reply: NonNullable<InternalChannelEventInput['in_reply_to']>,
): Promise<string> {
  const asked = await messageSender(env, reply.thread_id, agentSub, reply.message_id);
  if (!asked) throw new ControlError('The message being answered was not found.', 404, 'room_not_found');
  const isPerson = asked.type === 'text'
    && !asked.sub.startsWith('agent:')
    && !asked.sub.startsWith('system:');
  if (!isPerson) {
    throw new AuthError('A move answers a person, not an agent or an event.', 403, 'owner_auth_required');
  }
  return asked.email;
}

/**
 * One card, one write, through `writeStage` — the same PATCH a person's drag
 * on the board makes, so the two never disagree about what a column means.
 *
 * A task's write carries the actor to Core as `actor_email`, which
 * records it as `updated_by`; the actor is resolved and required either way,
 * because the rule is the door's, not the store's. An issue's labels are read first: GitHub replaces the whole set
 * on PATCH, and the contract is what decides which labels survive.
 */
async function moveCard(
  env: Env,
  ref: ThreadMessageRef,
  stage: WorkStage,
  actor: string,
): Promise<MovedIssue | null> {
  if (ref.kind === 'task') {
    if (!workModelEnabled(env)) throw new ControlError('The work store is not configured.', 503, 'not_configured');
    const write = writeStage({ origin: 'task' }, stage);
    if (write.kind !== 'task') return null;
    await updateCrmTask(env, ref.id, { status: write.status, actor_email: actor });
    return null;
  }

  const match = /^([^/\s]+)\/([^#\s]+)#(\d{1,7})$/.exec(ref.id);
  if (!match) throw new ControlError('An issue ref is owner/repo#number.', 400, 'invalid_request');
  const [, owner, repo, numberText] = match;
  if (!githubIssuesEnabled(env)) throw new ControlError('GitHub issues are not configured.', 503, 'not_configured');
  const number = Number(numberText);
  const current = await fetchCrmIssue(env, owner!, repo!, number) as {
    state?: string; state_reason?: string | null; labels?: string[];
  } | null;
  if (!current) throw new ControlError('Issue not found.', 404, 'room_not_found');

  const before = current.state ?? 'open';
  const write = writeStage({
    origin: 'issue',
    state: before,
    stateReason: current.state_reason ?? null,
    labels: current.labels ?? [],
  }, stage);
  if (write.kind !== 'issue') return null;
  const written = await writeCrmIssue(env, 'PATCH', {
    owner,
    repo,
    number,
    state: write.state,
    ...(write.state_reason ? { state_reason: write.state_reason } : {}),
    labels: write.labels,
  }, actor) as { title?: string } | null;

  // Only a state change is news; a move between two open columns changes
  // labels, which is housekeeping. Reported against what the issue *was*, so
  // re-running the same move says nothing the second time.
  if (write.state === before) return null;
  return {
    owner: owner!,
    repo: repo!,
    number,
    title: written?.title ?? `#${number}`,
    verb: write.state === 'open'
      ? 'reopened'
      : write.state_reason === 'not_planned' ? 'closed_not_planned' : 'closed',
  };
}

/** What a move actually did to an issue, for the line that reports it. */
interface MovedIssue {
  owner: string;
  repo: string;
  number: number;
  title: string;
  verb: GithubIssueVerb;
}

/**
 * Same envelope Core already verifies in the other direction: the signature
 * covers `${timestamp}.${body}`, so neither half can be swapped for another
 * request's. The timestamp window is what makes a captured call stop working;
 * without it a valid signature is valid forever. Exported for the other
 * signed doors (`core-writes.ts`).
 */
export async function assertSignature(
  request: Request,
  caller: InboundCaller,
  rawBody: string,
  env: Env,
): Promise<void> {
  // A request is counted under the caller whose key signed it.
  const counted = caller.key.kind === 'core' ? CORE_CALLER : `agent:${caller.key.email.split('@')[0]}`;
  const timestamp = request.headers.get('x-internal-timestamp') ?? '';
  const signature = request.headers.get('x-internal-signature') ?? '';
  const sentAt = Number(timestamp);
  if (!timestamp || !signature || !Number.isFinite(sentAt)) {
    throw new AuthError('Request is not signed.', 403, 'owner_auth_required');
  }
  // A refusal is counted: a secret that drifted between Core and
  // Meet refuses every call, and nothing else says so.
  if (Math.abs(Date.now() - sentAt) > INTERNAL_SIGNATURE_SKEW_MILLISECONDS) {
    await recordInboundRefusal(env, counted, 'expired');
    throw new AuthError('Signature has expired.', 403, 'owner_auth_required');
  }
  const expected = await hmacSHA256Hex(caller.secret, `${timestamp}.${rawBody}`);
  // Hex digests are fixed width, so the length check inside this never leaks.
  if (!constantTimeEqualSync(expected, signature.trim().toLowerCase())) {
    await recordInboundRefusal(env, counted, 'mismatch');
    throw new AuthError('Signature does not match.', 403, 'owner_auth_required');
  }
}
