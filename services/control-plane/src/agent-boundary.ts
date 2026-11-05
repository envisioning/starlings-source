// The agent boundary (docs/PRIVACY.md §Personal meetings).
//
// A workspace agent reads through `/mcp` as the person who addressed it: the
// session carries that person's `sub` and the agent's `agentSub`. Subject
// access already intersects the two (subject-access.ts). This file holds the
// other half: what is the person's alone never reaches the agent.
//
// - "Only you": Quick Notes, unfiled meetings and the owner's room, a Docs
//   link save no subject files. Refused, or left out of a list.
// - A private conversation (`audience = 'members'`) is readable only when
//   the agent is itself a member, not only the person.
//
// A Connected Claude (an OAuth grant, no `agentSub`) is the member's own
// assistant and reads as the member. Nothing here touches it.

import type { DocsDocumentSummary, DocsSearchResponse, OwnerSession } from './contracts';
import { listDocsDocuments } from './docs';
import { ControlError } from './errors';

/** The agent a session acts for, or `null` for a person and for a Connected Claude. */
export function sessionAgent(session: OwnerSession): string | null {
  return (session as { agentSub?: string }).agentSub || null;
}

/** Throws when an agent asks for something that is the person's alone. */
export function refuseAgent(session: OwnerSession): void {
  if (sessionAgent(session)) {
    throw new ControlError('That is private to the member. Agents do not read it.', 403, 'capability_denied');
  }
}

/**
 * The thread-visibility clause for SQL that has already joined the person's
 * membership as `m`. `agentParam` binds `sessionAgentBind(session)`: '' for a
 * person, so the clause is the person's own rule.
 */
export function conversationVisibleSql(threadAlias: string, memberAlias: string, agentParam: string): string {
  return `(${threadAlias}.audience = 'everyone'
       OR (${memberAlias}.member_sub IS NOT NULL
           AND (${agentParam} = ''
                OR EXISTS (SELECT 1 FROM thread_members agent_m
                            WHERE agent_m.thread_id = ${threadAlias}.id AND agent_m.member_sub = ${agentParam}))))`;
}

/** Whether an agent session may see this document row. */
export function agentMaySeeDocument(session: OwnerSession, document: Pick<DocsDocumentSummary, 'private'>): boolean {
  return !(sessionAgent(session) && document.private === true);
}

/** Throws the same 404 a missing document gives when an agent opens a private save. */
export function refuseAgentPrivateDocument(session: OwnerSession, document: Pick<DocsDocumentSummary, 'private'>): void {
  if (!agentMaySeeDocument(session, document)) {
    throw new ControlError('Document not found.', 404, 'request_not_found');
  }
}

/**
 * A Docs search answer without the member's private saves, for an agent. A
 * hit carries no `private` flag, so read the link saves (a private save is
 * always one) and drop the private ones by id.
 */
export async function withoutPrivateHits(env: Env, session: OwnerSession, found: DocsSearchResponse): Promise<DocsSearchResponse> {
  if (!sessionAgent(session) || found.hits.length === 0) return found;
  const hidden = await privateSaveIds(env, session.email);
  return { ...found, hits: found.hits.filter((hit) => !hidden.has(hit.id)) };
}

/** The ids of the member's private link saves: what an agent never reads. A private save is always a link save. */
export async function privateSaveIds(env: Env, ownerEmail: string): Promise<Set<string>> {
  const ids = new Set<string>();
  for (let offset = 0; ; offset += 200) {
    const page = await listDocsDocuments(env, ownerEmail, { source_kind: 'link', limit: 200, offset });
    for (const document of page.documents) if (document.private === true) ids.add(document.id);
    if (page.documents.length < 200 || offset + 200 >= page.total) break;
  }
  return ids;
}
