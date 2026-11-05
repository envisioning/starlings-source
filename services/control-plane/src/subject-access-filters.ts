// Response filters for docs/ACCESS.md: each takes an answer a route built
// for everyone and drops what the caller's view hides. They run after the
// shared caches (core-cache.ts), so a cached Core read is never filtered
// for one person and served to another.
//
// An issue has no subject key of its own; it belongs to the projects whose
// repositories hold it. A repository linked to any hidden project is hidden,
// even when a visible project links it too: fail closed.

import type {
  CrmBoardResponse,
  CrmIssue,
  CrmMyWorkResponse,
  CrmSubjectCountsResponse,
  CrmSubjectRelated,
  CrmUnownedWorkResponse,
  DocsCategoryRow,
  DocsDocumentSummary,
  DocsDocumentsResponse,
  DocsSearchResponse,
  DocsSummaryResponse,
  DocsTreeResponse,
  RecentFeedResponse,
} from './contracts';
import type { InboxResponse } from '@starlings/contracts/inbox';
import { fetchCrmProjectRepos, fetchCrmSubjectDetail } from './crm';
import type { RoleSession } from './capabilities';
import { ControlError } from './errors';
import { agentMaySeeDocument, privateSaveIds, refuseAgentPrivateDocument, sessionAgent, withoutPrivateHits } from './agent-boundary';
import { getDocsDocument, listDocsDocuments } from './docs';
import { canSeeDocument, docsSubjectKey, subjectAccessFor, taskKey, type SubjectAccessView, type SubjectKey } from './subject-access';

const repoKey = (owner: string, repo: string): string => `${owner}/${repo}`.toLowerCase();

/**
 * The repositories of every project this caller cannot see. Errors propagate:
 * a Core outage must not turn a hidden repository visible.
 */
export async function hiddenRepos(env: Env, view: SubjectAccessView): Promise<Set<string>> {
  const projects = view.hidden.filter((key) => key.kind === 'project');
  const repos = new Set<string>();
  if (projects.length === 0) return repos;
  await Promise.all(projects.map(async (project) => {
    for (const link of await fetchCrmProjectRepos(env, project.id)) repos.add(repoKey(link.owner, link.repo));
    const { results } = await env.USAGE.prepare(
      `SELECT external_id FROM import_mappings WHERE source = 'github' AND subject_kind = 'project' AND subject_id = ?1`,
    ).bind(project.id).all<{ external_id: string }>();
    for (const row of results ?? []) repos.add(row.external_id.toLowerCase());
  }));
  return repos;
}

export function issueVisible(issue: Pick<CrmIssue, 'owner' | 'repo'>, hidden: Set<string>): boolean {
  return !hidden.has(repoKey(issue.owner, issue.repo));
}

/** Throws `subject_not_found` when the repository belongs to a project the caller cannot see. */
export async function requireRepoVisible(env: Env, session: RoleSession, owner: string, repo: string): Promise<void> {
  const view = await subjectAccessFor(env, session);
  if (view.hidden.length === 0) return;
  if ((await hiddenRepos(env, view)).has(repoKey(owner, repo))) {
    throw new ControlError('No such subject.', 404, 'subject_not_found');
  }
}

export async function filterMyWork(env: Env, view: SubjectAccessView, work: CrmMyWorkResponse): Promise<CrmMyWorkResponse> {
  if (view.hidden.length === 0) return work;
  const repos = await hiddenRepos(env, view);
  return {
    ...work,
    tasks: view.filter(work.tasks, taskKey),
    issues: work.issues.filter((issue) => issueVisible(issue, repos)),
  };
}

export async function filterUnowned(env: Env, view: SubjectAccessView, work: CrmUnownedWorkResponse): Promise<CrmUnownedWorkResponse> {
  if (view.hidden.length === 0) return work;
  const repos = await hiddenRepos(env, view);
  const issues = work.issues.filter((issue) => {
    const subject = work.issue_subjects?.[issue.id];
    return issueVisible(issue, repos) && (!subject || view.canSee(subject.kind, subject.id));
  });
  const kept = new Set(issues.map((issue) => issue.id));
  return {
    ...work,
    tasks: view.filter(work.tasks, taskKey),
    issues,
    ...(work.issue_subjects
      ? { issue_subjects: Object.fromEntries(Object.entries(work.issue_subjects).filter(([id]) => kept.has(id))) }
      : {}),
  };
}

