/**
 * Who handed each card to an agent, and the INBOX row that follows from it
 * (docs/OWNERSHIP.md decisions 12 and 13). The channel-events door records a
 * hold on every move an agent makes; INBOX shows the holder each held card
 * whose live stage is Review or Blocked. The stage is read from the card, never
 * stored, so a row leaves by itself when the card moves on.
 *
 * The row goes to the subject's chosen responsible person, the acceptor
 * (docs/OWNERSHIP.md decision 12). A subject with nobody chosen
 * sends it to the holder. A suggested person never receives it: a suggestion
 * is a hint on the subject, not a choice.
 */
import {
  INBOX_CARD_LIMIT,
  INBOX_CARD_WINDOW_MS,
  INBOX_PROPOSED_PAGE,
  INBOX_PROPOSED_PAGES,
  type InboxCardItem,
} from '@starlings/contracts/inbox';
import { stageOf } from '@starlings/contracts/work-items';
import type { CrmIssue, CrmSubject, CrmTask } from '@starlings/contracts/crm';
import type { RoleSession } from './capabilities';
import { staleOnError } from './core-cache';
import { fetchCrmTasksByStatus } from './crm';
import { agentByEmail } from './agents';
import { projectIssues } from './unowned';

const lower = (email: string) => email.trim().toLowerCase();

export interface CardHold {
  refKind: 'task' | 'issue';
  refId: string;
  holderEmail: string;
  agentEmail: string;
  subject: { kind: string; id: string } | null;
}

/** Record who an agent's move answered. Overwrites the card's last hold. */
export async function recordCardHold(env: Env, hold: CardHold, at = Date.now()): Promise<void> {
  await env.USAGE.prepare(`INSERT INTO card_holds (ref_kind, ref_id, holder_email, agent_email, subject_kind, subject_id, at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    ON CONFLICT (ref_kind, ref_id) DO UPDATE SET
      holder_email = excluded.holder_email, agent_email = excluded.agent_email,
      subject_kind = COALESCE(excluded.subject_kind, card_holds.subject_kind),
      subject_id = COALESCE(excluded.subject_id, card_holds.subject_id),
      at = excluded.at`)
    .bind(hold.refKind, hold.refId, lower(hold.holderEmail), lower(hold.agentEmail),
      hold.subject?.kind ?? null, hold.subject?.id ?? null, at)
    .run();
}

interface HoldRow {
  holder_email: string;
  ref_kind: string;
  ref_id: string;
  agent_email: string;
  subject_kind: string | null;
  subject_id: string | null;
  at: number;
}

const WAITING = new Set(['review', 'blocked']);

/**
 * The cards this person handed to an agent that now wait on a person.
 * `subjects` are the open subjects INBOX already read; `listed` is INBOX's
 * own rule for which of them this person sees. `truncated` is true when a
 * read came back short, so the source says it was partial.
 */
