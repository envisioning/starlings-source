import { useEffect, useSyncExternalStore } from 'react';
import type {
  DocsAnnotation,
  DocsAnnotationCreateInput,
  DocsAnnotationResponse,
  DocsAnnotationsResponse,
  DocsAnnotationUpdateInput,
  DocsCategoriesResponse,
  DocsCategory,
  DocsCategoryRow,
  DocsCategoryUpdateInput,
  DocsSubject,
  DocsCreateDocumentInput,
  DocsCreateDocumentResponse,
  DocsDocumentDetail,
  DocsDocumentResponse,
  DocsDocumentSummary,
  DocsDocumentsResponse,
  DocsFolder,
  DocsRailHalf,
  DocsSearchHit,
  DocsSearchResponse,
  DocsSummaryResponse,
  DocsTreeResponse,
  DocsUpdateDocumentInput,
  DocsAccessEvent,
  DocsAccessEventsResponse,
  DocsGrant,
  DocsGrantCreateInput,
  DocsGrantResponse,
  DocsGrantsResponse,
  DocsHealthResponse,
  DocsSignatureRequest,
  DocsSignatureRequestCreateInput,
  DocsSignatureRequestResponse,
  DocsSignatureRequestsResponse,
} from '@starlings/contracts';
import { DOCS_IMAGE_SCHEME, DOCS_RAIL_HALF_SOURCES } from '@starlings/contracts/docs-values';
import { DOCS_SERVICE_PREFIX } from '@starlings/contracts/docs-service';
import docsGraphConfig from '../../packages/contracts/src/docs-graph-config.json';
import { resolveGraphEdges } from './docs-graph-layout';
import { apiFetch, apiFetchConditional } from './api';
import { track } from './analytics';
import { apiBase, ControlRequestError, responseError } from './config';
import { recordMeetError } from './meeting-error-log';
import { formatTime } from './meeting-time';
import { onOwnerPurge } from './owner-local-state';
import { loadSnapshot, revalidate, saveSnapshot } from './snapshot-store';
import { readStored, removeStored, writeStored } from './storage';
import { t, dateLocale } from './i18n';

/**
 * Docs for the browser — the corpus the Mac window and the iOS tab show,
 * read and written through the Worker (`/api/docs/*`). The browser never
 * holds a Docs token: Docs answers no CORS preflight for Meet's origin, and
 * the Worker keeps its own token per owner (docs/DOCS.md).
 */

export type {
  DocsAnnotation,
  DocsTextAnchor,
  DocsCategory,
  DocsCategoryRow,
  DocsDocumentDetail,
  DocsDocumentSummary,
  DocsFolder,
  DocsRailHalf,
  DocsSearchHit,
  DocsSubject,
  DocsSummaryResponse,
  DocsAccessEvent,
  DocsGrant,
  DocsSignatureRequest,
} from '@starlings/contracts';
export {
  docsShareURL,
  docsDocumentURL,
  docsRailFolders,
  docsRailHalf,
} from '@starlings/contracts';

/** Snapshot keys (docs/CACHING.md): the rail and every list paint their last value first. */
export const DOCS_SNAPSHOT = {
  summary: 'docs/summary',
  categories: 'docs/categories',
  written: 'docs/written',
  documents: 'docs/documents',
  graph: 'docs/graph',
  graphLinks: 'docs/graph/links',
} as const;

/**
 * What the list shows. WORK: Recent, a category Meet writes in, or every
 * document about one subject, or Unfiled; FOLDERS: everything under one top-level
 * folder; LIBRARY: a mirrored category (docs/DOCS.md, "The rail").
 */
export type DocsSelection =
  | { kind: 'recent' }
  /** The linked-document graph, across the full Docs corpus. */
  | { kind: 'graph' }
  /** Documents nobody filed. */
  | { kind: 'unfiled' }
  /** Saved links: native documents marked `source_kind = link`. */
  | { kind: 'links' }
  /** One category, by id, on one half: Core's briefs and a person's briefs are two rows. */
  | { kind: 'category'; category: DocsCategory; half: DocsRailHalf }
  | { kind: 'subject'; subjectKind: string; subjectID: string; title: string }
  | { kind: 'folder'; path: string; title: string }
  | { kind: 'search'; query: string };