export async function filterBoard(env: Env, view: SubjectAccessView, board: CrmBoardResponse): Promise<CrmBoardResponse> {
  if (view.hidden.length === 0) return board;
  const repos = await hiddenRepos(env, view);
  const tasks = view.filter(board.tasks, taskKey);
  const issues = board.issues.filter((issue) => {
    const project = board.issue_projects[issue.id];
    return issueVisible(issue, repos) && (!project || view.canSee('project', project));
  });
  const taskIds = new Set(tasks.map((task) => task.id));
  const issueIds = new Set(issues.map((issue) => issue.id));
  return {
    ...board,
    subjects: view.filter(board.subjects, (subject) => subject),
    tasks,
    issues,
    traces: board.traces.filter((trace) => (trace.ref_kind === 'task' ? taskIds : issueIds).has(trace.ref_id)),
    issue_projects: Object.fromEntries(Object.entries(board.issue_projects).filter(([id]) => issueIds.has(id))),
  };
}

export function filterFeed(view: SubjectAccessView, feed: RecentFeedResponse): RecentFeedResponse {
  return { ...feed, entries: view.filter(feed.entries, (entry) => entry.subject) };
}

/** A subject's detail names related projects and leads (a partner's, an event's); each is its own subject. */
export function filterSubjectDetail<T extends { related?: CrmSubjectRelated | undefined }>(view: SubjectAccessView, subject: T): T {
  if (!subject.related || view.hidden.length === 0) return subject;
  return {
    ...subject,
    related: {
      ...subject.related,
      projects: subject.related.projects.filter((row) => view.canSee('project', row.id)),
      leads: subject.related.leads.filter((row) => view.canSee('lead', row.id)),
    },
  };
}

/**
 * INBOX rows by the subject each names. Talk and mention rows come from the
 * thread list, which hides restricted channels in SQL already; they are
 * checked again here by `thread.kind`/`parent_id` all the same.
 */
export async function filterInbox(_env: Env, view: SubjectAccessView, inbox: InboxResponse): Promise<InboxResponse> {
  if (view.hidden.length === 0) return inbox;
  const visible = (key: { kind: string; id: string } | null | undefined): boolean => !key || view.canSee(key.kind, key.id);
  const items = inbox.items.filter((item) => {
    switch (item.source) {
      case 'talk':
      case 'mention':
        return !item.thread.parent_id || visible({ kind: item.thread.kind, id: item.thread.parent_id });
      case 'task':
        return visible(item.subject) && visible(taskKey(item.task));
      case 'comment':
      case 'card':
      case 'followup':
        return visible(item.subject);
      case 'decision':
        return visible(item.ask.subject);
      case 'question':
        return visible(item.request.subject);
      case 'invitation':
        return visible(item.event.subject);
      case 'sales':
        return !item.touch.existing_lead_id || view.canSee('lead', item.touch.existing_lead_id);
      default:
        // booking, forwarded, interest and note rows name no subject.
        return true;
    }
  });
  return { ...inbox, items, recent: view.filter(inbox.recent, (entry) => entry.subject) };
}

/**
 * The sidebar badges count every subject Core holds. Each hidden subject of
 * the kind is read and taken off its status, so a badge never counts what
 * the list will not show. With a search text, a hidden subject comes off
 * only when its title holds the text, as Core's count would have matched it.
 */
export async function filterSubjectCounts(
  env: Env,
  view: SubjectAccessView,
  kind: 'lead' | 'project',
  query: string,
  counts: CrmSubjectCountsResponse,
): Promise<CrmSubjectCountsResponse> {
  const hidden = view.hidden.filter((key) => key.kind === kind);
  if (hidden.length === 0) return counts;
  const needle = query.trim().toLowerCase();
  const internal = counts.internal ? { ...counts.internal } : undefined;
  const result: CrmSubjectCountsResponse = {
    counts: { ...counts.counts },
    ...(internal ? { internal } : {}),
    ...(counts.client ? { client: { ...counts.client } } : {}),
  };
  const take = (bucket: Record<string, number> | undefined, status: string) => {
    if (bucket && bucket[status] !== undefined) bucket[status] = Math.max(0, bucket[status]! - 1);
  };
  for (const key of hidden) {
    const subject = await fetchCrmSubjectDetail(env, kind, key.id);
    if (needle && !subject.title.toLowerCase().includes(needle)) continue;
    take(result.counts, subject.status);
    take(subject.internal ? result.internal : result.client, subject.status);
  }
  return result;
}

