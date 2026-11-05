// Agents — software that acts, addressed the way a colleague is.
//
// An agent is a peer with no device: a `people` row of `kind = 'agent'`, in
// the roster and in conversations, running nowhere near this Worker. Meet
// holds its identity and its transcript; the runtime holds its skills and
// every credential it uses. See docs/AGENTS_SURFACE.md.
//
// It never holds a session. There is no `signOwnerSession` for an agent and
// no owner JWT it could carry — an agent speaks only through the signed
// inbound route in `internal.ts`. An agent address may sit at
// an identity domain, so the domain check alone cannot tell one from a
// person: `kind` is what authorizes, not the suffix.

import { agentsReachingThread } from './subject-access';
import { openSubjects } from './board';
import {
  AGENT_BUSY_TTL_MILLISECONDS,
  AGENT_MANIFEST_TTL_MILLISECONDS,
  AGENT_STUCK_RESET_MILLISECONDS,
  parseAgentManifest,
  type AgentDefinition,
  type AgentDeliveryPayload,
  type ThreadKind,
  type ThreadMessageRef,
  type ThreadHandoff,
} from './contracts';

import { agentFreeze } from './agent-freezes';
import { agentByEmail, agentWebhookSecret, loadAgents, type RosterAgent } from './agent-roster';
import { hmacSHA256Hex, randomToken } from './crypto';
import { appendInboundMessage, directThreadId, inboundMessageId, threadStub } from './threads';
import type { AdminAgentActivityKind } from '@starlings/contracts';

// The roster itself lives in D1 (agent-roster.ts). Re-exported here because
// every caller already imports agents from this module.
export { agentByEmail, loadAgents as agents, type RosterAgent } from './agent-roster';

/**
 * Best-effort, content-free activity facts for Admin. The stable event key
 * makes retries idempotent; losing telemetry must never lose a conversation.
 */
