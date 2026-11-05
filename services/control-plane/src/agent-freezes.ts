// Freezing a roster agent (docs/AGENTS_SURFACE.md §Freezing an agent).
//
// Until this, stopping an agent meant editing `AGENT_ROSTER` and deploying,
// or deleting its inbound secret. A freeze is a row in `agent_freezes`
// (migration 0070) that an admin writes from Admin › Agents, and the three
// doors an agent uses read it on every call:
//
// - the hand-off (`deliver` in agents.ts): no message, answer or reaction is
//   sent to it; a person who wrote to it sees a quiet event line instead;
// - the `/mcp` agent door (`getAgentMcpPrincipal`): refused, 403;
// - the inbound door (`handleInternalChannelEvent`): its messages refused, 403.
//
// A cancel and a watchdog reset still go out: both tell the runtime to stop,
// which is what a freeze wants. The row is read fresh every time — no cache —
// so an unfreeze bites on the next call too. A read that fails refuses: a
// freeze must never be skipped because D1 hiccuped.

import { agentSub, type AdminAgentFreezeResponse, type OwnerSession } from './contracts';
import { agentByEmail } from './agents';
import { recordAdminAction } from './admin-audit';
import { ControlError } from './errors';

export interface AgentFreeze {
  agent_sub: string;
  agent_email: string;
  frozen_at: number;
  frozen_by_email: string;
}

/** The freeze on one agent, or null. Throws when D1 cannot say, so the caller refuses. */
export async function agentFreeze(env: Env, sub: string): Promise<AgentFreeze | null> {
  return env.USAGE.prepare(
    'SELECT agent_sub, agent_email, frozen_at, frozen_by_email FROM agent_freezes WHERE agent_sub = ?1',
  ).bind(sub).first<AgentFreeze>();
}

/** Every freeze, by agent sub. For the hand-off fan-out and Admin's list. */
export async function agentFreezes(env: Env): Promise<Map<string, AgentFreeze>> {
  const { results } = await env.USAGE.prepare(
    'SELECT agent_sub, agent_email, frozen_at, frozen_by_email FROM agent_freezes',
  ).all<AgentFreeze>();
  return new Map(results.map((row) => [row.agent_sub, row]));
}

/** What a refusal says, to the runtime and in its logs. Names no admin: the runtime does not need to know who. */
export function frozenMessage(name: string): string {
  return `${name} is frozen. An admin froze it in Admin › Agents; nothing reaches it or comes from it until they unfreeze it.`;
}

/**
 * `POST /api/admin/agents/:id/freeze` and `/unfreeze`. `:id` is the agent's
 * address as `AGENT_ROSTER` writes it. Only an agent the roster names can be
 * frozen — a human address is not an agent, and a person is cut off with
 * `setPersonAccess` instead. Freezing twice keeps the first time and author.
 */
export async function setAgentFrozen(
  env: Env,
  owner: OwnerSession,
  rawId: string,
  frozen: boolean,
): Promise<AdminAgentFreezeResponse> {
  let id: string;
  try {
    id = decodeURIComponent(rawId).trim().toLowerCase();
  } catch {
    throw new ControlError('That is not an agent address.', 400, 'invalid_request');
  }
  const agent = await agentByEmail(env, id);
  const sub = agent?.sub ?? agentSub(id);
  // An agent dropped from the roster can still have a freeze to lift.
  if (!agent && (frozen || !(await agentFreeze(env, sub)))) {
    throw new ControlError('No agent on the roster has that address.', 404, 'person_not_found');
  }
  const email = agent?.email ?? id;

  if (frozen) {
    await env.USAGE.prepare(
      `INSERT INTO agent_freezes (agent_sub, agent_email, frozen_at, frozen_by_email)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(agent_sub) DO NOTHING`,
    ).bind(sub, email, Date.now(), owner.email).run();
  } else {
    await env.USAGE.prepare('DELETE FROM agent_freezes WHERE agent_sub = ?1').bind(sub).run();
  }
  await recordAdminAction(env, owner, frozen ? 'agent.freeze' : 'agent.unfreeze', email, null);

  const row = await agentFreeze(env, sub);
  return { agent_email: email, frozen_at: row?.frozen_at ?? null, frozen_by_email: row?.frozen_by_email ?? null };
}