/** The Docs kind a subject files under; an event has none. */
function docsKindOf(kind: string): 'project' | 'lead' | 'organization' | null {
  if (kind === 'organization') return 'organization';
  if (kind === 'project' || kind === 'lead') return kind;
  return null;
}

/** The documents filed on any of `keys`, read page by page from Docs, once each. Active ones unless `status` says archived. */
async function documentsOn(env: Env, ownerEmail: string, keys: readonly SubjectKey[], status?: 'archived'): Promise<DocsDocumentSummary[]> {
  const found = new Map<string, DocsDocumentSummary>();
  await Promise.all(keys.map(async (key) => {
    const docsKind = docsKindOf(key.kind);
    if (!docsKind) return;
    for (let offset = 0; ; offset += 200) {
      const page = await listDocsDocuments(env, ownerEmail, { subject: `core:${docsKind}:${key.id}`, limit: 200, offset }, status);
      for (const document of page.documents) found.set(document.id, document);
      if (page.documents.length < 200 || offset + 200 >= page.total) break;
    }
  }));
  return [...found.values()];
}

/**
 * Ids of the documents filed on any of `keys`. For a search hit, which
 * carries no subjects: a hit in this set is dropped.
 */
export async function documentIdsOn(env: Env, ownerEmail: string, keys: readonly SubjectKey[]): Promise<Set<string>> {
  return new Set((await documentsOn(env, ownerEmail, keys)).map((document) => document.id));
}

/**
 * Throws unless the caller reaches every subject the document is filed on:
 * `subject_not_found` when one is hidden, `subject_access_denied` when one
 * is read-only and `need` is `write`.
 */
export async function requireDocument(env: Env, session: RoleSession, id: string, need: 'read' | 'write'): Promise<void> {
  const view = await subjectAccessFor(env, session);
  const agent = sessionAgent(session) !== null;
  if (view.readOnly.length === 0 && !agent) return;
  const document = await getDocsDocument(env, session.email, id);
  // A private link save is "Only you": an agent gets a missing document.
  refuseAgentPrivateDocument(session, document);
  for (const link of document.subjects ?? []) {
    const key = docsSubjectKey(link);
    if (!key) continue;
    if (need === 'write') view.requireWrite(key.kind, key.id);
    else view.requireSee(key.kind, key.id);
  }
}

/**
 * A comment or a share link that Docs addresses by its own id
 * (`/api/annotations/:id`, `/api/grants/:id`) names no document. Throws as
 * `requireDocument(…, 'write')` does when the row sits on a document this
 * caller cannot write. The documents on the caller's read-only subjects,
 * active and archived, and an agent's person's private saves, are read, and
 * `rowsOf` lists each one's rows. A row on none of them is on a document the
 * caller can write. Nothing is read when no subject is read-only.
 */
export async function requireDocumentOfRow(
  env: Env,
  session: RoleSession,
  rowId: string,
  rowsOf: (documentId: string) => Promise<ReadonlyArray<{ id: string }>>,
): Promise<void> {
  const view = await subjectAccessFor(env, session);
  const agent = sessionAgent(session) !== null;
  if (view.readOnly.length === 0 && !agent) return;
  const candidates = new Set<string>();
  for (const status of [undefined, 'archived'] as const) {
    for (const document of await documentsOn(env, session.email, view.readOnly, status)) candidates.add(document.id);
  }
  if (agent) for (const id of await privateSaveIds(env, session.email)) candidates.add(id);
  for (const documentId of candidates) {
    if ((await rowsOf(documentId)).some((row) => row.id === rowId)) {
      await requireDocument(env, session, documentId, 'write');
      return;
    }
  }
}

/** Writing a document onto subjects is a write on each of them. */
export async function requireWriteOnDocsSubjects(
  env: Env,
  session: RoleSession,
  links: ReadonlyArray<{ kind: string; subject_id: string }> | undefined,
): Promise<void> {
  if (!links?.length) return;
  const view = await subjectAccessFor(env, session);
  for (const link of links) {
    const key = docsSubjectKey(link);
    if (key) view.requireWrite(key.kind, key.id);
  }
}

export function filterDocuments(view: SubjectAccessView, session: RoleSession, page: DocsDocumentsResponse): DocsDocumentsResponse {
  if (view.hidden.length === 0 && !sessionAgent(session)) return page;
  const documents = page.documents.filter((document) => canSeeDocument(view, document.subjects) && agentMaySeeDocument(session, document));
  return { ...page, documents, total: Math.max(0, page.total - (page.documents.length - documents.length)) };
}