export function selectionKey(selection: DocsSelection): string {
  switch (selection.kind) {
    case 'recent': return 'recent';
    case 'graph': return 'graph';
    case 'unfiled': return 'unfiled';
    case 'links': return 'links';
    case 'category': return `${selection.half === 'work' ? 'category' : 'library'}:${selection.category}`;
    case 'subject': return `subject:${selection.subjectKind}:${selection.subjectID}`;
    case 'folder': return `folder:${selection.path}`;
    case 'search': return `search:${selection.query}`;
  }
}

/** The one-string form Docs takes: `core:project:<id>`. */
export function subjectRef(subject: Pick<DocsSubject, 'kind' | 'subject_id'>): string {
  return `core:${subject.kind}:${subject.subject_id}`;
}

export async function fetchDocsSummary(): Promise<DocsSummaryResponse> {
  return revalidate(
    DOCS_SNAPSHOT.summary,
    (ifNoneMatch) => apiFetchConditional<DocsSummaryResponse>('/docs/summary', {
      fallbackError: t('Couldn’t load Docs.'),
      noStore: true,
      ifNoneMatch,
    }),
    (body) => body,
  );
}

/**
 * The workspace's categories (envisioning/docs migration 0008): rows its
 * people add, rename, reorder and delete, so no list of them lives here.
 * One store for every reader on the page (the New form, the filing
 * dialog, a row's chip, the editor), so an edit shows everywhere at once.
 */
const NO_CATEGORIES: DocsCategoryRow[] = [];
let categories: DocsCategoryRow[] | null = null;
const categoryListeners = new Set<() => void>();

function publishCategories(next: DocsCategoryRow[]): void {
  categories = next;
  saveSnapshot(DOCS_SNAPSHOT.categories, next);
  for (const listener of categoryListeners) listener();
}

function currentCategories(): DocsCategoryRow[] {
  categories ??= loadSnapshot<DocsCategoryRow[]>(DOCS_SNAPSHOT.categories)?.value ?? null;
  return categories ?? NO_CATEGORIES;
}

onOwnerPurge(() => {
  categories = null;
  for (const listener of categoryListeners) listener();
});

/** Read the list again. A failure leaves the last one standing. */
export async function refreshDocsCategories(): Promise<DocsCategoryRow[]> {
  const next = await revalidate(
    DOCS_SNAPSHOT.categories,
    (ifNoneMatch) => apiFetchConditional<DocsCategoriesResponse>('/docs/categories', {
      fallbackError: t('Couldn’t load the categories.'),
      noStore: true,
      ifNoneMatch,
    }),
    (body) => body.categories ?? [],
  );
  categories = next;
  for (const listener of categoryListeners) listener();
  return next;
}

/** The categories in rail order, read once per mount and updated by every edit. */
export function useDocsCategories(): DocsCategoryRow[] {
  const current = useSyncExternalStore(
    (listener) => {
      categoryListeners.add(listener);
      return () => categoryListeners.delete(listener);
    },
    currentCategories,
    () => NO_CATEGORIES,
  );
  useEffect(() => { void refreshDocsCategories().catch(() => {}); }, []);
  return current;
}

/** A category's name. An id the list does not hold (a stale row, an older Docs) reads as itself. */
export function categoryLabel(list: readonly Pick<DocsCategoryRow, 'id' | 'label'>[], id: DocsCategory): string {
  return list.find((category) => category.id === id)?.label ?? id;
}

/**
 * A picker's options: the workspace's categories. A document already in one
 * the list does not hold (an older Docs' `transcript`) keeps it as an
 * option, so the picker shows where it is; nothing else is offered.
 */
export function categoryOptions(list: readonly DocsCategoryRow[], current: DocsCategory | null = null): Array<Pick<DocsCategoryRow, 'id' | 'label'>> {
  return current && !list.some((category) => category.id === current) ? [...list, { id: current, label: current }] : [...list];
}

export async function createDocsCategory(label: string): Promise<DocsCategoryRow> {
  const created = await apiFetch<DocsCategoryRow>('/docs/categories', {
    method: 'POST',
    body: { label },
    fallbackError: t('Couldn’t add the category.'),
  });
  publishCategories([...currentCategories(), created]);
  return created;
}

