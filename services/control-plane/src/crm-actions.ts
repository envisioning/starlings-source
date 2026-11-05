import type { CrmDecision, CrmDecisionCreateInput, ThreadMessageRef } from './contracts';
import { createCrmDecision } from './crm';
import { postSubjectEvent } from './threads';

// What more than one CRM route does once a write lands. Moved out of `index.ts`
// with the route table.

/**
 * A decision on a subject, from any path: the form, a channel
 * line, a meeting candidate. The subject's channel gets the line;
 * the channel is the record (docs/BOARD.md decision 6).
 */
export async function recordDecision(
  env: Env,
  ctx: ExecutionContext,
  owner: { sub: string; email: string; name?: string | null },
  body: CrmDecisionCreateInput,
): Promise<CrmDecision> {
  const decision = await createCrmDecision(env, { ...body, actor_email: owner.email });
  const refs: ThreadMessageRef[] = [{ kind: 'decision', id: decision.id }];
  if (decision.goal_id) refs.push({ kind: 'goal', id: decision.goal_id });
  if (body.source === 'meeting' && body.source_ref) refs.push({ kind: 'meeting', id: body.source_ref });
  ctx.waitUntil(postSubjectEvent(
    env,
    { kind: decision.subject_kind, id: decision.subject_id },
    decisionLine(owner, body, decision.body),
    refs,
    { actor: { sub: owner.sub, email: owner.email } },
  ));
  return decision;
}

/**
 * The channel line for a decision. One a Claude recorded (`source: 'agent'`,
 * `source_ref` the client) names it the way `narrate` does in mcp.ts, so a
 * colleague can tell it from one the member typed.
 */
export function decisionLine(
  owner: { email: string; name?: string | null },
  input: Pick<CrmDecisionCreateInput, 'source' | 'source_ref'>,
  text: string,
): string {
  return `${actorName(owner, input.source === 'agent' ? input.source_ref : null)} recorded a decision: ${text}`;
}

/**
 * Who a channel line says did something: the member, or the member via the
 * MCP client that made the write ("Rosa via Hermes"). Any MCP client can
 * pair, so the line names the client, never a vendor. `via` is the client the borrowed session
 * was signed for (`requestVia`), so a route can tell without trusting a body
 * — which is what lets the route's own line be the only line (no second one
 * from `narrate`).
 */
export function actorName(owner: { email: string; name?: string | null }, via: string | null | undefined): string {
  const name = owner.name || owner.email;
  return via ? `${name} via ${via}` : name;
}