export async function cardInboxItems(
  env: Env,
  owner: RoleSession,
  subjects: CrmSubject[],
  listed: (subject: CrmSubject) => boolean,
): Promise<{ items: InboxCardItem[]; truncated: boolean }> {
  const me = lower(owner.email);
  // The cards you handed off, and the cards on subjects you answer for.
  const answering = subjects
    .filter((subject) => subject.responsible_email?.toLowerCase() === me)
    .map((subject) => `${subject.kind}:${subject.id}`);
  const holds = (await env.USAGE.prepare(`SELECT holder_email, ref_kind, ref_id, agent_email, subject_kind, subject_id, at
    FROM card_holds
    WHERE (holder_email = ?1 OR (subject_kind || ':' || subject_id) IN (SELECT value FROM json_each(?4)))
      AND at >= ?2
    ORDER BY at DESC LIMIT ?3`)
    .bind(me, Date.now() - INBOX_CARD_WINDOW_MS, INBOX_CARD_LIMIT, JSON.stringify(answering))
    .all<HoldRow>()).results ?? [];
  if (holds.length === 0) return { items: [], truncated: false };
  // The acceptor: the chosen responsible person, else whoever handed it off.
  const mine = (hold: HoldRow, subject: CrmSubject) =>
    (subject.responsible_email?.toLowerCase() || hold.holder_email) === me;

  const items: InboxCardItem[] = [];
  let truncated = false;
  // An agent's name as the roster says it now; an agent since removed keeps its address.
  const names = new Map(await Promise.all([...new Set(holds.map((hold) => hold.agent_email))]
    .map(async (email) => [email, (await agentByEmail(env, email))?.name ?? email] as const)));
  const item = (hold: HoldRow, stage: 'review' | 'blocked', subject: CrmSubject, card: { task: CrmTask | null; issue: CrmIssue | null }): InboxCardItem => ({
    source: 'card',
    key: `card:${hold.ref_kind}:${hold.ref_id}`,
    at: hold.at,
    stage,
    agent: { email: hold.agent_email, name: names.get(hold.agent_email) ?? hold.agent_email },
    subject: { kind: subject.kind as InboxCardItem['subject']['kind'], id: subject.id, title: subject.title },
    ...card,
  });

  // Issues: the cached per-project read the board uses. A hold that named its
  // project reads that project only; one that named none is looked for on
  // every open project with a repository.
  const issueHolds = holds.filter((hold) => hold.ref_kind === 'issue');
  if (issueHolds.length > 0) {
    const named = new Set(issueHolds.filter((hold) => hold.subject_kind === 'project').map((hold) => hold.subject_id));
    const unnamed = issueHolds.some((hold) => hold.subject_kind !== 'project');
    const projects = subjects.filter((subject) => subject.kind === 'project' && (unnamed || named.has(subject.id)));
    const partial: string[] = [];
    const found = await projectIssues(env, projects, partial, 'inbox.card');
    if (partial.length > 0) truncated = true;
    const byId = new Map(found.map((row) => [row.issue.id.toLowerCase(), row]));
    for (const hold of issueHolds) {
      const row = byId.get(hold.ref_id.toLowerCase());
      if (!row || !listed(row.project) || !mine(hold, row.project)) continue;
      const stage = stageOf({
        origin: 'issue',
        state: row.issue.state,
        stateReason: row.issue.state_reason ?? null,
        labels: row.issue.labels,
      });
      if (WAITING.has(stage)) items.push(item(hold, stage as 'review' | 'blocked', row.project, { task: null, issue: row.issue }));
    }
  }

  // Tasks: one cross-subject read per waiting status, as INBOX reads
  // proposals. Core takes both statuses and a D1 workspace stores
  // any status, so a held task in Review or Blocked arrives the way an issue does.
  const taskHolds = new Map(holds.filter((hold) => hold.ref_kind === 'task').map((hold) => [hold.ref_id, hold]));
  if (taskHolds.size > 0) {
    const bySubject = new Map(subjects.map((subject) => [`${subject.kind}:${subject.id}`, subject]));
    for (const status of WAITING) {
      for (let index = 0; index < INBOX_PROPOSED_PAGES; index += 1) {
        const offset = index * INBOX_PROPOSED_PAGE;
        const page = await staleOnError(`tasks-status/${status}/${offset}`, () => fetchCrmTasksByStatus(env, status, INBOX_PROPOSED_PAGE, offset));
        for (const task of page) {
          const hold = taskHolds.get(task.id);
          if (!hold) continue;
          const subject = task.project_id ? bySubject.get(`project:${task.project_id}`)
            : task.lead_id ? bySubject.get(`lead:${task.lead_id}`)
              : task.organization_id ? bySubject.get(`organization:${task.organization_id}`) : undefined;
          if (!subject || !listed(subject) || !mine(hold, subject)) continue;
          items.push(item(hold, status as 'review' | 'blocked', subject, { task, issue: null }));
        }
        if (page.length < INBOX_PROPOSED_PAGE) break;
        if (index + 1 >= INBOX_PROPOSED_PAGES) truncated = true;
      }
    }
  }
  return { items, truncated };
}