export async function updateDocsCategory(id: DocsCategory, input: DocsCategoryUpdateInput): Promise<DocsCategoryRow> {
  const updated = await apiFetch<DocsCategoryRow>(`/docs/categories/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: input,
    fallbackError: t('Couldn’t rename the category.'),
  });
  publishCategories(currentCategories().map((category) => (category.id === id ? updated : category)));
  return updated;
}

/** Every id, in the order the rail shows them. */
export async function orderDocsCategories(ids: DocsCategory[]): Promise<DocsCategoryRow[]> {
  const response = await apiFetch<DocsCategoriesResponse>('/docs/categories/order', {
    method: 'PUT',
    body: { ids },
    fallbackError: t('Couldn’t move the category.'),
  });
  publishCategories(response.categories ?? []);
  return response.categories ?? [];
}

/** Its documents become uncategorized. */
export async function deleteDocsCategory(id: DocsCategory): Promise<void> {
  await apiFetch<unknown>(`/docs/categories/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    fallbackError: t('Couldn’t delete the category.'),
  });
  publishCategories(currentCategories().filter((category) => category.id !== id));
}

/**
 * Everything Meet wrote, for the rail's By project / By lead groups: the
 * subjects come off the documents themselves, so a group exists only when
 * something is filed about it.
 */
export async function fetchWrittenDocuments(): Promise<DocsDocumentSummary[]> {
  return fetchEveryPage(DOCS_SNAPSHOT.written, new URLSearchParams({ source: 'native' }));
}

/** Docs caps one list at this many rows; a longer list is walked by offset. */
const DOCS_PAGE = docsGraphConfig.pageSize;
/** Where the walk stops, whatever `total` says. */
const DOCS_LIST_CAP = docsGraphConfig.maxDocuments;

/**
 * Every row of one `/docs/documents` list, not its first page: a Recent of
 * five hundred transcripts stopped at the cap. The first page goes out
 * conditionally and its validator is the whole list's — newest first, so a
 * change lands on that page; a 304 keeps the snapshot of every page. The
 * rest are read plainly and the merged list is what the snapshot keeps.
 */
async function fetchEveryPage(
  key: string,
  search: URLSearchParams,
  signal?: AbortSignal,
  updates?: {
    onPage?: (documents: DocsDocumentSummary[], total: number) => void;
    onUnchanged?: () => void;
  },
): Promise<DocsDocumentSummary[]> {
  search.set('limit', String(DOCS_PAGE));
  const options = { fallbackError: t('Couldn’t load documents.'), noStore: true, ...(signal ? { signal } : {}) };
  return revalidate(
    key,
    async (ifNoneMatch) => {
      const first = await apiFetchConditional<DocsDocumentsResponse>(`/docs/documents?${search}`, { ...options, ifNoneMatch });
      if (first.unchanged) {
        updates?.onUnchanged?.();
        return first;
      }
      const documents = [...(first.value.documents ?? [])];
      const total = Math.min(first.value.total ?? documents.length, DOCS_LIST_CAP);
      updates?.onPage?.(documents, total);
      while (documents.length < total) {
        search.set('offset', String(documents.length));
        const page = await apiFetch<DocsDocumentsResponse>(`/docs/documents?${search}`, options);
        if (!page.documents?.length) break;
        documents.push(...page.documents);
        updates?.onPage?.([...documents], total);
      }
      return { unchanged: false, value: { ...first.value, documents }, etag: first.etag };
    },
    (body) => body.documents ?? [],
  );
}

export function documentsSnapshotKey(selection: Exclude<DocsSelection, { kind: 'search' | 'graph' }>): string {
  return `${DOCS_SNAPSHOT.documents}?${selectionKey(selection)}`;
}

/** One view or folder as a list, newest first, snapshotted. */
export async function fetchDocsDocuments(selection: Exclude<DocsSelection, { kind: 'search' | 'graph' }>): Promise<DocsDocumentSummary[]> {
  const search = new URLSearchParams();
  if (selection.kind === 'category') {
    search.set('category', selection.category);
    search.set('source', DOCS_RAIL_HALF_SOURCES[selection.half].join(','));
  }
  if (selection.kind === 'subject') search.set('subject', `core:${selection.subjectKind}:${selection.subjectID}`);
  if (selection.kind === 'folder') search.set('prefix', selection.path);
  if (selection.kind === 'unfiled') search.set('unfiled', '1');
  if (selection.kind === 'links') {
    search.set('source', 'native');
    search.set('source_kind', 'link');
  }
  return fetchEveryPage(documentsSnapshotKey(selection), search);
}

export interface DocsGraphEdge {
  source: string;
  target: string;
}