export async function filterDocsSearch(env: Env, session: RoleSession, everyone: DocsSearchResponse): Promise<DocsSearchResponse> {
  const found = await withoutPrivateHits(env, session, everyone);
  const view = await subjectAccessFor(env, session);
  if (view.hidden.length === 0) return found;
  const hidden = await documentIdsOn(env, session.email, view.hidden);
  return { ...found, hits: found.hits.filter((hit) => !hidden.has(hit.id)) };
}

const folderOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/'))) || '/';

/**
 * Docs' counts with the documents on hidden subjects taken off: the total,
 * each category and source, the link saves, and the folder each sits in. A
 * folder whose every document was hidden leaves the list, so its name does
 * not say a hidden subject is there.
 */
export async function filterDocsSummary(env: Env, session: RoleSession, summary: DocsSummaryResponse): Promise<DocsSummaryResponse> {
  const view = await subjectAccessFor(env, session);
  if (view.hidden.length === 0) return summary;
  const hidden = (await documentsOn(env, session.email, view.hidden)).filter((document) => document.status === 'active');
  if (hidden.length === 0) return summary;
  const less = (count: number, by: number) => Math.max(0, count - by);
  const tally = (pick: (document: DocsDocumentSummary) => string | null) => {
    const counts = new Map<string, number>();
    for (const document of hidden) {
      const key = pick(document);
      if (key !== null) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  };
  const byCategory = tally((document) => document.category);
  const bySource = tally((document) => document.category ? `${document.source_system}:${document.category}` : null);
  const byFolder = tally((document) => folderOf(document.path));
  const links = hidden.filter((document) => document.source_kind === 'link').length;
  return {
    ...summary,
    categories: summary.categories.map((row) => ({ ...row, count: less(row.count, byCategory.get(row.category) ?? 0) })),
    ...(summary.by_source
      ? { by_source: summary.by_source.map((row) => ({ ...row, count: less(row.count, bySource.get(`${row.source}:${row.category}`) ?? 0) })) }
      : {}),
    folders: summary.folders.flatMap((row) => {
      const taken = byFolder.get(row.path) ?? 0;
      if (taken === 0) return [row];
      const count = less(row.count, taken);
      return count === 0 ? [] : [{ ...row, count }];
    }),
    ...(summary.links !== undefined ? { links: less(summary.links, links) } : {}),
    total: less(summary.total, hidden.length),
  };
}

/** The category list with the same rule: each count lowered by the hidden documents in it. Every row stays. */
export async function filterDocsCategories(env: Env, session: RoleSession, categories: DocsCategoryRow[]): Promise<DocsCategoryRow[]> {
  const view = await subjectAccessFor(env, session);
  if (view.hidden.length === 0) return categories;
  const taken = new Map<string, number>();
  for (const document of await documentsOn(env, session.email, view.hidden)) {
    if (document.status === 'active' && document.category) taken.set(document.category, (taken.get(document.category) ?? 0) + 1);
  }
  return categories.map((row) => ({ ...row, count: Math.max(0, row.count - (taken.get(row.id) ?? 0)) }));
}

/** Docs' folder tree with the same rule: counts lowered, and a leaf folder holding only hidden documents dropped. */
export async function filterDocsTree(env: Env, session: RoleSession, tree: DocsTreeResponse): Promise<DocsTreeResponse> {
  const view = await subjectAccessFor(env, session);
  if (view.hidden.length === 0) return tree;
  const hidden = (await documentsOn(env, session.email, view.hidden)).filter((document) => document.status === 'active');
  if (hidden.length === 0) return tree;
  const taken = new Map<string, number>();
  for (const document of hidden) {
    if (document.folder_id) taken.set(document.folder_id, (taken.get(document.folder_id) ?? 0) + 1);
  }
  const parents = new Set(tree.folders.map((folder) => folder.parent_id).filter((id): id is string => id !== null));
  return {
    ...tree,
    folders: tree.folders.flatMap((folder) => {
      const by = taken.get(folder.id) ?? 0;
      if (by === 0 || folder.document_count === undefined) return [folder];
      const count = Math.max(0, folder.document_count - by);
      return count === 0 && !parents.has(folder.id) ? [] : [{ ...folder, document_count: count }];
    }),
  };
}