export async function recordAgentActivity(
  env: Env,
  input: {
    eventId: string;
    runId: string | null;
    agentSub: string;
    threadId: string;
    sourceMessageId: string;
    kind: AdminAgentActivityKind;
    occurredAt: number;
    durationMs?: number | null;
    responseStatus?: number | null;
  },
): Promise<void> {
  try {
    await env.USAGE.prepare(
      `INSERT OR IGNORE INTO agent_activity_events
        (event_id, run_id, agent_sub, thread_id, source_message_id, kind, occurred_at, duration_ms, response_status)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    ).bind(
      input.eventId,
      input.runId,
      input.agentSub,
      input.threadId,
      input.sourceMessageId,
      input.kind,
      input.occurredAt,
      input.durationMs == null ? null : Math.max(0, Math.round(input.durationMs)),
      input.responseStatus ?? null,
    ).run();
  } catch (error) {
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'agents.activity.write.failed',
      kind: input.kind,
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
  }
}

/** Keep enough history for review while bounding the account-wide event table. */
export async function pruneAgentActivity(env: Env, now: number): Promise<number> {
  const retention = 90 * 24 * 60 * 60_000;
  const result = await env.USAGE.prepare(
    'DELETE FROM agent_activity_events WHERE occurred_at < ?1',
  ).bind(now - retention).run();
  return result.meta.changes ?? 0;
}

/**
 * The `people` rows the map implies, made to exist.
 *
 * Derived from the roster (`agents` in D1, agent-roster.ts), so adding
 * an agent is an approval and not a migration, and a row is written once rather
 * than on every read. The `SELECT` first is what keeps this off the write path
 * of a roster poll — after the first call there is nothing to insert.
 *
 * `last_seen_at` is stamped at creation, and beaten only when the runtime
 * proves it is there — `markWorking` when it accepts a hand-off, `clearWorking`
 * when it answers one. An agent has no heartbeat to give, so nothing else
 * writes it; it is exempt from the roster's cold-row cutoff for the same
 * reason rather than beating a fake beat to stay inside it.
 */
export async function ensureAgentPeople(env: Env, now: number): Promise<void> {
  const defined = await loadAgents(env);
  if (defined.length === 0) return;
  try {
    const placeholders = defined.map((_, index) => `?${index + 1}`).join(', ');
    const { results } = await env.USAGE.prepare(
      `SELECT sub, name FROM people WHERE sub IN (${placeholders})`,
    ).bind(...defined.map((agent) => agent.sub)).all<{ sub: string; name: string | null }>();
    const present = new Map(results.map((row) => [row.sub, row.name]));

    // Missing rows **and renamed ones**. The upsert used to run only for rows
    // that were absent, which made its `ON CONFLICT DO UPDATE SET name` dead
    // code: a row kept whatever name it was first written with, so renaming an
    // agent in `AGENT_ROSTER` changed the map and never the roster. Four rows
    // sat under their first spelling for a day because of it.
    //
    // The read stays because it is what keeps the write off the roster poll
    // path: once every name agrees, this batch is empty however often the
    // roster is read.
    const stale = defined.filter((agent) => !present.has(agent.sub) || present.get(agent.sub) !== agent.name);
    if (stale.length === 0) return;

    await env.USAGE.batch(stale.map((agent) => env.USAGE.prepare(
      `INSERT INTO people (sub, email, name, first_seen_at, last_seen_at, kind)
       VALUES (?1, ?2, ?3, ?4, ?4, 'agent')
         ON CONFLICT(sub) DO UPDATE SET name = ?3, kind = 'agent'`,
    ).bind(agent.sub, agent.email, agent.name, now)));
  } catch (error) {
    // Same rule as every other roster read: one failure empties a pane, it
    // never breaks the team list.
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'agents.people.write.failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
  }
}

/** A manifest fetch is a health probe, not a job — it gets no longer than a hand-off. */
const MANIFEST_TIMEOUT_MS = 5_000;

/**
 * Refresh the cached manifest of every agent whose runtime can be reached and
 * whose copy is missing or older than the TTL.
 *
 * This is the read side of §The manifest, and it runs on the same off-write
 * pattern as `ensureAgentPeople`: called from the roster read path on
 * `ctx.waitUntil`, so no request ever waits on a sandbox, and gated by
 * `agent_manifest_fetched_at` so a healthy runtime is asked at most once per
 * `AGENT_MANIFEST_TTL_MILLISECONDS` however often the roster is polled.
 *
 * `agents(env)` has already stripped an `http` endpoint outside development —
 * the same rule `deliver` inherits — so an entry that survives with an
 * endpoint is one Meet is allowed to fetch over. Meet is never the writer of
 * what an agent can do; it caches what the runtime proves and clamps it first.
 */
export async function refreshAgentManifests(env: Env, now: number): Promise<void> {
  const reachable = (await loadAgents(env)).filter((agent) => agent.endpoint);
  if (reachable.length === 0) return;

  const fetchedAt = new Map<string, number | null>();
  try {
    const placeholders = reachable.map((_, index) => `?${index + 1}`).join(', ');
    const { results } = await env.USAGE.prepare(
      `SELECT sub, agent_manifest_fetched_at FROM people WHERE sub IN (${placeholders})`,
    ).bind(...reachable.map((agent) => agent.sub)).all<{ sub: string; agent_manifest_fetched_at: number | null }>();
    for (const row of results) fetchedAt.set(row.sub, row.agent_manifest_fetched_at);
  } catch (error) {
    // A manifest is decoration; a failure to read the fetched-at empties a card,
    // never the roster.
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'agents.manifest.gate.failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
    return;
  }

  const due = reachable.filter((agent) => {
    const at = fetchedAt.get(agent.sub);
    return at === null || at === undefined || now - at >= AGENT_MANIFEST_TTL_MILLISECONDS;
  });
  if (due.length === 0) return;
  await Promise.all(due.map((agent) => fetchAgentManifest(env, agent)));
}

/**
 * One manifest fetch, clamped and stored — or the last good copy kept.
 *
 * A `404` is not an error: it is a runtime that serves no manifest, and the
 * card falls back to the name and `agent_state`, which is today's row — so any
 * stale copy is cleared. A `200` that will not parse is treated the same way:
 * the runtime has nothing a card can honestly draw. Anything else — a 5xx, a
 * timeout, a dropped connection — is transient, so the last good copy is kept
 * and only the fetched-at moves, which stops a dead runtime being re-probed on
 * every roster miss.
 */
async function fetchAgentManifest(env: Env, agent: AgentDefinition): Promise<void> {
  // From the runtime's ORIGIN, not the endpoint path: the endpoint is the
  // hand-off route (e.g. `/meet/handoff`), and the manifest is served at the
  // origin root `/manifest`, not underneath it. See docs/AGENTS_SURFACE.md.
  const url = new URL('/manifest', agent.endpoint!).toString();
  let outcome: { manifest: string | null } | 'keep';
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
    });
    if (response.status === 404) {
      outcome = { manifest: null };
    } else if (!response.ok) {
      outcome = 'keep';
    } else {
      const parsed = parseAgentManifest(await response.json().catch(() => null));
      outcome = { manifest: parsed ? JSON.stringify(parsed) : null };
    }
  } catch {
    // Network error or timeout. Transient — keep whatever was last proven.
    outcome = 'keep';
  }
  await storeAgentManifest(env, agent.sub, outcome);
}

/**
 * Write the outcome of a fetch. `keep` moves only the fetched-at, so a
 * transient failure gates the next probe to the TTL without touching the copy;
 * anything else replaces the copy (or clears it) and stamps the fetched-at.
 */
async function storeAgentManifest(
  env: Env,
  sub: string,
  outcome: { manifest: string | null } | 'keep',
): Promise<void> {
  const now = Date.now();
  try {
    if (outcome === 'keep') {
      await env.USAGE.prepare(
        "UPDATE people SET agent_manifest_fetched_at = ?2 WHERE sub = ?1 AND kind = 'agent'",
      ).bind(sub, now).run();
      return;
    }
    await env.USAGE.prepare(
      "UPDATE people SET agent_manifest = ?2, agent_manifest_fetched_at = ?3 WHERE sub = ?1 AND kind = 'agent'",
    ).bind(sub, outcome.manifest, now).run();
  } catch (error) {
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'agents.manifest.write.failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
  }
}

/** An agent's runtime gets a few seconds to accept the hand-off, not to think. */
const DELIVERY_TIMEOUT_MS = 5_000;

/**
 * Tell the agents in a conversation that somebody wrote in it.
 *
 * **Fire and forget, and it has to stay that way.** The answer comes back
 * minutes later through `POST /api/internal/channel-events`, not on this
 * response: a software-factory turn has a build in it, and a Worker request
 * does not have a build's worth of budget. Waiting here would work for a
 * one-second reply and collapse the first time an agent did real work — which
 * is the only time it matters. See docs/AGENTS_SURFACE.md.
 *
 * Failure is invisible to the sender by design. Their message is already in
 * the thread; an agent that never woke up is a conversation with no answer in
 * it, which is what an unanswered message looks like anyway.
 *
 * Two ways in. Thread **members** are notified of every line — an agent in a
 * DM hears everything said there. A channel has no members, so an agent is
 * never woken by every line in Everyone or a project channel; there it is
 * woken by a **mention** and nothing else (meet, 2026-09-21). Either way the
 * hand-off records that this person addressed this agent, which is what
 * later lets the agent read Meet as them (docs/MCP.md §The agent principal).
 */
/**
 * The agent bound to the open project whose channel this is, lowercased, or
 * null. Read from the cached open-subjects list; a closed project's channel
 * wakes its agent only by @mention. A read that fails answers null, so a
 * Core outage never stops a message from being said.
 */
async function projectAgentOf(env: Env, threadId: string): Promise<string | null> {
  try {
    const row = await env.USAGE.prepare("SELECT parent_id FROM threads WHERE id = ?1 AND kind = 'project'")
      .bind(threadId).first<{ parent_id: string | null }>();
    if (!row?.parent_id) return null;
    const project = (await openSubjects(env, [])).find((subject) => subject.kind === 'project' && subject.id === row.parent_id);
    return project?.agent_email?.trim().toLowerCase() || null;
  } catch (error) {
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'agents.notify.project-agent.failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
    return null;
  }
}

export async function notifyThreadAgents(
  env: Env,
  input: {
    threadId: string;
    threadKind: ThreadKind;
    messageId: string;
    text: string;
    sentAt: number;
    sender: { email: string; name: string };
    /** The cards the message was sent from, so the runtime knows its ticket. */
    refs?: ThreadMessageRef[];
    /** The addresses the message names — how a channel reaches an agent. */
    mentions?: string[];
    /** On a Hand off: what done looks like and what comes back. */
    handoff?: ThreadHandoff;
  },
): Promise<void> {
  const defined = (await loadAgents(env)).filter((agent) => agent.endpoint);
  if (defined.length === 0) return;
  const mentioned = new Set((input.mentions ?? []).map((email) => email.trim().toLowerCase()));

  let members: string[] = [];
  try {
    const { results } = await env.USAGE.prepare(
      `SELECT p.email AS email
         FROM thread_members m
         JOIN people p ON p.sub = m.member_sub
        WHERE m.thread_id = ?1 AND p.kind = 'agent'`,
    ).bind(input.threadId).all<{ email: string }>();
    members = results.map((row) => row.email);
  } catch (error) {
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'agents.notify.members.failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
    return;
  }

  // A project's own agent (`projects.agent_email`) hears every line in the
  // project's channel: it works there, so it needs no @mention (MZ,
  // 2026-10-06). Its own lines never come through here: only a member's
  // message wakes an agent.
  const projectAgent = input.threadKind === 'project' ? await projectAgentOf(env, input.threadId) : null;

  // A restricted subject's channel reaches only the agents granted on it
  // (docs/ACCESS.md slice 2): a mention does not open the subject.
  const reaching = await agentsReachingThread(env, input.threadId);
  const targets = defined.filter((agent) => (members.includes(agent.email) || mentioned.has(agent.email) || agent.email === projectAgent)
    && (!reaching || reaching.has(agent.sub)));
  await Promise.all(targets.map((agent) => deliver(env, agent, {
    kind: 'message',
    agent_email: agent.email,
    thread_id: input.threadId,
    thread_kind: input.threadKind,
    message_id: input.messageId,
    text: input.text,
    sent_at: input.sentAt,
    sender_email: input.sender.email,
    sender_name: input.sender.name,
    refs: input.refs ?? [],
    ...(input.handoff ? { handoff: input.handoff } : {}),
  })));
}

/** Deliver a structured answer to the agent that authored the question. */
export async function notifyAgentQuestionAnswer(
  env: Env,
  input: {
    agentEmail: string;
    threadId: string;
    threadKind: ThreadKind;
    messageId: string;
    questionMessageId: string;
    questionText: string;
    optionIds: string[];
    optionLabels: string[];
    sentAt: number;
    sender: { email: string; name: string };
  },
): Promise<void> {
  const agent = await agentByEmail(env, input.agentEmail);
  if (!agent?.endpoint) return;
  const reaching = await agentsReachingThread(env, input.threadId);
  if (reaching && !reaching.has(agent.sub)) return;
  await deliver(env, agent, {
    kind: 'question_answer',
    agent_email: agent.email,
    thread_id: input.threadId,
    thread_kind: input.threadKind,
    message_id: input.messageId,
    question_message_id: input.questionMessageId,
    question_text: input.questionText,
    option_ids: input.optionIds,
    option_labels: input.optionLabels,
    sent_at: input.sentAt,
    sender_email: input.sender.email,
    sender_name: input.sender.name,
  });
}

/**
 * Tell the agent that a member acted on its Keep release request.
 * `approved`: fetch it now through `/api/internal/keep-release`. `ended`: it
 * is gone. Not a message: it does not mark the agent as working.
 */
export async function notifyAgentRelease(
  env: Env,
  input: {
    agentEmail: string;
    threadId: string;
    threadKind: ThreadKind;
    messageId: string;
    requestId: string;
    status: 'approved' | 'ended';
    expiresAt: number;
    sentAt: number;
    sender: { email: string; name: string };
  },
): Promise<void> {
  const agent = await agentByEmail(env, input.agentEmail);
  if (!agent?.endpoint) return;
  const reaching = await agentsReachingThread(env, input.threadId);
  if (reaching && !reaching.has(agent.sub)) return;
  await deliver(env, agent, {
    kind: 'release',
    agent_email: agent.email,
    thread_id: input.threadId,
    thread_kind: input.threadKind,
    message_id: input.messageId,
    request_id: input.requestId,
    status: input.status,
    expires_at: input.expiresAt,
    sent_at: input.sentAt,
    sender_email: input.sender.email,
    sender_name: input.sender.name,
  });
}

/**
 * Tell the agent whose message somebody acknowledged.
 *
 * Reactions are not new messages and must not mark an agent as working. They
 * still need the same signed, short-lived hand-off as a message so Eve can
 * treat an acknowledgement as input to the existing conversation session.
 */
export async function notifyAgentReaction(
  env: Env,
  input: {
    agentEmail: string;
    threadId: string;
    threadKind: ThreadKind;
    messageId: string;
    emoji: string;
    on: boolean;
    reactedAt: number;
    sender: { email: string; name: string };
  },
): Promise<void> {
  const agent = await agentByEmail(env, input.agentEmail);
  if (!agent?.endpoint) return;
  const reaching = await agentsReachingThread(env, input.threadId);
  if (reaching && !reaching.has(agent.sub)) return;
  await deliver(env, agent, {
    kind: 'reaction',
    agent_email: agent.email,
    thread_id: input.threadId,
    thread_kind: input.threadKind,
    message_id: input.messageId,
    emoji: input.emoji,
    on: input.on,
    reacted_at: input.reactedAt,
    sender_email: input.sender.email,
    sender_name: input.sender.name,
  });
}

/**
 * Tell one agent to stop working a card.
 *
 * Sent when a person drags a card out of `doing` on the board. The label and
 * the event line are already the person's; this is only the runtime being
 * told, so it can abandon the run and say nothing (docs/BOARD.md). Addressed
 * to the DM between the person and the agent, which is where a hand-off would
 * have come from, and never marks the agent as working — a 2xx here is a
 * promise to stop, not to answer.
 *
 * The card still moved whatever comes back; the receipt says what the
 * runtime knows. `no_runtime` when the agent has nowhere to be told;
 * `failed` when it was called and did not take the cancel — timed out,
 * refused, unreachable — so the caller says the run may still be going
 * rather than that it stopped.
 */
export type AgentCancelOutcome = 'accepted' | 'failed' | 'no_runtime';

export async function cancelAgent(
  env: Env,
  input: {
    agentEmail: string;
    ref: ThreadMessageRef;
    sender: { sub: string; email: string; name: string };
  },
): Promise<AgentCancelOutcome> {
  const agent = await agentByEmail(env, input.agentEmail);
  if (!agent?.endpoint) return 'no_runtime';
  const threadId = await directThreadId(input.sender.sub, agent.sub);
  const accepted = await deliver(env, agent, {
    kind: 'cancel',
    agent_email: agent.email,
    thread_id: threadId,
    thread_kind: 'dm',
    message_id: `cancel_${randomToken(12)}`,
    text: `${input.sender.name} took ${input.ref.kind === 'issue' ? input.ref.id : 'a task'} back.`,
    sent_at: Date.now(),
    sender_email: input.sender.email,
    sender_name: input.sender.name,
    refs: [input.ref],
  });
  return accepted ? 'accepted' : 'failed';
}

/**
 * One hand-off, signed with the same envelope Core already verifies — so a
 * runtime can prove the call is Meet's before it spends anything on it, and a
 * hook URL that leaks is not by itself a way to drive an agent.
 *
 * Signed with the agent's own webhook secret (agent-roster.ts), never one
 * another agent holds. An agent with no secret gets nothing
 * outside development (`signedHeaders`).
 *
 * True when the runtime answered 2xx — accepted, not done. False for a
 * refusal, a timeout, no answer at all, no secret, or an agent an admin froze.
 */
async function deliver(
  env: Env,
  agent: RosterAgent,
  payload: AgentDeliveryPayload,
  /** A redelivery of a request the agent already took: its card and addresser stay as the first delivery left them. */
  options: { retry?: boolean } = {},
): Promise<boolean> {
  const tracksTurn = payload.kind === 'message' || payload.kind === 'question_answer';
  // A frozen agent is sent nothing that asks it to act. A cancel
  // still goes: it tells the runtime to stop, which is what a freeze wants.
  if (payload.kind !== 'cancel' && await isFrozen(env, agent)) {
    if (tracksTurn) await postFrozenNotice(env, agent, payload.thread_id, payload.message_id);
    return false;
  }
  const body = JSON.stringify(payload);
  const headers = await signedHeaders(env, agent, body);
  if (!headers) return false;
  const attemptedAt = Date.now();
  const runId = tracksTurn ? `${agent.sub}:${payload.message_id}` : null;
  if (tracksTurn) {
    await recordAgentActivity(env, {
      eventId: `${runId}:handoff`,
      runId,
      agentSub: agent.sub,
      threadId: payload.thread_id,
      sourceMessageId: payload.message_id,
      kind: 'handoff',
      occurredAt: attemptedAt,
    });
  }
  try {
    const response = await fetch(agent.endpoint!, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    if (tracksTurn) {
      await recordAgentActivity(env, {
        eventId: `${runId}:${response.ok ? 'accepted' : 'rejected'}`,
        runId,
        agentSub: agent.sub,
        threadId: payload.thread_id,
        sourceMessageId: payload.message_id,
        kind: response.ok ? 'accepted' : 'rejected',
        occurredAt: Date.now(),
        durationMs: Date.now() - attemptedAt,
        responseStatus: response.status,
      });
    }
    // Only a message accepted is work taken on. A cancel accepted is the
    // opposite, and must not put *Working…* on a row that just stopped.
    if (response.ok && (payload.kind === 'message' || payload.kind === 'question_answer')) {
      await markWorking(env, agent, payload.thread_id, payload.message_id);
      // A message names the card the run is about; an answer to the agent's
      // question is part of the run it answers, so its card stays. A retry
      // is the same run again, and keeps the first delivery's card stage.
      if (payload.kind === 'message' && !options.retry) await recordRunCards(env, agent.sub, payload.thread_id, payload.refs ?? [], Boolean(payload.handoff));
      if (!options.retry) await recordAddresser(env, agent, payload.sender_email);
    }
    if (!response.ok) {
      // Status only. The body is the runtime's, and the text is the person's.
      console.warn(JSON.stringify({
        level: 'warn',
        message: 'agents.notify.rejected',
        status: response.status,
      }));
    }
    return response.ok;
  } catch (error) {
    if (tracksTurn) {
      await recordAgentActivity(env, {
        eventId: `${runId}:delivery_failed`,
        runId,
        agentSub: agent.sub,
        threadId: payload.thread_id,
        sourceMessageId: payload.message_id,
        kind: 'delivery_failed',
        occurredAt: Date.now(),
        durationMs: Date.now() - attemptedAt,
      });
    }
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'agents.notify.failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
    return false;
  }
}

/** Frozen, or D1 could not say — either way nothing is sent. */
async function isFrozen(env: Env, agent: AgentDefinition): Promise<boolean> {
  try {
    return (await agentFreeze(env, agent.sub)) !== null;
  } catch (error) {
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'agents.freeze.read.failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
    return true;
  }
}

/**
 * The person wrote to a frozen agent: say so, quietly, rather than leave a
 * message that reads as unanswered. An event line, so it badges nobody, in
 * the agent's name like the watchdog's notice — a DM admits only its members,
 * and Meet's own sender is not one. Keyed on the message so a retried
 * hand-off says it once. Best effort, as the watchdog's notice is.
 */
async function postFrozenNotice(env: Env, agent: AgentDefinition, threadId: string, messageId: string): Promise<void> {
  try {
    await appendInboundMessage(env, {
      threadId,
      messageId: await inboundMessageId(threadId, `frozen:${agent.sub}:${messageId}`),
      sender: { sub: agent.sub, email: agent.email, name: agent.name },
      text: `${agent.name} is frozen and did not get this. An admin can unfreeze it in Admin › Agents.`,
      type: 'event',
      refs: [],
    });
  } catch (error) {
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'agents.freeze.notice.failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
  }
}

/**
 * This person has addressed this agent — the fact `getAgentMcpPrincipal`
 * checks before letting the agent read as them. Written on acceptance, like
 * *Working…*: a hand-off nobody took is not an address. Best effort; the
 * next accepted hand-off writes it again.
 */
async function recordAddresser(env: Env, agent: AgentDefinition, senderEmail: string): Promise<void> {
  try {
    await env.USAGE.prepare(
      `INSERT INTO agent_addressers (agent_sub, actor_sub, last_at)
       SELECT ?1, sub, ?3 FROM people WHERE email = ?2 AND kind = 'human'
       ON CONFLICT(agent_sub, actor_sub) DO UPDATE SET last_at = excluded.last_at`,
    ).bind(agent.sub, senderEmail.trim().toLowerCase(), Date.now()).run();
  } catch (error) {
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'agents.addresser.write.failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
  }
}

/**
 * The agent reads as working, from now until the TTL lapses.
 *
 * Written on **acceptance**, never on dispatch: a runtime that is down must
 * not read as busy, because the only honest thing a roster can say about a
 * hand-off nobody took is nothing. Best effort like the rest of this file —
 * a roster that cannot say "working" is a smaller failure than a message
 * that did not go.
 */
async function markWorking(env: Env, agent: AgentDefinition, threadId: string, requestMessageId: string): Promise<void> {
  try {
    // `last_seen_at` is beaten here and in `clearWorking`, and nowhere else.
    // For a person it is the last beat from a device; for an agent there is no
    // device, so the only honest reading is the last time its runtime proved
    // it was there — by accepting a hand-off, or by answering one. Stamped at
    // creation and never touched again, it used to say an agent added a month
    // ago had not been heard from since, which was true and useless.
    const now = Date.now();
    await env.USAGE.batch([
      env.USAGE.prepare(
        "UPDATE people SET agent_busy_until = ?2, last_seen_at = ?3 WHERE sub = ?1 AND kind = 'agent'",
      ).bind(agent.sub, now + AGENT_BUSY_TTL_MILLISECONDS, now),
      // The per-thread twin of the row above (migration 0029) — what lets
      // resetStuckAgents find *which* hand-off went unanswered instead of only
      // knowing the agent is busy somewhere. A second accepted hand-off on the
      // same thread while the first is still unanswered restarts its clock,
      // which is the right call: the runtime just proved it is still there.
      env.USAGE.prepare(
        `INSERT INTO agent_handoffs (agent_sub, thread_id, accepted_at, replied_at, reset_at, request_message_id)
         VALUES (?1, ?2, ?3, NULL, NULL, ?4)
           ON CONFLICT(agent_sub, thread_id) DO UPDATE SET accepted_at = ?3, replied_at = NULL, reset_at = NULL,
             retried_at = CASE WHEN agent_handoffs.request_message_id = ?4 THEN agent_handoffs.retried_at ELSE NULL END,
             request_message_id = ?4`,
      ).bind(agent.sub, threadId, now, requestMessageId),
    ]);
  } catch (error) {
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'agents.busy.write.failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
  }
}

/**
 * The task and issue refs of the message an agent was last asked about in a
 * thread (migration 0109). Its lines that name no card are about this one.
 */
async function recordRunCards(env: Env, agentSub: string, threadId: string, refs: ThreadMessageRef[], isHandOff: boolean): Promise<void> {
  const cards = refs.filter((ref) => ref.kind === 'task' || ref.kind === 'issue');
  try {
    // A Hand off also starts the card's stage at `queued`: Meet moves it as
    // the agent works (`advanceRunCards` in internal.ts).
    await env.USAGE.prepare('UPDATE agent_handoffs SET card_refs = ?3, auto_stage = ?4 WHERE agent_sub = ?1 AND thread_id = ?2')
      .bind(agentSub, threadId, cards.length > 0 ? JSON.stringify(cards.map(({ kind, id }) => ({ kind, id }))) : null,
        cards.length > 0 && isHandOff ? 'queued' : null)
      .run();
  } catch (error) {
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'agents.run-cards.write.failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
  }
}

/** The cards an agent's run in this thread is about; empty when it named none. */
export async function runCards(env: Env, agentSub: string, threadId: string): Promise<ThreadMessageRef[]> {
  try {
    const row = await env.USAGE.prepare('SELECT card_refs FROM agent_handoffs WHERE agent_sub = ?1 AND thread_id = ?2')
      .bind(agentSub, threadId).first<{ card_refs: string | null }>();
    if (!row?.card_refs) return [];
    const parsed: unknown = JSON.parse(row.card_refs);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((ref): ref is ThreadMessageRef =>
      typeof ref === 'object' && ref !== null
      && (ref.kind === 'task' || ref.kind === 'issue') && typeof ref.id === 'string');
  } catch (error) {
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'agents.run-cards.read.failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
    return [];
  }
}

/**
 * Done — or at least, speaking.
 *
 * Any message from the agent clears it. A runtime that wants to say something
 * mid-run and stay marked as working can simply say so again: re-accepting is
 * not something Meet can observe, and inferring "still working" from the shape
 * of a sentence would be guessing.
 */
export async function clearWorking(env: Env, sub: string, threadId: string): Promise<void> {
  try {
    const now = Date.now();
    await env.USAGE.batch([
      env.USAGE.prepare(
        "UPDATE people SET agent_busy_until = NULL, last_seen_at = ?2 WHERE sub = ?1 AND kind = 'agent'",
      ).bind(sub, now),
      // Only the pending row for this thread — a reply about thread A must
      // not clear the clock on a still-wedged thread B from the same agent.
      env.USAGE.prepare(
        'UPDATE agent_handoffs SET replied_at = ?3 WHERE agent_sub = ?1 AND thread_id = ?2 AND replied_at IS NULL',
      ).bind(sub, threadId, now),
    ]);
  } catch (error) {
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'agents.busy.clear.failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
  }
}

/**
 * The watchdog: find hand-offs nobody answered past AGENT_STUCK_RESET_MILLISECONDS
 * and tell the runtime to give up on each one, via the `resetEndpoint` it
 * declared in AGENT_ROSTER.
 *
 * Signed exactly like `deliver()` — same secret, same header names, same HMAC
 * — because a runtime's `/meet/reset` (see bots/vocab/agent/channels/meet.ts)
 * is the same operator door `deliver()` already knocks on for a hand-off, just
 * a different route on the same origin.
 *
 * `reset_at` is stamped whether or not the call lands, so a runtime that is
 * down or ignores the reset is not hammered every tick — the row stays
 * "pending" for a human to notice, but the watchdog itself backs off after one
 * try. A reply that arrives later still clears it normally through
 * `clearWorking`, reset attempted or not.
 */
export async function resetStuckAgents(env: Env, now: number): Promise<void> {
  const resettable = (await loadAgents(env)).filter((agent) => agent.resetEndpoint);
  if (resettable.length === 0) return;
  const bySub = new Map(resettable.map((agent) => [agent.sub, agent]));

  let stuck: StuckHandoff[] = [];
  try {
    const placeholders = resettable.map((_, index) => `?${index + 2}`).join(', ');
    const { results } = await env.USAGE.prepare(
      `SELECT agent_sub, thread_id, accepted_at, request_message_id, retried_at
         FROM agent_handoffs
        WHERE replied_at IS NULL AND reset_at IS NULL
          AND accepted_at <= ?1
          AND agent_sub IN (${placeholders})`,
    ).bind(now - AGENT_STUCK_RESET_MILLISECONDS, ...resettable.map((agent) => agent.sub))
      .all<StuckHandoff>();
    stuck = results;
  } catch (error) {
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'agents.watchdog.query.failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
    return;
  }
  if (stuck.length === 0) return;

  await Promise.all(stuck.map(async (row) => {
    const agent = bySub.get(row.agent_sub);
    if (!agent?.resetEndpoint) return;
    const landed = await sendReset(env, agent, agent.resetEndpoint, row.thread_id);
    if (row.request_message_id) {
      const kind = landed ? 'watchdog_reset' : 'watchdog_reset_failed';
      await recordAgentActivity(env, {
        eventId: `${agent.sub}:${row.request_message_id}:${kind}`,
        runId: `${agent.sub}:${row.request_message_id}`,
        agentSub: agent.sub,
        threadId: row.thread_id,
        sourceMessageId: row.request_message_id,
        kind,
        occurredAt: now,
        durationMs: now - row.accepted_at,
      });
    }
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'agents.watchdog.reset',
      agentEmail: agent.email,
      threadId: row.thread_id,
      stuckForMs: now - row.accepted_at,
      landed,
    }));
    // The first hang on a request is retried once, quietly: the
    // runtime gave up the run, so the same request starts a fresh one. A
    // retry the runtime accepted leaves the row pending again, with its
    // clock restarted and `retried_at` kept, so a second hang lands below.
    if (landed && row.retried_at === null && row.request_message_id) {
      const retried = await retryRequest(env, agent, row.thread_id, row.request_message_id, now);
      if (retried) return;
    }
    // Say so, in the thread — whether or not the reset call itself landed.
    // Either way the person never got an answer, and a reset with no word is
    // the same silent-forever bug in miniature. This is `turn.failed`'s
    // "I couldn't finish that" for the one case a runtime can never say it
    // itself — it never came back. It offers Retry rather than asking for
    // the message again.
    await postWatchdogNotice(env, agent, row.thread_id, row.accepted_at, row.request_message_id);
    // Stamped regardless of whether the call landed — see doc comment above.
    try {
      await env.USAGE.prepare(
        'UPDATE agent_handoffs SET reset_at = ?3 WHERE agent_sub = ?1 AND thread_id = ?2',
      ).bind(row.agent_sub, row.thread_id, now).run();
    } catch (error) {
      console.warn(JSON.stringify({
        level: 'warn',
        message: 'agents.watchdog.stamp.failed',
        error: error instanceof Error ? error.message : 'Unknown error',
      }));
    }
  }));
}

/**
 * Spoken as the agent, because it is about the agent's own silence — not a
 * Meet system line. Keyed on (thread, accepted_at) so a retried tick (the
 * fetch to `resetEndpoint` failed, or this write did) says it once: a second
 * attempt derives the same message id and rewrites the same row rather than
 * repeating itself, same as `postToMeet`'s idempotency key.
 *
 * Best effort, like the reset call beside it: a failure here must not stop
 * `reset_at` from being stamped, or the watchdog would retry this thread
 * every five minutes forever on a Meet-side hiccup alone.
 */
async function postWatchdogNotice(
  env: Env,
  agent: AgentDefinition,
  threadId: string,
  acceptedAt: number,
  requestMessageId: string | null,
): Promise<void> {
  try {
    // With the request known, the notice is a question whose Retry the
    // Worker answers itself (`answerWatchdogRetry`); without it there is
    // nothing to retry, so it only says what happened.
    // The question goes to the person who asked; a plain notice follows when
    // it cannot be posted (the request is gone, or they cannot answer here).
    if (requestMessageId) {
      try {
        const [request] = await threadStub(env, threadId).messagesByIds(agent.sub, [requestMessageId]);
        if (request) {
          await appendInboundMessage(env, {
            threadId,
            messageId: await watchdogQuestionId(agent.sub, threadId, requestMessageId),
            sender: { sub: agent.sub, email: agent.email, name: agent.name },
            text: 'I lost track of that: my run got stuck and never finished.',
            type: 'text',
            refs: [],
            question: { mode: 'single', options: [{ id: WATCHDOG_RETRY, label: 'Retry' }, { id: 'leave', label: 'Leave it' }] },
            questionRecipientEmail: request.sender_email,
          });
          return;
        }
      } catch (error) {
        console.warn(JSON.stringify({
          level: 'warn',
          message: 'agents.watchdog.question.failed',
          error: error instanceof Error ? error.message : 'Unknown error',
        }));
      }
    }
    const messageId = await inboundMessageId(threadId, `watchdog:${agent.sub}:${acceptedAt}`);
    await appendInboundMessage(env, {
      threadId,
      messageId,
      sender: { sub: agent.sub, email: agent.email, name: agent.name },
      text: 'I lost track of that: my last run got stuck and never finished.',
      type: 'text',
      refs: [],
    });
  } catch (error) {
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'agents.watchdog.notice.failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
  }
}

type StuckHandoff = {
  agent_sub: string;
  thread_id: string;
  accepted_at: number;
  request_message_id: string | null;
  retried_at: number | null;
};

const WATCHDOG_RETRY = 'retry';

/** The watchdog notice's id for one request: the same notice twice is one row, and Retry finds it. */
function watchdogQuestionId(agentSub: string, threadId: string, requestMessageId: string): Promise<string> {
  return inboundMessageId(threadId, `watchdog:${agentSub}:${requestMessageId}:retry`);
}

/**
 * Hand `requestMessageId` to the agent again. Read from the
 * thread as the agent, so the runtime gets the person's words as they stand.
 * Nothing is sent when the line is gone, out of the last page, withdrawn,
 * or followed by a newer line from a person: that line is what the agent
 * should answer now. True when the runtime accepted the retry.
 */
async function redeliverRequest(env: Env, agent: RosterAgent, threadId: string, requestMessageId: string): Promise<boolean> {
  try {
    const thread = await env.USAGE.prepare('SELECT kind FROM threads WHERE id = ?1').bind(threadId).first<{ kind: ThreadKind }>();
    if (!thread) return false;
    const { messages } = await threadStub(env, threadId).messages(agent.sub, { limit: 20 });
    const index = messages.findIndex((message) => message.id === requestMessageId);
    const request = messages[index];
    if (!request || request.deleted_at || request.type !== 'text' || !request.text) return false;
    const agentEmails = new Set((await loadAgents(env)).map((roster) => roster.email));
    const superseded = messages.slice(index + 1)
      .some((message) => message.type === 'text' && !message.deleted_at && !agentEmails.has(message.sender_email));
    if (superseded) return false;
    return await deliver(env, agent, {
      kind: 'message',
      agent_email: agent.email,
      thread_id: threadId,
      thread_kind: thread.kind,
      message_id: request.id,
      text: request.text,
      sent_at: request.sent_at,
      sender_email: request.sender_email,
      sender_name: request.sender_name ?? request.sender_email,
      refs: request.refs ?? [],
    }, { retry: true });
  } catch (error) {
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'agents.watchdog.retry.failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
    return false;
  }
}

/** The watchdog's one quiet retry: stamp it first, so a crash mid-way never retries twice. */
async function retryRequest(env: Env, agent: RosterAgent, threadId: string, requestMessageId: string, now: number): Promise<boolean> {
  try {
    await env.USAGE.prepare('UPDATE agent_handoffs SET retried_at = ?3 WHERE agent_sub = ?1 AND thread_id = ?2')
      .bind(agent.sub, threadId, now).run();
  } catch {
    return false;
  }
  return redeliverRequest(env, agent, threadId, requestMessageId);
}

/**
 * A person answered the watchdog's notice (`postWatchdogNotice`). Retry hands
 * the request to the agent again; Leave it does nothing. True when the
 * question was the watchdog's, so the caller does not also wake the agent
 * with the answer as a turn of its own.
 */
export async function answerWatchdogRetry(
  env: Env,
  agentEmail: string,
  threadId: string,
  questionMessageId: string,
  optionIds: string[],
): Promise<boolean> {
  const agent = await agentByEmail(env, agentEmail);
  if (!agent?.endpoint) return false;
  const row = await env.USAGE.prepare('SELECT request_message_id FROM agent_handoffs WHERE agent_sub = ?1 AND thread_id = ?2')
    .bind(agent.sub, threadId).first<{ request_message_id: string | null }>();
  if (!row?.request_message_id) return false;
  if (questionMessageId !== await watchdogQuestionId(agent.sub, threadId, row.request_message_id)) return false;
  if (optionIds.includes(WATCHDOG_RETRY)) await redeliverRequest(env, agent, threadId, row.request_message_id);
  return true;
}

async function sendReset(env: Env, agent: RosterAgent, resetEndpoint: string, threadId: string): Promise<boolean> {
  const body = JSON.stringify({ thread_id: threadId });
  const headers = await signedHeaders(env, agent, body);
  if (!headers) return false;
  try {
    const response = await fetch(resetEndpoint, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * The envelope for one call to an agent's runtime: `x-internal-timestamp` and
 * `x-internal-signature`, HMAC-SHA256 hex of `${timestamp}.${body}` under that
 * agent's own webhook secret. Null when the agent has no secret and this is
 * not development: an unsigned call in production would teach a runtime to
 * accept anything, so nothing is sent (fail closed). In development a local
 * runtime has nothing to verify against, so the call goes unsigned.
 */
async function signedHeaders(env: Env, agent: RosterAgent, body: string): Promise<Record<string, string> | null> {
  const timestamp = String(Date.now());
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-internal-timestamp': timestamp,
  };
  const secret = await agentWebhookSecret(env, agent);
  if (secret) {
    headers['x-internal-signature'] = await hmacSHA256Hex(secret, `${timestamp}.${body}`);
    return headers;
  }
  if (String(env.ENVIRONMENT) === 'development') return headers;
  console.error(JSON.stringify({ level: 'error', message: 'agents.webhook.no_secret', agent: agent.email.split('@')[0] }));
  return null;
}