export interface DocsGraphProgress {
  phase: 'documents' | 'links';
  loaded: number;
  total: number;
}

export interface DocsGraphLoadHandlers {
  onDocuments: (documents: DocsDocumentSummary[]) => void;
  onEdges: (edges: DocsGraphEdge[]) => void;
  onProgress: (progress: DocsGraphProgress) => void;
}

/** The Docs index and its resolved wikilinks, for the read-only graph. */
export async function fetchDocsGraph(
  handlers: DocsGraphLoadHandlers,
  signal?: AbortSignal,
): Promise<{ documents: DocsDocumentSummary[]; edges: DocsGraphEdge[] }> {
  const cachedDocuments = loadSnapshot<DocsDocumentSummary[]>(DOCS_SNAPSHOT.graph)?.value ?? null;
  const cachedEdges = loadSnapshot<DocsGraphEdge[]>(DOCS_SNAPSHOT.graphLinks)?.value ?? null;
  if (cachedDocuments) handlers.onDocuments(cachedDocuments);
  if (cachedEdges) handlers.onEdges(cachedEdges);

  let indexUnchanged = false;
  const documents = await fetchEveryPage(DOCS_SNAPSHOT.graph, new URLSearchParams(), signal, {
    onPage: (page, total) => {
      // A cached graph stays whole until the full index lands; painting each
      // page over it would shrink it to the first page and grow it back.
      if (!cachedDocuments) handlers.onDocuments(page);
      handlers.onProgress({ phase: 'documents', loaded: page.length, total });
    },
    onUnchanged: () => { indexUnchanged = true; },
  });
  if (indexUnchanged && cachedEdges) {
    handlers.onProgress({ phase: 'links', loaded: documents.length, total: documents.length });
    return { documents, edges: cachedEdges };
  }

  const documentIDs = new Set(documents.map((document) => document.id));
  const edgeKeys = new Set<string>();
  const edges: DocsGraphEdge[] = [];
  const batchSize = docsGraphConfig.linkBatchSize;
  if (cachedDocuments) handlers.onDocuments(documents);
  // Cached lines stay until the new set is complete; without a cache the
  // lines fill in as the reads land.
  if (!cachedEdges) handlers.onEdges([]);
  handlers.onProgress({ phase: 'links', loaded: 0, total: documents.length });

  if (documents.length === 0) {
    saveSnapshot(DOCS_SNAPSHOT.graphLinks, edges);
    return { documents, edges };
  }

  // Docs exposes resolved wikilinks on each detail. Keep at most eight reads
  // in flight, refilling a slot as soon as it finishes instead of waiting for
  // each slowest request in a batch. Nodes paint from the index first; links
  // fill in while these reads continue.
  let nextIndex = 0;
  let loaded = 0;
  let failed = false;
  let failure: unknown;
  const readNext = async () => {
    while (nextIndex < documents.length && !failed) {
      signal?.throwIfAborted();
      const document = documents[nextIndex++];
      if (!document) return;
      try {
        const detail = await fetchGraphDocument(document.id, signal);
        // The graph is a connection map: reciprocal wikilinks still draw as
        // one line between the two documents.
        if (detail) {
          edges.push(...resolveGraphEdges(
            documentIDs,
            detail.links.flatMap((link) => link.to_id ? [{ source: detail.id, target: link.to_id }] : []),
            edgeKeys,
          ));
        }
        loaded += 1;
        if (loaded % batchSize === 0 || loaded === documents.length) {
          if (!cachedEdges) handlers.onEdges([...edges]);
          handlers.onProgress({ phase: 'links', loaded, total: documents.length });
        }
      } catch (cause) {
        failed = true;
        failure = cause;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(batchSize, documents.length) }, readNext));
  if (failed) {
    if (!cachedEdges) handlers.onEdges([...edges]);
    handlers.onProgress({ phase: 'links', loaded, total: documents.length });
    throw failure;
  }

  saveSnapshot(DOCS_SNAPSHOT.graphLinks, edges);
  return { documents, edges };
}

/**
 * One document's links for the graph. A document deleted or closed to this
 * member between the index read and this read is skipped, so one gone row
 * never costs the whole graph its edges. Any other failure ends the load.
 */
async function fetchGraphDocument(id: string, signal?: AbortSignal): Promise<DocsDocumentDetail | null> {
  try {
    return await fetchDocsDocument(id, signal);
  } catch (cause) {
    if (cause instanceof ControlRequestError && [403, 404, 410].includes(cause.status)) return null;
    throw cause;
  }
}

/** Full text. Never snapshotted: a query is typed, not returned to. */
export async function searchDocs(query: string): Promise<DocsSearchHit[]> {
  const search = new URLSearchParams({ q: query, limit: '100' });
  const response = await apiFetch<DocsSearchResponse>(`/docs/search?${search}`, {
    fallbackError: t('Couldn’t search Docs.'),
    noStore: true,
  });
  return response.hits ?? [];
}

export async function fetchDocsDocument(id: string, signal?: AbortSignal): Promise<DocsDocumentDetail> {
  const response = await apiFetch<DocsDocumentResponse>(`/docs/documents/${encodeURIComponent(id)}`, {
    fallbackError: t('Couldn’t open the document.'),
    noStore: true,
    ...(signal ? { signal } : {}),
  });
  return response.document;
}

export async function createDocsDocument(input: DocsCreateDocumentInput): Promise<DocsDocumentDetail> {
  const response = await apiFetch<DocsCreateDocumentResponse>('/docs/documents', {
    method: 'POST',
    body: input,
    fallbackError: t('Couldn’t create the document.'),
  });
  track('Doc created');
  return response.document;
}

export async function setDocsSubjects(id: string, subjects: DocsSubject[]): Promise<DocsDocumentDetail> {
  const response = await apiFetch<DocsDocumentResponse>(`/docs/documents/${encodeURIComponent(id)}/subjects`, {
    method: 'PUT',
    body: { subjects },
    fallbackError: t('Couldn’t change the subjects.'),
  });
  return response.document;
}

export async function moveDocsDocument(id: string, folderPath: string): Promise<DocsDocumentDetail> {
  const response = await apiFetch<DocsDocumentResponse>(`/docs/documents/${encodeURIComponent(id)}/move`, {
    method: 'POST',
    body: { folder_path: folderPath },
    fallbackError: t('Couldn’t move the document.'),
  });
  return response.document;
}

/** Folders a moved document could land in: every one but the mirrored shelves. */
/** Every folder but the mirrored shelves. `DocsRailGroups.moveTargets` in the Swift apps is the same rule. */
export async function fetchMoveTargets(): Promise<DocsFolder[]> {
  const response = await apiFetch<DocsTreeResponse>('/docs/tree', {
    fallbackError: t('Couldn’t load the folders.'),
    noStore: true,
  });
  return (response.folders ?? [])
    .filter((folder) => !folder.path.startsWith('/published') && folder.source_key === null)
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Where a document written about a subject is filed:
 * `/work/<kind>/<subject-slug>` (docs/DOCS.md, "Default path").
 */
/** A subject as Docs takes it: Docs has no partner kind, a partner is filed as its organization (same id). */
export function docsSubjectOf<T extends { kind: string }>(subject: T): T {
  return subject.kind === 'organization' ? { ...subject, kind: 'organization' } : subject;
}

export function subjectFolderPath(kind: string, title: string): string {
  return `/work/${kind}/${slugify(title)}`;
}

/**
 * A path segment from a title: the Docs service's own rule (`slugify` in its
 * contracts, which files `/work/<kind>/<slug>` when it adopts Core notes), so a
 * folder a client names and a folder Docs names are the same folder. The Mac and
 * iOS mirror is `DocsRailGroups.slug`; `fixtures/docs-slug.json` pins both.
 * Clients stop at 60 characters, Docs at 120.
 */
export function slugify(title: string): string {
  const out = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/['\u2019]/gu, '')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 60)
    .replace(/-+$/u, '');
  return out || 'untitled';
}

/**
 * Unsaved text per document — the browser tier of the Mac's
 * draft store: kept on every keystroke, cleared when the server
 * acknowledges, restored on open when the document has not moved.
 */
export interface DocsDraft {
  title: string;
  body: string;
  /** The hash the draft was written against; a different one on open is a conflict. */
  contentHash: string;
  savedAt: number;
}

const DRAFT_PREFIX = 'meet-docs-draft:';

export function readDraft(id: string): DocsDraft | null {
  const raw = readStored(DRAFT_PREFIX + id);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DocsDraft>;
    if (typeof parsed.body !== 'string' || typeof parsed.title !== 'string' || typeof parsed.contentHash !== 'string') return null;
    return { title: parsed.title, body: parsed.body, contentHash: parsed.contentHash, savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0 };
  } catch {
    return null;
  }
}

export function writeDraft(id: string, draft: Omit<DocsDraft, 'savedAt'>): void {
  writeStored(DRAFT_PREFIX + id, JSON.stringify({ ...draft, savedAt: Date.now() } satisfies DocsDraft));
}

export function clearDraft(id: string): void {
  removeStored(DRAFT_PREFIX + id);
}

// Comments are Docs annotations, read and written through the Worker.
export async function fetchDocsAnnotations(documentID: string): Promise<DocsAnnotation[]> {
  const response = await apiFetch<DocsAnnotationsResponse>(`/docs/documents/${encodeURIComponent(documentID)}/annotations`, {
    fallbackError: t('Couldn’t load the comments.'),
    noStore: true,
  });
  return response.annotations ?? [];
}

export async function createDocsAnnotation(documentID: string, input: DocsAnnotationCreateInput): Promise<DocsAnnotation> {
  const response = await apiFetch<DocsAnnotationResponse>(`/docs/documents/${encodeURIComponent(documentID)}/annotations`, {
    method: 'POST',
    body: input,
    fallbackError: t('Couldn’t post the comment.'),
  });
  return response.annotation;
}

export async function updateDocsAnnotation(id: string, input: DocsAnnotationUpdateInput): Promise<DocsAnnotation> {
  const response = await apiFetch<DocsAnnotationResponse>(`/docs/annotations/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: input,
    fallbackError: t('Couldn’t change the comment.'),
  });
  return response.annotation;
}

/** One thread: the root and its replies in the order written. */
export interface DocsThread {
  id: string;
  root: DocsAnnotation;
  replies: DocsAnnotation[];
  status: 'open' | 'resolved';
}

export function threadsOf(annotations: DocsAnnotation[]): DocsThread[] {
  const byThread = new Map<string, DocsAnnotation[]>();
  for (const annotation of annotations) {
    const list = byThread.get(annotation.thread_id) ?? [];
    list.push(annotation);
    byThread.set(annotation.thread_id, list);
  }
  return [...byThread.values()].flatMap((list) => {
    const sorted = list.slice().sort((a, b) => a.created_at.localeCompare(b.created_at));
    const root = sorted.find((entry) => entry.parent_id === null) ?? sorted[0];
    if (!root) return [];
    return [{
      id: root.thread_id,
      root,
      replies: sorted.filter((entry) => entry.id !== root.id),
      status: root.status,
    }];
  }).sort((a, b) => b.root.created_at.localeCompare(a.root.created_at));
}

/**
 * A failure that says what failed, then why when Docs said more than that:
 * a server's own words alone ("Not found.") do not say whether the rename
 * or the move went wrong.
 */
export function failureText(what: string, cause: unknown): string {
  const why = cause instanceof Error ? cause.message : '';
  return why && why !== what ? `${what} ${why}` : what;
}

export async function updateDocsDocument(id: string, input: DocsUpdateDocumentInput): Promise<DocsDocumentDetail> {
  const response = await apiFetch<DocsDocumentResponse>(`/docs/documents/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: input,
    fallbackError: t('Couldn’t save the document.'),
  });
  return response.document;
}

// ---- sharing and signing ------------------------------
// What Docs web's share drawer did, through the Worker. Every call is fresh:
// a share link or a signer's status is never painted from a snapshot.

/** `link` puts the document on the email-gated www reader; `internal` takes it off. */
export async function setDocsVisibility(id: string, visibility: 'internal' | 'link'): Promise<DocsDocumentDetail> {
  const response = await apiFetch<DocsDocumentResponse>(`/docs/documents/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: { visibility } satisfies DocsUpdateDocumentInput,
    fallbackError: t('Couldn’t change who can read it.'),
  });
  return response.document;
}

export async function fetchDocsGrants(id: string): Promise<DocsGrant[]> {
  const response = await apiFetch<DocsGrantsResponse>(`/docs/documents/${encodeURIComponent(id)}/grants`, {
    fallbackError: t('Couldn’t load the share links.'),
    noStore: true,
  });
  return response.grants;
}

export async function createDocsGrant(id: string, input: DocsGrantCreateInput): Promise<DocsGrant> {
  const response = await apiFetch<DocsGrantResponse>(`/docs/documents/${encodeURIComponent(id)}/grants`, {
    method: 'POST',
    body: input,
    fallbackError: t('Couldn’t create the link.'),
  });
  return response.grant;
}

export async function revokeDocsGrant(id: string, grantId: string): Promise<void> {
  await apiFetch<unknown>(`/docs/documents/${encodeURIComponent(id)}/grants/${encodeURIComponent(grantId)}`, {
    method: 'DELETE',
    fallbackError: t('Couldn’t revoke the link.'),
  });
}

export async function fetchDocsAccessEvents(id: string): Promise<DocsAccessEvent[]> {
  const response = await apiFetch<DocsAccessEventsResponse>(`/docs/documents/${encodeURIComponent(id)}/access-events`, {
    fallbackError: t('Couldn’t load the activity.'),
    noStore: true,
  });
  return response.events;
}

export async function fetchDocsSignatureRequests(id: string): Promise<DocsSignatureRequest[]> {
  const response = await apiFetch<DocsSignatureRequestsResponse>(`/docs/documents/${encodeURIComponent(id)}/signature-requests`, {
    fallbackError: t('Couldn’t load the signature requests.'),
    noStore: true,
  });
  return response.requests;
}

export async function createDocsSignatureRequest(id: string, input: DocsSignatureRequestCreateInput): Promise<DocsSignatureRequest> {
  const response = await apiFetch<DocsSignatureRequestResponse>(`/docs/documents/${encodeURIComponent(id)}/signature-requests`, {
    method: 'POST',
    body: input,
    fallbackError: t('Couldn’t send it for signature.'),
  });
  return response.request;
}

export async function cancelDocsSignatureRequest(id: string, requestId: string): Promise<void> {
  await apiFetch<unknown>(`/docs/documents/${encodeURIComponent(id)}/signature-requests/${encodeURIComponent(requestId)}/cancel`, {
    method: 'POST',
    fallbackError: t('Couldn’t cancel the request.'),
  });
}

/** The Core surfaces Docs is not mirroring, by name (`work`, not `core:work`). Empty when all is well. */
export async function fetchDocsUnhealthySurfaces(): Promise<string[]> {
  const response = await apiFetch<DocsHealthResponse>('/docs/health', {
    fallbackError: t('Couldn’t check Docs.'),
    noStore: true,
  });
  return response.unhealthy.map((key) => key.replace(/^core:/u, ''));
}

/** A search hit as a list row, so one list draws both. */
export function hitAsSummary(hit: DocsSearchHit): DocsDocumentSummary {
  return {
    id: hit.id,
    path: hit.path,
    slug: hit.path.split('/').pop() ?? '',
    title: hit.title,
    kind: hit.kind,
    folder_id: null,
    visibility: 'internal',
    status: 'active',
    source_system: hit.source_system,
    source_kind: hit.source_kind,
    source_url: null,
    editable: hit.source_system === 'native',
    version: 1,
    byte_size: 0,
    content_hash: '',
    tags: [],
    category: null,
    transcript: false,
    subjects: [],
    created_at: hit.updated_at,
    updated_at: hit.updated_at,
    updated_by: null,
    excerpt: snippetText(hit.snippet),
  };
}

/** The FTS snippet without its `<mark>` tags — the row is text, not HTML. */
export function snippetText(snippet: string): string {
  return snippet.replace(/<\/?mark>/gu, '').replace(/\s+/gu, ' ').trim();
}

/**
 * A row's dates: when the words are from, then the last edit
 * when that was another day — "4 Jun 2026 · edited 14:02". An import
 * stamps every row with the day it ran, so the edit date alone read as one
 * day of work.
 */
export function rowDatesLabel(
  document: Pick<DocsDocumentSummary, 'written_at' | 'created_at' | 'updated_at'>,
  now = new Date(),
): string {
  const written = document.written_at ?? document.created_at;
  const writtenLabel = updatedAtLabel(written, now);
  const updated = new Date(document.updated_at);
  if (Number.isNaN(updated.valueOf()) || new Date(written).toDateString() === updated.toDateString()) return writtenLabel;
  return t('{written} · edited {updated}', { written: writtenLabel, updated: updatedAtLabel(document.updated_at, now) });
}

/** "4 Sep" / "14:02": one date on a row. */
export function updatedAtLabel(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.valueOf())) return '';
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return formatTime(date);
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(dateLocale, sameYear
    ? { day: 'numeric', month: 'short' }
    : { day: 'numeric', month: 'short', year: 'numeric' });
}

// ---- images in a body ---------------------------------------------
// Docs keeps a document's images; the Worker relays its own image routes
// under `DOCS_SERVICE_PREFIX` (routes/docs-service.ts) for every client. A
// body names one as `![caption](docs-image:<id>)` (`DOCS_IMAGE_SCHEME`).

/** One image attached to a document, as Docs answers an upload. */
export interface DocsImage {
  id: string;
  content_type: string;
  byte_size: number;
  caption: string | null;
}

/** What Docs takes (DocsKit `DocsImagePrep`): PNG, JPEG, WebP or GIF, up to 10 MB. */
const DOCS_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const DOCS_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

function docsServiceURL(path: string, search?: URLSearchParams): string {
  const query = search?.toString();
  return `${new URL(apiBase).origin}${DOCS_SERVICE_PREFIX}${path}${query ? `?${query}` : ''}`;
}

/** The image id a body's `docs-image:<id>` names, or null for any other source. */
export function docsImageID(src: string): string | null {
  if (!src.startsWith(DOCS_IMAGE_SCHEME)) return null;
  const id = src.slice(DOCS_IMAGE_SCHEME.length);
  return /^[A-Za-z0-9-]{1,64}$/u.test(id) ? id : null;
}

/** The markdown a body carries for an uploaded image: the caption as its words, brackets and line breaks taken out. */
export function docsImageMarkdown(image: Pick<DocsImage, 'id' | 'caption'>, fallback: string): string {
  const words = (image.caption || fallback).replace(/[[\]\n\r]+/gu, ' ').trim();
  return `![${words}](${DOCS_IMAGE_SCHEME}${image.id})`;
}

export async function uploadDocsImage(documentID: string, file: File): Promise<DocsImage> {
  if (!DOCS_IMAGE_TYPES.has(file.type)) throw new Error(t('Docs takes PNG, JPEG, WebP or GIF images.'));
  if (file.size > DOCS_IMAGE_MAX_BYTES) throw new Error(t('An image can be up to 10 MB.'));
  const caption = file.name.replace(/\.[a-z0-9]+$/iu, '').trim().slice(0, 500);
  const url = docsServiceURL(`/api/docs/${encodeURIComponent(documentID)}/images`, caption ? new URLSearchParams({ caption }) : undefined);
  const fallback = t('Couldn’t upload the image.');
  let response: Response;
  try {
    response = await fetch(url, { method: 'POST', headers: { 'content-type': file.type }, body: file });
  } catch (cause) {
    recordMeetError(`POST ${DOCS_SERVICE_PREFIX}/api/docs/:id/images`, cause);
    throw new Error(fallback);
  }
  if (!response.ok) throw await responseError(response, fallback);
  return await response.json() as DocsImage;
}

/** Object URLs for images already read, by document and image: a body redrawn does not fetch them again. */
const imageURLs = new Map<string, Promise<string>>();

/** An attached image's bytes, behind the member's session, as an object URL. */
export function fetchDocsImageURL(documentID: string, imageID: string): Promise<string> {
  const key = `${documentID}/${imageID}`;
  const known = imageURLs.get(key);
  if (known) return known;
  const loading = (async () => {
    const response = await fetch(docsServiceURL(`/api/docs/${encodeURIComponent(documentID)}/images/${encodeURIComponent(imageID)}`));
    if (!response.ok) throw await responseError(response, t('Couldn’t load the image.'));
    return URL.createObjectURL(await response.blob());
  })();
  imageURLs.set(key, loading);
  // A failure is not kept: Retry reads it again.
  loading.catch(() => imageURLs.delete(key));
  return loading;
}

/**
 * Every document's title, for `[[` in the editor: the same index the graph
 * reads (`DOCS_SNAPSHOT.graph`), its snapshot first, read once per page load.
 */
let titleIndex: Promise<string[]> | null = null;

export function docsTitles(): Promise<string[]> {
  if (!titleIndex) {
    const cached = loadSnapshot<DocsDocumentSummary[]>(DOCS_SNAPSHOT.graph)?.value;
    const titles = (documents: DocsDocumentSummary[]) => [...new Set(documents.map((document) => document.title))];
    titleIndex = cached
      ? Promise.resolve(titles(cached))
      : fetchEveryPage(DOCS_SNAPSHOT.graph, new URLSearchParams()).then(titles);
    titleIndex.catch(() => { titleIndex = null; });
  }
  return titleIndex;
}
