import { SignInGate } from './SignInGate';
import { Tip } from './Tip';
import { railListClass } from './rail-list';
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Input } from '@/ui/input';
import { Textarea } from '@/ui/textarea';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { Button } from '@/ui/button';
import { Badge } from '@/ui/badge';
import { ButtonGroup } from '@/ui/button-group';
import { Alert, AlertDescription } from '@/ui/alert';
import { Card, CardContent, CardHeader } from '@/ui/card';
import { Sheet, SheetContent, SheetTitle } from '@/ui/sheet';
import { NetworkIcon, TagsIcon, XIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useMediaQuery } from './use-media-query';
import { DocumentMenuItems, DocumentRow, DocumentRows, DocumentRowsPlaceholder, docsListHeadClass, docsMutedClass, NewDocumentForm, useDocumentActions, type DocumentChange } from './docs-list';
import { CopyLinkItem, RowMenuItems, StarItem } from './row-menu-items';
import { useRowMenu } from './use-row-menu';
import { ControlRequestError } from './config';
import { RailRow, RailRowsPlaceholder, RailSection, railBlockProps, SCROLLBAR_AFFORDANCE_CLASS, SurfaceShell, useRightSidebar } from './SurfaceShell';
import { ErrorNotice } from './ErrorNotice';
import { DocumentMarkdown, type ImageRenderer } from './document-markdown';
import { DocumentImage } from './docs-image';
import { DocToc } from './DocToc';
import type { DocsEditorHandle } from './DocsEditor';
import { DocsGraph } from './DocsGraph';
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/ui/dropdown-menu';
import { useMenuTrigger } from './menu-focus';
import { ChevronIcon } from './action-icons';
import { FavoriteMark, FavoriteToggle } from './FavoriteToggle';
import { SurfaceCreate } from './SurfaceCreate';
import { useOwnerHeartbeat } from './use-owner-heartbeat';
import { invalidateSnapshots, loadSnapshot } from './snapshot-store';
import { purgeOwnerLocalState } from './owner-local-state';
import { readStored, StorageKeys, writeStored } from './storage';
import { fetchSubjects, type CrmSubject } from './crm-work';
import {
  categoryLabel,
  categoryOptions,
  clearDraft,
  createDocsDocument,
  DOCS_SNAPSHOT,
  docsRailFolders,
  docsRailHalf,
  documentsSnapshotKey,
  fetchDocsDocument,
  fetchDocsDocuments,
  fetchDocsSummary,
  fetchDocsUnhealthySurfaces,
  fetchMoveTargets,
  fetchWrittenDocuments,
  hitAsSummary,
  readDraft,
  searchDocs,
  selectionKey,
  setDocsSubjects,
  subjectFolderPath,
  docsSubjectOf,
  docsImageMarkdown,
  docsTitles,
  failureText,
  uploadDocsImage,
  updateDocsDocument,
  rowDatesLabel,
  updatedAtLabel,
  useDocsCategories,
  writeDraft,
  type DocsCategory,
  type DocsCategoryRow,
  type DocsDocumentDetail,
  type DocsDocumentSummary,
  type DocsFolder,
  type DocsRailHalf,
  type DocsSelection,
  type DocsSubject,
  type DocsSummaryResponse,
  type DocsTextAnchor,
  threadsOf,
  fetchDocsAnnotations,
} from './docs';
import { SubjectPicker } from './SubjectPicker';
import { DocsCategoriesDialog } from './DocsCategoriesDialog';
import { DocsShareDialog } from './DocsShareDialog';
import { DocumentComments, useAnchorHighlights, useReaderSelection } from './DocumentComments';
import type { DocsSubjectKind } from '@starlings/contracts';
import { DOCS_SELECTION_WORDS } from '@starlings/contracts/docs-values';
import { documentSearchRow } from '@starlings/contracts/search-rows';
import { storeRecent } from './search-doors';
import { documentHref, subjectHref } from './work-hrefs';
import { DOCUMENT_SUBJECT_KINDS } from './subject-pickers';
import { plural, t, dateLocale } from './i18n';
import { useLeaveGuard, useOwnsHistory, writeAddress } from './navigation';
import { parsePermalinkPath } from '@starlings/contracts/permalinks';
import { PlaceholderBar, PlaceholderStatus } from '@/ui/placeholder-rows';
import { confirmDataLoss } from './ConfirmDataLoss';

/**
 * Docs on the web — the corpus, as the fifth workspace destination, the way
 * the Mac has the ⌘5 window and the phone has the Docs tab (docs/DOCS.md,
 *). The rail is two halves of one corpus (docs/DOCS.md, "The
 * rail"): WORK — Recent, the categories Meet writes in, and the projects
 * and leads something is filed about — then FOLDERS, the top-level folders
 * (`docsRailFolders`), and LIBRARY, the mirror of Core's
 * published writing.
 *
 * Wide, three columns: rail, list, document. Narrower, the document takes
 * the list's column and a back link brings the list back. A document opens
 * in read mode; Edit is a mode, because the web is where documents are read
 * and linked (decision 8: writing is Mac first).
 *
 * Everything is member-gated at the Worker and proxied by it: the browser
 * holds no Docs token. A visitor who guesses `/docs` gets a 401 and the page
 * says so rather than pretending the corpus is empty.
 */

const DEFAULT_FOLDER = '/work';

/** The live-styled editor: its own chunk, fetched on the first Edit (or a hover on it), never by a reader. */
const loadEditor = () => import('./DocsEditor');
const DocsEditor = lazy(loadEditor);

/** The element that scrolls the document column: the nearest scrolling ancestor, else the page. */
function scrollerOf(node: HTMLElement | null): HTMLElement {
  for (let current = node?.parentElement ?? null; current; current = current.parentElement) {
    const { overflowY } = getComputedStyle(current);
    if ((overflowY === 'auto' || overflowY === 'scroll') && current.scrollHeight > current.clientHeight) return current;
  }
  return (document.scrollingElement ?? document.documentElement) as HTMLElement;
}

/** A heading in the body: its level (`#` is 1), its words without markup, and its 1-based line. */
interface OutlineEntry { level: number; title: string; line: number }

/**
 * The body's ATX headings in order, outside fenced code: the same headings
 * the reader draws as `h2`–`h6`, so the nth entry is the nth heading there.
 */
function outlineOf(text: string): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  let fence: string | null = null;
  text.split('\n').forEach((raw, index) => {
    const line = raw.trimEnd();
    const opens = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
    if (opens) {
      if (fence === null) fence = opens[1]![0]!;
      else if (opens[1]![0] === fence) fence = null;
      return;
    }
    if (fence !== null) return;
    const heading = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?$/u.exec(line);
    if (!heading) return;
    const title = heading[2]!
      .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, '$1')
      .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/gu, '$2')
      .replace(/[*_`~]/gu, '')
      .trim();
    if (title) entries.push({ level: heading[1]!.length, title, line: index + 1 });
  });
  return entries;
}

/** Words in the body: runs with a letter or a digit in them, so markup alone does not count. */
function wordCount(text: string): number {
  let count = 0;
  for (const run of text.split(/\s+/u)) if (/[\p{L}\p{N}]/u.test(run)) count += 1;
  return count;
}

const AUTOSAVE_MS = 1200;

/**
 * `/docs/document/<id>?view=category:note` — the document's permalink
 *, with the list it was opened from as context.
 */
function readLocation(): { selection: DocsSelection; documentID: string | null; folderID: string | null } {
  const params = new URLSearchParams(window.location.search);
  const record = parsePermalinkPath(window.location.pathname);
  const documentID = record?.surface === 'docs' ? record.id : null;
  return { selection: parseSelection(params.get('view')), documentID, folderID: params.get('folder') };
}

/** A category id's shape, as Docs fixes it (`docsCategoryIdSchema`). */
const CATEGORY_ID = /^[a-z0-9][a-z0-9-]{0,59}$/u;

function parseSelection(raw: string | null): DocsSelection {
  if (!raw) return { kind: 'recent' };
  const [kind, ...rest] = raw.split(':');
  const value = rest.join(':');
  if (kind === 'graph') return { kind: 'graph' };
  // `category:<id>` is the WORK half (and the address every bookmark before
  // the halves had); `library:<id>` the LIBRARY half. Any id of the right
  // shape parses: the workspace's list is data, and `DocsPage` falls back
  // to Recent once the summary says there is no such category.
  if ((kind === 'category' || kind === 'library') && CATEGORY_ID.test(value)) {
    return { kind: 'category', category: value, half: kind === 'category' ? 'work' : 'library' };
  }
  if (kind === 'subject' && rest.length === 2 && rest[0] && rest[1]) {
    return { kind: 'subject', subjectKind: rest[0], subjectID: rest[1], title: '' };
  }
  if (kind === 'folder' && value.startsWith('/')) {
    return { kind: 'folder', path: value, title: value.split('/').filter(Boolean).pop() ?? 'Docs' };
  }
  if (kind === 'unfiled') return { kind: 'unfiled' };
  if (kind === 'links') return { kind: 'links' };
  if (kind === 'search' && value.trim()) return { kind: 'search', query: value.trim() };
  return { kind: 'recent' };
}

/** A view's address, and a document's in it. */
function selectionHref(selection: DocsSelection, documentID: string | null = null): string {
  const params = new URLSearchParams();
  if (selection.kind !== 'recent') params.set('view', selectionKey(selection));
  const search = params.toString();
  return `${documentID ? documentHref(documentID) : '/docs'}${search ? `?${search}` : ''}`;
}

function writeLocation(selection: DocsSelection, documentID: string | null, push: boolean) {
  writeAddress(selectionHref(selection, documentID), { push });
}

/**
 * A project, lead or partner by its Core id — the names the rail and the chips draw.
 * Docs and Work both name an organization `organization` (ADR 0006), so a
 * Docs subject finds its CRM row under the same key.
 */
type SubjectNames = Map<string, CrmSubject>;

function subjectKey(kind: string, id: string): string {
  return `${kind}:${id}`;
}

/** The CRM row a Docs subject names, when the CRM knows it. */
function knownSubject(names: SubjectNames, subject: { kind: string; subject_id: string }): CrmSubject | undefined {
  return names.get(subjectKey(subject.kind, subject.subject_id));
}

/** A category's id and name, from the summary or the category list. */
type CategoryNames = readonly Pick<DocsCategoryRow, 'id' | 'label'>[];

function selectionTitle(selection: DocsSelection, names: SubjectNames, categories: CategoryNames): string {
  switch (selection.kind) {
    case 'recent': return t(DOCS_SELECTION_WORDS.recent.title);
    case 'graph': return t(DOCS_SELECTION_WORDS.graph.title);
    case 'unfiled': return t(DOCS_SELECTION_WORDS.unfiled.title);
    case 'links': return t(DOCS_SELECTION_WORDS.links.title);
    case 'category': return categoryLabel(categories, selection.category);
    case 'subject': return selection.title || knownSubject(names, { kind: selection.subjectKind, subject_id: selection.subjectID })?.title || t(DOCS_SELECTION_WORDS.subject.title);
    case 'folder': return selection.title;
    case 'search': return `“${selection.query}”`;
  }
}

/**
 * One row per category on each half, in the summary's order (the
 * workspace's own). A category is on a half when that half's sources hold
 * something in it; one nothing is in yet sits in WORK, where a person files
 * into it. A Docs older than `by_source` puts every category in WORK.
 */
function railHalves(summary: DocsSummaryResponse | null): Record<DocsRailHalf, Array<{ category: DocsCategory; label: string; count: number }>> {
  const halves: Record<DocsRailHalf, Array<{ category: DocsCategory; label: string; count: number }>> = { work: [], library: [] };
  if (!summary) return halves;
  if (!summary.by_source) {
    halves.work = summary.categories.map(({ category, label, count }) => ({ category, label, count }));
    return halves;
  }
  const totals: Record<DocsRailHalf, Map<DocsCategory, number>> = { work: new Map(), library: new Map() };
  for (const row of summary.by_source) {
    if (row.count === 0) continue;
    const bucket = totals[docsRailHalf(row.source)];
    bucket.set(row.category, (bucket.get(row.category) ?? 0) + row.count);
  }
  for (const { category, label } of summary.categories) {
    const onLibrary = totals.library.has(category);
    if (onLibrary) halves.library.push({ category, label, count: totals.library.get(category) ?? 0 });
    if (totals.work.has(category) || !onLibrary) halves.work.push({ category, label, count: totals.work.get(category) ?? 0 });
  }
  return halves;
}

/** The projects, leads and partners something is filed about, most documents first. */
function subjectGroups(written: DocsDocumentSummary[], names: SubjectNames, kind: 'project' | 'lead' | 'organization'): Array<{ subject: CrmSubject; count: number }> {
  const docsKind = kind === 'organization' ? 'organization' : kind;
  const counts = new Map<string, number>();
  for (const document of written) {
    for (const subject of document.subjects) {
      if (subject.kind !== docsKind) continue;
      counts.set(subject.subject_id, (counts.get(subject.subject_id) ?? 0) + 1);
    }
  }
  return [...counts]
    .flatMap(([id, count]) => {
      const subject = names.get(subjectKey(kind, id));
      return subject ? [{ subject, count }] : [];
    })
    .sort((a, b) => b.count - a.count || a.subject.title.localeCompare(b.subject.title));
}

/*
 * The Docs split (docs/DOCS.md): rail, list, document.
 * The grid is the shell's (`surface-split`, SurfaceShell), so the column
 * counts here carry `!` to win over the shell's own. The ranges do not overlap,
 * so no two of them compete for the same width:
 * - open, below 1100px: rail and document; the list gives way and the
 *   document's back link brings it back. The phone (760px and below) is one
 *   column, the shell's rule.
 * - open, 1100px and up: rail, list, document. Between 1300px and 1559px,
 *   while comments are a fourth column, the list gives way again so the
 *   text keeps at least 52ch (Ulysses-style).
 * - focus: the document alone, at one measure; the bar's panes glyph brings
 *   the rail and the list back.
 * `.docs-document--comments` (DocumentView) is the hook the `:has` reads.
 */
const DOCS_SPLIT_OPEN = cn(
  'min-[761px]:max-[1099px]:grid-cols-[var(--rail-col)_minmax(0,1fr)]!',
  'min-[1100px]:max-[1299px]:grid-cols-[var(--rail-col)_minmax(240px,320px)_minmax(0,1fr)]!',
  'min-[1560px]:grid-cols-[var(--rail-col)_minmax(240px,320px)_minmax(0,1fr)]!',
  'min-[1300px]:max-[1559px]:not-has-[.docs-document--comments]:grid-cols-[var(--rail-col)_minmax(240px,320px)_minmax(0,1fr)]!',
  'min-[1300px]:max-[1559px]:has-[.docs-document--comments]:grid-cols-[var(--rail-col)_minmax(0,1fr)]!',
);
const DOCS_SPLIT_FOCUS = 'grid-cols-[minmax(0,1fr)]! [&>.surface-rail]:hidden';
/** The list: a column of the shell, scrolling on its own beside the rail above the phone. */
const DOCS_LIST_COLUMN = cn(
  'min-w-0 min-[761px]:box-border min-[761px]:max-h-full min-[761px]:min-h-0 min-[761px]:overflow-y-auto min-[761px]:overscroll-contain min-[761px]:pr-1',
  SCROLLBAR_AFFORDANCE_CLASS,
);
/** With a document open: beside it only from 1100px, and not while comments take the room. */
const DOCS_LIST_BESIDE = 'hidden min-[1100px]:max-[1299px]:block min-[1560px]:block min-[1300px]:max-[1559px]:in-[.surface-split:not(:has(.docs-document--comments))]:block';
/**
 * The reader, and the editor at the same measure, font and size, so Edit and
 * Done move nothing. `docs-reader` is the hook that keeps the text selectable
 * (styles.css).
 */
const DOCS_READER = 'docs-reader max-w-[72ch] text-[15px] text-foreground';
/** Focus: one measure, wider by the comments column when it shows. */
const DOCS_DOCUMENT_FOCUS ='mx-auto w-[min(100%,80ch)] min-[1300px]:has-[.docs-document--comments]:w-[min(100%,calc(80ch+304px))]';

export function DocsPage() {
  const rightSidebar = useRightSidebar('docs');
  const [auth, setAuth] = useState<'loading' | 'needed' | 'ok'>('loading');
  const [configured, setConfigured] = useState(true);
  const [summary, setSummary] = useState<DocsSummaryResponse | null>(() => loadSnapshot<DocsSummaryResponse>(DOCS_SNAPSHOT.summary)?.value ?? null);
  const [written, setWritten] = useState<DocsDocumentSummary[]>(() => loadSnapshot<DocsDocumentSummary[]>(DOCS_SNAPSHOT.written)?.value ?? []);
  const [names, setNames] = useState<SubjectNames>(() => new Map());
  /** Paths an empty top-level folder must be among to get a FOLDERS row. */
  const [folderTargets, setFolderTargets] = useState<DocsFolder[]>([]);
  const [error, setError] = useState('');
  /** Core surfaces Docs' hourly sync from Core is not keeping up with. */
  const [unsynced, setUnsynced] = useState<string[]>([]);
  const [location, setLocation] = useState(readLocation);
  const { selection, documentID, folderID } = location;
  /**
   * Focus: the document alone, the rail and the list gone — iA Writer's
   * and Ulysses' one-pane mode. Remembered, because a writer who wants the
   * page to themselves wants it next time too. ⌘\ toggles it.
   */
  const [focus, setFocus] = useState(() => readStored(StorageKeys.docsFocus) === '1');

  useOwnerHeartbeat(auth === 'ok');

  const loadRail = useCallback(async () => {
    try {
      const [nextSummary, nextWritten] = await Promise.all([fetchDocsSummary(), fetchWrittenDocuments()]);
      setSummary(nextSummary);
      setWritten(nextWritten);
      setConfigured(true);
      setAuth('ok');
      setError('');
    } catch (cause) {
      if (cause instanceof ControlRequestError && (cause.status === 401 || cause.status === 403)) {
        purgeOwnerLocalState();
        setAuth('needed');
        return;
      }
      setAuth('ok');
      if (cause instanceof ControlRequestError && cause.code === 'not_configured') {
        setConfigured(false);
        setError('');
        return;
      }
      setError(cause instanceof Error ? cause.message : t('Couldn’t load Docs.'));
    }
    // Names for the subject groups and chips. Best effort: a CRM that is
    // off, or a subject past the first page, leaves a document's chip
    // reading by kind, nothing worse.
    try {
      const [projects, leads, partners] = await Promise.all([
        fetchSubjects('project', ''),
        fetchSubjects('lead', ''),
        // Partners ride behind projects and leads: a Core that does not answer for them costs the rail only that section.
        fetchSubjects('organization', '').catch(() => ({ subjects: [] as CrmSubject[], hasMore: false })),
      ]);
      const next: SubjectNames = new Map();
      for (const subject of [...projects.subjects, ...leads.subjects, ...partners.subjects]) next.set(subjectKey(subject.kind, subject.id), subject);
      setNames(next);
    } catch {
      // The rail still has Recent and the categories.
    }
    // Best effort: without the tree, Folders lists only folders that hold something.
    try {
      setFolderTargets(await fetchMoveTargets());
    } catch {
      // Folders keeps what it had.
    }
  }, []);

  useEffect(() => { void loadRail(); }, [loadRail]);

  // Best effort: a Docs that cannot say how its sync is doing draws no line.
  useEffect(() => {
    if (auth !== 'ok' || !configured) return;
    let cancelled = false;
    void fetchDocsUnhealthySurfaces().then(
      (surfaces) => { if (!cancelled) setUnsynced(surfaces); },
      () => {},
    );
    return () => { cancelled = true; };
  }, [auth, configured]);

  // Resolve a folder favorite by its immutable Docs id, then replace the URL
  // with its current path so later navigation/bookmarks follow a rename.
  useEffect(() => {
    if (!folderID || folderTargets.length === 0) return;
    const folder = folderTargets.find((entry) => entry.id === folderID);
    if (!folder) return;
    const next = { kind: 'folder', path: folder.path, title: folder.title } satisfies DocsSelection;
    setLocation({ selection: next, documentID: null, folderID: null });
    writeLocation(next, null, false);
  }, [folderID, folderTargets]);

  // The browser's Back button lands where the address says, from one
  // document's permalink to the one before, without a fresh page.
  useOwnsHistory();
  useEffect(() => {
    const onPop = () => setLocation(readLocation());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  function choose(next: DocsSelection) {
    setLocation({ selection: next, documentID: null, folderID: null });
    writeLocation(next, null, false);
  }

  /** A document just created: it opens in Edit with the title focused. */
  const [freshID, setFreshID] = useState<string | null>(null);

  function openDocument(id: string) {
    setFreshID(null);
    setLocation({ selection, documentID: id, folderID: null });
    writeLocation(selection, id, true);
  }

  // The open document's title, for the tab. `DocumentView` owns the detail.
  const [openTitle, setOpenTitle] = useState<string | null>(null);
  /** Bumped when a list's menu changed the open document: the view reads it again. */
  const [openRevision, setOpenRevision] = useState(0);

  function closeDocument() {
    setLocation({ selection, documentID: null, folderID: null });
    writeLocation(selection, null, false);
  }

  function toggleFocus() {
    setFocus((current) => {
      writeStored(StorageKeys.docsFocus, current ? '' : '1');
      return !current;
    });
  }

  /**
   * Bumped by ⇧⌘N, and once by `/docs?new=document` — the ⌘K palette's
   * verb; the list opens its New form when it changes.
   */
  const [newRequest, setNewRequest] = useState(0);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('new') !== 'document') return;
    params.delete('new');
    const query = params.toString();
    window.history.replaceState(null, '', query ? `${window.location.pathname}?${query}` : window.location.pathname);
    setNewRequest((current) => current + 1);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const command = (event.metaKey || event.ctrlKey) && !event.altKey;
      if (command && event.key === '\\') {
        event.preventDefault();
        toggleFocus();
      } else if (command && event.shiftKey && (event.key === 'N' || event.key === 'n')) {
        event.preventDefault();
        setNewRequest((current) => current + 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const refresh = useCallback(() => {
    invalidateSnapshots([DOCS_SNAPSHOT.documents, DOCS_SNAPSHOT.graph, DOCS_SNAPSHOT.summary, DOCS_SNAPSHOT.written]);
    void loadRail();
  }, [loadRail]);

  /** A list row's menu renamed, moved or archived a document. */
  function documentChanged(change: DocumentChange) {
    refresh();
    const id = change.kind === 'archived' ? change.id : change.document.id;
    if (id !== documentID) return;
    if (change.kind === 'archived') closeDocument(); else setOpenRevision((current) => current + 1);
  }

  // Each rail row's menu: Open and Copy link for a view; a
  // folder adds Star, as the Mac's rail does (`DocsRailView.favoriteMenu`).
  const railMenu = useRowMenu();

  // Two halves by source, not by category name: a brief Core published
  // sits in LIBRARY, a brief a person wrote in WORK.
  const halves = useMemo(() => railHalves(summary), [summary]);
  const projects = useMemo(() => subjectGroups(written, names, 'project'), [written, names]);
  const leads = useMemo(() => subjectGroups(written, names, 'lead'), [written, names]);
  const partners = useMemo(() => subjectGroups(written, names, 'organization'), [written, names]);
  const folders = useMemo(() => docsRailFolders(summary?.folders ?? [], folderTargets.map((folder) => folder.path)), [summary, folderTargets]);
  // Names for a category view's title: the summary's, which the rail draws,
  // until it has loaded, then the category list's.
  const categories = useDocsCategories();
  const categoryNames = useMemo<CategoryNames>(
    () => summary?.categories.map(({ category, label }) => ({ id: category, label })) ?? categories,
    [summary, categories],
  );
  const [editingCategories, setEditingCategories] = useState(false);

  // A `view=category:<id>` address names a category this workspace may not
  // have (deleted, or a bookmark from another workspace): Recent, once the
  // summary says so.
  useEffect(() => {
    if (auth !== 'ok' || !summary || selection.kind !== 'category') return;
    if (summary.categories.some((row) => row.category === selection.category)) return;
    const next = { kind: 'recent' } satisfies DocsSelection;
    setLocation((current) => ({ ...current, selection: next }));
    writeLocation(next, documentID, false);
  }, [auth, summary, selection, documentID]);

  if (auth === 'loading') {
    return <DocsSkeleton selection={selection} title={selection.kind === 'graph' ? t('Graph') : selectionTitle(selection, names, categoryNames)} documentOpen={Boolean(documentID)} focus={focus} />;
  }

  if (auth === 'needed') {
    return (
      <SignInGate title={t('Docs')} onSignedIn={loadRail} />
    );
  }

  if (!configured) {
    return (
      <SurfaceShell surface="docs" title={t('Docs')}>
        <p className="lede">{t('Docs is not connected to this workspace.')}</p>
      </SurfaceShell>
    );
  }

  const railItem = (item: DocsSelection, label: string, count?: number, favoriteTarget?: { kind: 'docs.folder'; targetRef: string }) => (
    <RailRow
      key={selectionKey(item)}
      menu={{
        rowProps: railMenu.rowProps(selectionKey(item)),
        targetProps: { 'data-row-target': '' },
        panel: railMenu.panel(selectionKey(item), (
          <RowMenuItems kind="doc_rail" context={favoriteTarget ? 'folder' : 'address'} facts={{ isFolder: !!favoriteTarget }}
            run={{ open: () => choose(item) }}
            render={{
              'copy-link': () => <CopyLinkItem href={selectionHref(item)} />,
              star: favoriteTarget ? () => <StarItem target={{ kind: favoriteTarget.kind, target_ref: favoriteTarget.targetRef }} /> : undefined,
            }}
          />
        ), { className: 'mr-1.5' }),
      }}
      title={label}
      swapTrailing
      trailing={(count !== undefined && count > 0) || favoriteTarget ? (
        <span className="inline-flex items-center gap-1">
          {count !== undefined && count > 0 && <small>{count}</small>}
          {favoriteTarget && <FavoriteMark kind={favoriteTarget.kind} targetRef={favoriteTarget.targetRef} />}
        </span>
      ) : undefined}
      active={selectionKey(item) === selectionKey(selection)}
      onSelect={() => choose(item)}
    />
  );

  // One baseline across the columns: the rail's first head, the list's label
  // and the document bar are each a 36px row, so nothing steps down.
  const rail = (
    <nav aria-label={t('Docs')} className="[&>.rail-section:first-child>.rail-section-head]:min-h-9">
      <RailSection title={t('Explore')} {...railBlockProps('docs', 'explore')}>
        <ul className={railListClass}>
          {railItem({ kind: 'graph' }, t('Graph'))}
        </ul>
      </RailSection>
      <RailSection
        title={t('Work')}
        {...railBlockProps('docs', 'work')}
        accessory={(
          <Tip label={t('Edit categories')}>
            <Button type="button" variant="ghost" size="icon-xs" className="mr-1.5 text-muted-foreground" aria-label={t('Edit categories')} onClick={() => setEditingCategories(true)}>
              <TagsIcon aria-hidden="true" />
            </Button>
          </Tip>
        )}
      >
        <ul className={railListClass}>
          {railItem({ kind: 'recent' }, t('Recent'))}
          {/* Always drawn, as on the Mac: a saved link lands here, so the row is findable before the first save. */}
          {railItem({ kind: 'links' }, t('Links'), summary?.links ?? 0)}
          {(summary?.unfiled ?? 0) > 0 ? railItem({ kind: 'unfiled' }, t('Unfiled'), summary?.unfiled) : null}
          {halves.work.map(({ category, label, count }) => railItem({ kind: 'category', category, half: 'work' }, label, count))}
        </ul>
      </RailSection>
      <RailSection title={t('By project')} {...railBlockProps('docs', 'projects')} count={projects.length}>
        <ul className={railListClass}>
          {projects.map(({ subject, count }) => railItem(
            { kind: 'subject', subjectKind: 'project', subjectID: subject.id, title: subject.title },
            subject.title,
            count,
          ))}
        </ul>
      </RailSection>
      <RailSection title={t('By lead')} {...railBlockProps('docs', 'leads')} count={leads.length}>
        <ul className={railListClass}>
          {leads.map(({ subject, count }) => railItem(
            { kind: 'subject', subjectKind: 'lead', subjectID: subject.id, title: subject.title },
            subject.title,
            count,
          ))}
        </ul>
      </RailSection>
      <RailSection title={t('By partner')} {...railBlockProps('docs', 'partners')} count={partners.length}>
        <ul className={railListClass}>
          {partners.map(({ subject, count }) => railItem(
            { kind: 'subject', subjectKind: 'organization', subjectID: subject.id, title: subject.title },
            subject.title,
            count,
          ))}
        </ul>
      </RailSection>
      <RailSection title={t('Folders')} {...railBlockProps('docs', 'folders')} count={folders.length}>
        <ul className={railListClass}>
          {folders.map(({ path, title, count }) => {
            const folder = folderTargets.find((candidate) => candidate.path === path);
            return railItem(
              { kind: 'folder', path, title },
              title,
              count,
              folder ? { kind: 'docs.folder', targetRef: folder.id } : undefined,
            );
          })}
        </ul>
      </RailSection>
      <RailSection title={t('Library')} {...railBlockProps('docs', 'library')} count={halves.library.length} empty={t('Nothing mirrored here yet.')}>
        <ul className={railListClass}>
          {halves.library.map(({ category, label, count }) => railItem({ kind: 'category', category, half: 'library' }, label, count))}
        </ul>
      </RailSection>
    </nav>
  );

  // LIBRARY is a mirror: nothing is written there. The list's own guard
  // (`canCreate` in `DocumentList`) says the same thing about the form.
  const canCreate = selection.kind !== 'search' && selection.kind !== 'graph' && selection.kind !== 'links'
    && !(selection.kind === 'category' && selection.half === 'library');

  return (
    <SurfaceShell
      surface="docs"
      title={t('Docs')}
      openTitle={documentID ? openTitle : null}
      className={!documentID ? undefined : focus ? DOCS_SPLIT_FOCUS : DOCS_SPLIT_OPEN}
      open={Boolean(documentID)}
      rightSidebar={{ open: rightSidebar.open, onToggle: rightSidebar.toggle, available: Boolean(documentID), hideToggleOnPhone: false }}
      rail={rail}
      create={canCreate ? <SurfaceCreate label={t('New document… (⇧⌘N)')} items={[{ label: t('New document…'), onSelect: () => setNewRequest((current) => current + 1) }]} /> : undefined}
      list={(
        <div className={cn(DOCS_LIST_COLUMN, documentID && (focus ? 'hidden' : DOCS_LIST_BESIDE))}>
          {selection.kind === 'graph' ? <DocsGraph selectedID={documentID} onOpen={openDocument} /> : (
            <DocumentList
              key={selectionKey(selection)}
              selection={selection}
              title={selectionTitle(selection, names, categoryNames)}
              selectedID={documentID}
              newRequest={newRequest}
              onOpen={openDocument}
              onShowGraph={() => choose({ kind: 'graph' })}
              onCreated={(document) => { refresh(); openDocument(document.id); setFreshID(document.id); }}
              onChanged={documentChanged}
            />
          )}
        </div>
      )}
      before={(error || unsynced.length > 0) && (
        <>
          {unsynced.length > 0 && <ErrorNotice role="status" message={t('Not syncing: {surfaces}.', { surfaces: unsynced.join(', ') })} />}
          {error && <ErrorNotice message={error} action={<Button type="button" variant="outline" size="xs" onClick={() => void loadRail()}>{t('Retry')}</Button>} />}
        </>
      )}
    >
      {documentID && (
        <div className={cn('min-w-0', focus && DOCS_DOCUMENT_FOCUS)}>
          <DocumentView
            key={`${documentID}:${openRevision}`}
            documentID={documentID}
            startEditing={documentID === freshID}
            listTitle={selectionTitle(selection, names, categoryNames)}
            names={names}
            commentsOpen={rightSidebar.open}
            onCommentsOpenChange={rightSidebar.setOpen}
            focus={focus}
            onToggleFocus={toggleFocus}
            onBack={closeDocument}
            onOpen={openDocument}
            onChanged={refresh}
            onTitle={setOpenTitle}
          />
        </div>
      )}
      {editingCategories && <DocsCategoriesDialog onClose={() => setEditingCategories(false)} onChanged={refresh} />}
    </SurfaceShell>
  );
}


/**
 * One view as a list. New files into `/work` with a category; a search and
 * a Library view have no New, because a query is not a place and the mirror
 * is written elsewhere.
 */
function DocumentList({ selection, title, selectedID, newRequest, onOpen, onShowGraph, onCreated, onChanged }: {
  selection: Exclude<DocsSelection, { kind: 'graph' }>;
  title: string;
  selectedID: string | null;
  newRequest: number;
  onOpen: (id: string) => void;
  onShowGraph: () => void;
  onCreated: (document: DocsDocumentDetail) => void;
  /** A row's menu renamed, moved or archived a document. */
  onChanged: (change: DocumentChange) => void;
}) {
  const [documents, setDocuments] = useState<DocsDocumentSummary[]>(() => (
    selection.kind === 'search' ? [] : loadSnapshot<DocsDocumentSummary[]>(documentsSnapshotKey(selection))?.value ?? []
  ));
  const [loaded, setLoaded] = useState(documents.length > 0);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  // New from a category's row files into it; anywhere else, into none.
  const [newCategory, setNewCategory] = useState<DocsCategory | ''>(
    selection.kind === 'category' && selection.half === 'work' ? selection.category : '',
  );
  const [busy, setBusy] = useState(false);
  const categories = useDocsCategories();

  const load = useCallback(async () => {
    try {
      const rows = selection.kind === 'search'
        ? (await searchDocs(selection.query)).map(hitAsSummary)
        : await fetchDocsDocuments(selection);
      setDocuments(rows);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t load documents.'));
    }
    setLoaded(true);
  }, [selection]);

  useEffect(() => { void load(); }, [load]);

  // Each row's menu: the Mac's Docs row menu.
  const rowMenu = useRowMenu();
  const actions = useDocumentActions({
    onChanged: (change) => {
      setError('');
      void load();
      onChanged(change);
    },
    onError: setError,
  });

  useEffect(() => {
    // A request, not a value to track: only its change matters.
    if (newRequest > 0 && canCreate) setCreating(true);
  }, [newRequest]); // eslint-disable-line react-hooks/exhaustive-deps

  // A document written from a subject's list is about that subject and
  // filed under it (docs/DOCS.md, "Default path").
  const folderPath = selection.kind === 'folder' ? selection.path
    : selection.kind === 'subject' ? subjectFolderPath(selection.subjectKind, title)
      : DEFAULT_FOLDER;
  // LIBRARY is a mirror: nothing is written there.
  const canCreate = selection.kind !== 'search' && selection.kind !== 'links'
    && !(selection.kind === 'category' && selection.half === 'library');

  async function create(event: React.FormEvent) {
    event.preventDefault();
    const title = newTitle.trim();
    if (!title || busy) return;
    setBusy(true);
    try {
      const created = await createDocsDocument({
        title,
        body_md: '',
        folder_path: folderPath,
        ...(newCategory ? { category: newCategory } : {}),
        ...(selection.kind === 'subject' ? { subjects: [{ system: 'core', kind: selection.subjectKind as DocsSubjectKind, subject_id: selection.subjectID }] } : {}),
        message: t('Created from Starlings'),
      });
      setNewTitle('');
      setCreating(false);
      onCreated(created);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t create the document.'));
    } finally {
      setBusy(false);
    }
  }

  const emptyMessage = selection.kind === 'search'
    ? t('No document mentions “{query}”.', { query: selection.query })
    : selection.kind === 'recent'
      ? t('Documents you write appear here, newest first.')
      : selection.kind === 'unfiled'
      ? t('Everything is filed.')
      : selection.kind === 'links'
      ? t('No links saved yet.')
      : selection.kind === 'category'
        ? t('No {category} yet.', { category: categoryLabel(categories, selection.category) })
        : selection.kind === 'subject'
          ? t('Nothing written about this yet.')
          : t('Nothing filed here yet.');

  return (
    <section aria-labelledby="docs-list-heading">
      <div className={docsListHeadClass}>
        <h2 id="docs-list-heading" className="m-0 ml-2.5 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">{title}</h2>
        <Button type="button" variant="outline" size="sm" className="h-8 shrink-0" onClick={onShowGraph}>
          <NetworkIcon aria-hidden="true" className="size-4" />
          {t('Graph')}
        </Button>
      </div>
      {creating && (
        <NewDocumentForm
          title={newTitle}
          onTitle={setNewTitle}
          category={newCategory}
          categories={categories}
          onCategory={setNewCategory}
          busy={busy}
          onSubmit={(event) => void create(event)}
          onCancel={() => { setCreating(false); setNewTitle(''); }}
        />
      )}
      {error && <ErrorNotice message={error} action={<Button type="button" variant="outline" size="xs" onClick={() => void load()}>{t('Retry')}</Button>} />}
      {!error && !loaded && <DocumentRowsPlaceholder label="" />}
      {loaded && documents.length === 0 && !error && <p className={docsMutedClass}>{emptyMessage}</p>}
      {documents.length > 0 && (
        <DocumentRows>
          {documents.map((document) => (
            <DocumentRow
              key={document.id}
              title={document.title}
              meta={[
                document.category ? categoryLabel(categories, document.category) : null,
                rowDatesLabel(document),
                document.editable ? null : t('Library'),
              ].filter(Boolean).join(' · ')}
              excerpt={document.excerpt}
              selected={document.id === selectedID}
              onOpen={() => onOpen(document.id)}
              trailing={<FavoriteMark kind="docs.document" targetRef={document.id} />}
              menu={{
                rowProps: rowMenu.rowProps(document.id),
                panel: rowMenu.panel(document.id, (
                  <DocumentMenuItems
                    document={document}
                    onOpen={() => onOpen(document.id)}
                    onRename={() => actions.rename(document)}
                    onMove={() => actions.move(document)}
                    onArchive={() => actions.archive(document)}
                  />
                )),
              }}
            />
          ))}
        </DocumentRows>
      )}
      {actions.dialogs}
    </section>
  );
}

type SaveState = 'clean' | 'dirty' | 'saving' | 'saved' | 'failed';

/**
 * A document, read first. The header answers what it is, what it is about,
 * who touched it and when; Edit swaps the body for the textarea and the
 * title for a field. Autosave on a debounce carrying the `content_hash` that
 * was read; a `hash_mismatch` shows both bodies side by side and asks —
 * never overwrites. A mirrored document has no Edit and a way to its source.
 */
function DocumentView({ documentID, startEditing, listTitle, names, commentsOpen, onCommentsOpenChange, focus, onToggleFocus, onBack, onOpen, onChanged, onTitle }: {
  documentID: string;
  /** Just created: open in Edit with the title focused. */
  startEditing: boolean;
  listTitle: string;
  names: SubjectNames;
  commentsOpen: boolean;
  onCommentsOpenChange: (open: boolean) => void;
  focus: boolean;
  onToggleFocus: () => void;
  onBack: () => void;
  /** A link in the body to another document: opened here, beside the same list. */
  onOpen: (id: string) => void;
  onChanged: () => void;
  /** The title as it reads now — the draft while editing — for the tab. */
  onTitle: (title: string | null) => void;
}) {
  const [detail, setDetail] = useState<DocsDocumentDetail | null>(null);
  const [error, setError] = useState('');
  /** Bumped by Retry on a document that did not open. */
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState(false);
  /** A new document's title takes the focus, not the empty body. */
  const [focusTitle, setFocusTitle] = useState(false);
  const categories = useDocsCategories();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('clean');
  /** The body's save failed; Retry sends it again. */
  const [saveError, setSaveError] = useState('');
  /** A category, subject, rename, move or share change failed, said by what. */
  const [metaError, setMetaError] = useState('');
  /** An image pasted or dropped into the body did not upload. */
  const [imageError, setImageError] = useState('');
  /** The editor, once drawn: the outline moves its cursor. */
  const editorRef = useRef<DocsEditorHandle | null>(null);
  /** The server's body when a save hit `hash_mismatch`; the two-column choice. */
  const [theirs, setTheirs] = useState<DocsDocumentDetail | null>(null);
  const [addingSubject, setAddingSubject] = useState(false);
  /** Wide enough for a fourth column; narrower, comments open in a Sheet. */
  const wide = useMediaQuery('(min-width: 1300px)');
  const commentsColumn = wide && commentsOpen;
  const [openComments, setOpenComments] = useState<number | null>(null);
  const [pendingAnchor, setPendingAnchor] = useState<DocsTextAnchor | null>(null);
  const [selectedThread, setSelectedThread] = useState<string | null>(null);
  const [highlightThreads, setHighlightThreads] = useState<ReturnType<typeof threadsOf>>([]);
  const readerRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  /** Where the column was scrolled when Edit or Done was pressed; put back once the other mode draws. */
  const scrollMemo = useRef<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [sharing, setSharing] = useState(false);
  const menu = useMenuTrigger();
  const hashRef = useRef('');
  const saveRef = useRef<(next: { title: string; body: string }, ifContentHash: string | undefined) => Promise<void>>(async () => {});
  const timer = useRef<number | null>(null);
  const inFlight = useRef(false);
  /** Done was pressed: the reader comes back once the save lands, not before. */
  const closingRef = useRef(false);

  const tabTitle = editing ? title : detail?.title ?? null;
  useEffect(() => { onTitle(tabTitle); }, [tabTitle, onTitle]);
  const pendingRef = useRef<{ title: string; body: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchDocsDocument(documentID).then((loaded) => {
      if (cancelled) return;
      setDetail(loaded);
      hashRef.current = loaded.content_hash;
      setError('');
      // Opened by hand: into the device's recents, the list Home's RECENT
      // and the ⌘K palette share.
      storeRecent(documentSearchRow(loaded, loaded.category ? categoryLabel(categories, loaded.category) : null));
      // A draft this tab did not get to save. Against the same
      // hash it is simply the text, back, still unsaved; against a newer
      // hash the document moved underneath it, which is the conflict choice.
      const draft = loaded.editable ? readDraft(loaded.id) : null;
      if (draft && (draft.title !== loaded.title || draft.body !== (loaded.body_md ?? ''))) {
        setTitle(draft.title);
        setBody(draft.body);
        setEditing(true);
        if (draft.contentHash === loaded.content_hash) {
          setSaveState('dirty');
          timer.current = window.setTimeout(() => {
            timer.current = null;
            void saveRef.current({ title: draft.title, body: draft.body }, loaded.content_hash);
          }, AUTOSAVE_MS);
        } else {
          // The draft keeps the hash it was written against, so a reload
          // brings this choice back instead of saving over theirs.
          hashRef.current = draft.contentHash;
          setTheirs(loaded);
          setSaveState('failed');
        }
        return;
      }
      setTitle(loaded.title);
      setBody(loaded.body_md ?? '');
      if (startEditing && loaded.editable) {
        setEditing(true);
        setFocusTitle(true);
      }
    }).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : t('Couldn’t open the document.'));
    });
    return () => { cancelled = true; };
  }, [documentID, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useCallback(async (next: { title: string; body: string }, ifContentHash: string | undefined) => {
    if (!detail) return;
    if (inFlight.current) {
      pendingRef.current = next;
      return;
    }
    inFlight.current = true;
    setSaveState('saving');
    try {
      const updated = await updateDocsDocument(detail.id, {
        ...(next.title.trim() && next.title.trim() !== detail.title ? { title: next.title.trim() } : {}),
        body_md: next.body,
        ...(ifContentHash ? { if_content_hash: ifContentHash } : {}),
      });
      hashRef.current = updated.content_hash;
      setDetail(updated);
      setTheirs(null);
      setSaveState('saved');
      setSaveError('');
      clearDraft(updated.id);
      // Done waits for this save; with nothing newer queued, the reader comes back.
      if (closingRef.current && !pendingRef.current) {
        closingRef.current = false;
        switchMode(false);
      }
      onChanged();
    } catch (cause) {
      closingRef.current = false;
      if (cause instanceof ControlRequestError && cause.code === 'hash_mismatch') {
        // Somebody — a person, an agent — wrote in between. Show theirs
        // beside ours and let the writer choose.
        try {
          setTheirs(await fetchDocsDocument(detail.id));
        } catch {
          // The conflict banner still says what happened; Keep mine re-reads.
        }
        setSaveState('failed');
        setSaveError('');
      } else {
        setSaveState('failed');
        setSaveError(cause instanceof Error ? cause.message : t('Couldn’t save the document.'));
      }
    } finally {
      inFlight.current = false;
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending) void save(pending, hashRef.current);
    }
  }, [detail, onChanged]);
  saveRef.current = save;

  // Another document, the list or Back unmounts this view without a page
  // load: the save the debounce was holding goes now. The draft stays until
  // Docs acknowledges, so a failure or a conflict comes back on the next open.
  const flushRef = useRef<() => void>(() => {});
  flushRef.current = () => {
    if (!timer.current) return;
    window.clearTimeout(timer.current);
    timer.current = null;
    void save({ title, body }, hashRef.current);
  };
  useEffect(() => () => flushRef.current(), []);

  // A passage chosen in the reader offers Comment; reading only, never in
  // Edit (decision 5 on).
  const readerSelection = useReaderSelection(readerRef, Boolean(detail) && !editing && !pendingAnchor);
  // Keyed on the mode too: Done draws a new reader, whose text needs lighting again.
  useAnchorHighlights(readerRef, highlightThreads, selectedThread, editing ? '' : detail?.body_md ?? '');

  // The threads, for the highlights; the column keeps its own copy and
  // reports the open count. Re-read when the count moves.
  useEffect(() => {
    if (!detail) return;
    let cancelled = false;
    void fetchDocsAnnotations(detail.id).then((annotations) => {
      if (!cancelled) setHighlightThreads(threadsOf(annotations));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [detail, openComments]);

  const onOpenCount = useCallback((count: number) => setOpenComments(count), []);

  function scrollToQuote(anchor: DocsTextAnchor) {
    const root = readerRef.current;
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const index = (node as Text).data.indexOf(anchor.quote.slice(0, 40));
      if (index !== -1) {
        (node.parentElement ?? root).scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }
    }
  }

  function edit(next: { title?: string; body?: string }) {
    const nextTitle = next.title ?? title;
    const nextBody = next.body ?? body;
    if (next.title !== undefined) setTitle(next.title);
    if (next.body !== undefined) setBody(next.body);
    // Against the hash this text was written on: while a conflict is open
    // that is still the old one, so a reload asks again.
    if (detail) writeDraft(detail.id, { title: nextTitle, body: nextBody, contentHash: hashRef.current });
    if (theirs) return; // A conflict is resolved by a button, not by typing.
    setSaveState('dirty');
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      void save({ title: nextTitle, body: nextBody }, hashRef.current);
    }, AUTOSAVE_MS);
  }

  /** Edit or Done: the column keeps its place across the swap. */
  function switchMode(next: boolean) {
    scrollMemo.current = scrollerOf(sectionRef.current).scrollTop;
    setEditing(next);
  }

  function restoreScroll() {
    if (scrollMemo.current === null) return;
    scrollerOf(sectionRef.current).scrollTop = scrollMemo.current;
  }

  useLayoutEffect(() => {
    restoreScroll();
    // The editor may still be loading; it puts the place back itself when it draws.
    if (!editing) scrollMemo.current = null;
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Save what is pending now, without waiting for the debounce. */
  function saveNow() {
    if (timer.current) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    void save({ title, body }, hashRef.current);
  }

  /**
   * Done: whatever is pending goes now, and the reader comes back once Docs
   * has it. A failed save keeps the editor and says so, with Retry.
   */
  function finishEditing() {
    if (theirs) return;
    if (saveState === 'dirty' || saveState === 'failed') {
      closingRef.current = true;
      saveNow();
      return;
    }
    if (saveState === 'saving') {
      closingRef.current = true;
      return;
    }
    switchMode(false);
  }

  // ⌘S saves now, Escape leaves editing (saving
  // what is pending) or, reading, goes back to the list. A menu or a
  // picker that is open takes Escape for itself first.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const command = (event.metaKey || event.ctrlKey) && !event.altKey;
      if (command && !event.shiftKey && (event.key === 's' || event.key === 'S')) {
        event.preventDefault();
        if (!editing || theirs) return;
        saveNow();
        return;
      }
      if (event.key === 'Escape') {
        // An input method's Escape cancels its composition, nothing more.
        if (event.isComposing || event.keyCode === 229) return;
        // A menu, a picker or a dialog took this Escape first.
        if (event.defaultPrevented || menuOpen || addingSubject || actions.open || sharing) return;
        if (theirs) return;
        if (editing) finishEditing(); else onBack();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Leaving with unsaved text is the one thing the browser can warn about.
  // A link to another page is a page load meanwhile, so the warning holds.
  useLeaveGuard(saveState === 'dirty' || saveState === 'saving' || Boolean(theirs));
  useEffect(() => {
    if (saveState !== 'dirty' && saveState !== 'saving' && !theirs) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [saveState, theirs]);

  function keepMine() {
    if (!theirs) return;
    void save({ title, body }, theirs.content_hash);
  }

  /** Theirs replaces the text in this tab, which nothing else keeps: ask first. */
  async function takeTheirs() {
    if (!theirs) return;
    const confirmed = await confirmDataLoss({
      title: t('Take the saved version?'),
      body: t('The saved version replaces your text. This can’t be undone.'),
      action: t('Take theirs'),
    });
    if (!confirmed) return;
    setDetail(theirs);
    setTitle(theirs.title);
    setBody(theirs.body_md ?? '');
    hashRef.current = theirs.content_hash;
    clearDraft(theirs.id);
    setTheirs(null);
    setSaveState('clean');
  }

  /**
   * The answer to a category, subject, rename, move or share write. Docs'
   * `content_hash` is the body's alone, so a hash that moved means somebody
   * wrote the body meanwhile: with text of ours in hand that is the conflict
   * choice, never a quiet new base for the next autosave to write over.
   */
  function adopt(updated: DocsDocumentDetail) {
    if (updated.content_hash === hashRef.current) {
      setDetail(updated);
      return;
    }
    const ours = editing && (saveState === 'dirty' || saveState === 'saving' || saveState === 'failed' || body !== (detail?.body_md ?? ''));
    if (!ours) {
      hashRef.current = updated.content_hash;
      setDetail(updated);
      if (editing) setBody(updated.body_md ?? '');
      return;
    }
    if (timer.current) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    setDetail((current) => (current ? { ...updated, body_md: current.body_md, content_hash: current.content_hash, version: current.version } : updated));
    setTheirs(updated);
    setSaveState('failed');
  }

  function failed(what: string, cause: unknown) {
    setMetaError(failureText(what, cause));
  }

  async function replaceSubjects(subjects: DocsSubject[]) {
    if (!detail) return;
    try {
      adopt(await setDocsSubjects(detail.id, subjects));
      setMetaError('');
      onChanged();
    } catch (cause) {
      failed(t('Couldn’t change the subjects.'), cause);
    }
  }

  function addSubject(picked: DocsSubject) {
    if (!detail) return;
    const subject = docsSubjectOf(picked);
    setAddingSubject(false);
    if (detail.subjects.some((existing) => existing.kind === subject.kind && existing.subject_id === subject.subject_id)) return;
    void replaceSubjects([...detail.subjects, subject]);
  }

  function removeSubject(subject: DocsSubject) {
    if (!detail) return;
    void replaceSubjects(detail.subjects.filter((existing) => !(existing.kind === subject.kind && existing.subject_id === subject.subject_id)));
  }

  async function setCategory(category: DocsCategory | '') {
    if (!detail) return;
    try {
      adopt(await updateDocsDocument(detail.id, { category: category || null }));
      setMetaError('');
      onChanged();
    } catch (cause) {
      failed(t('Couldn’t change the category.'), cause);
    }
  }

  // Rename…, Move to… and Archive: the same calls and dialogs as a row's menu.
  const actions = useDocumentActions({
    onChanged: (change) => {
      if (change.kind === 'archived') {
        onChanged();
        onBack();
        return;
      }
      adopt(change.document);
      if (!editing) setTitle(change.document.title);
      setMetaError('');
      onChanged();
    },
    onError: setMetaError,
  });

  const headingID = `docs-document-${documentID}`;

  // `[[wikilinks]]` become addresses on this surface through the links Docs
  // resolved when it saved the body; an unresolved one stays as words.
  const resolveWikilink = useCallback((target: string): string | undefined => {
    if (!detail) return undefined;
    const wanted = target.trim().toLowerCase();
    const hit = detail.links.find((link) => link.to_id && link.target.trim().toLowerCase() === wanted);
    return hit?.to_id ? documentHref(hit.to_id) : undefined;
  }, [detail]);

  // `docs-image:<id>` in the body, read with this member's session.
  const renderImage = useCallback<ImageRenderer>(
    (src, alt, inline) => <DocumentImage documentID={detail?.id} src={src} alt={alt} inline={inline} />,
    [detail?.id],
  );

  /** A pasted or dropped image, up to Docs, back as the markdown that shows it. */
  const editorImages = useMemo(() => ({
    upload: async (file: File) => {
      if (!detail) throw new Error(t('Couldn’t upload the image.'));
      setImageError('');
      const image = await uploadDocsImage(detail.id, file);
      return docsImageMarkdown(image, file.name || t('Image'));
    },
    uploading: (name: string) => t('Uploading {name}…', { name }),
    onError: (message: string) => setImageError(failureText(t('Couldn’t upload the image.'), new Error(message))),
  }), [detail]);

  const outline = useMemo(() => outlineOf(editing ? body : detail?.body_md ?? ''), [editing, body, detail?.body_md]);
  const words = useMemo(() => (editing ? wordCount(body) : 0), [editing, body]);

  /** The outline: the heading's line in the editor, the nth heading in the reader. */
  function showHeading(index: number) {
    const entry = outline[index];
    if (!entry) return;
    if (editing) {
      editorRef.current?.showLine(entry.line);
      return;
    }
    const heading = readerRef.current?.querySelectorAll(':scope > .md > :is(h2, h3, h4, h5, h6)')[index];
    heading?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  /** A plain click on a link to another document opens it here, keeping the list beside it. */
  function openLinkedDocument(event: React.MouseEvent) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!(link instanceof HTMLAnchorElement) || link.origin !== window.location.origin) return;
    const record = parsePermalinkPath(link.pathname);
    if (record?.surface !== 'docs' || record.id === documentID) return;
    event.preventDefault();
    onOpen(record.id);
  }

  const back = (
    <div className="flex items-center gap-1">
      {/* The way back to the list, where the list is not beside the document. */}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={cn(
          'gap-1.5 pl-1 font-normal text-muted-foreground hover:text-foreground',
          focus ? 'hidden' : cn('min-[1100px]:hidden', commentsColumn && 'min-[1300px]:max-[1559px]:inline-flex'),
        )}
        onClick={onBack}
      >
        <span aria-hidden="true">←</span> {listTitle}
      </Button>
    </div>
  );

  /** Beside Edit and ⋯, the same place in both modes — not alone on the left. */
  const panes = (
    <Tip label={`${focus ? t('Show') : t('Hide')} the rail and the list (⌘\\)`}>
      <Button
        type="button"
        variant={focus ? 'secondary' : 'outline'}
        size="icon"
        aria-pressed={focus}
        aria-label={focus ? t('Show the rail and the list') : t('Hide the rail and the list')}
        onClick={onToggleFocus}
      >
        <PanesIcon />
      </Button>
    </Tip>
  );

  if (error) {
    return (
      <section>
        <div className={documentBarClass}>{back}</div>
        <ErrorNotice message={error} action={<Button type="button" variant="outline" size="xs" onClick={() => { setError(''); setAttempt((current) => current + 1); }}>{t('Retry')}</Button>} />
      </section>
    );
  }

  if (!detail) {
    return (
      <section>
        <div className={documentBarClass}>{back}</div>
        <DocumentBodyPlaceholder label={t('Opening…')} />
      </section>
    );
  }

  const status = saveState === 'saving' ? 'Saving…'
    : saveState === 'saved' ? 'Saved'
      : saveState === 'dirty' ? 'Unsaved'
        : saveState === 'failed' ? (theirs ? 'Changed elsewhere' : 'Couldn’t save')
          : '';

  const updated = new Date(detail.updated_at);
  const when = Number.isNaN(updated.valueOf()) ? '' : updated.toLocaleDateString(dateLocale, {
    day: 'numeric',
    month: 'short',
    ...(updated.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }),
  });

  const comments = (
    <DocumentComments
      key={detail.id}
      documentID={detail.id}
      pending={pendingAnchor}
      onPendingDone={() => setPendingAnchor(null)}
      selected={selectedThread}
      onSelect={setSelectedThread}
      onCountChange={onOpenCount}
      onOpenQuote={scrollToQuote}
    />
  );

  const bodyClass = 'min-h-[min(60vh,640px)] resize-y rounded-xl bg-card p-3.5 text-sm leading-[1.55] [tab-size:2] md:text-sm dark:bg-card';

  return (
    <section
      ref={sectionRef}
      className={commentsColumn
        // The fourth column beside the text; the text keeps at least 52ch.
        ? 'docs-document--comments min-[1300px]:grid min-[1300px]:grid-cols-[minmax(52ch,1fr)_280px] min-[1300px]:items-start min-[1300px]:gap-x-6 min-[1300px]:[&>*]:min-w-0 min-[1300px]:[&>*:not([data-comments-column])]:col-start-1'
        : undefined}
      aria-labelledby={headingID}
    >
      <div className={documentBarClass}>
        {back}
        <div className="ml-auto flex items-center gap-2">
          {detail && <FavoriteToggle kind="docs.document" targetRef={detail.id} />}
          {editing && <span className="hidden text-xs text-muted-foreground tabular-nums sm:inline">{plural(words, { one: '{count} word', other: '{count} words' })}</span>}
          {status && (
            <Badge
              variant={saveState === 'failed' ? 'destructive' : 'outline'}
              className={saveState === 'failed' ? undefined : 'font-normal text-muted-foreground'}
              role="status"
            >
              {status}
            </Badge>
          )}
          {panes}
          <Button type="button" variant="secondary" onClick={() => setSharing(true)}>{t('Share')}</Button>
          {(detail.editable || detail.source_url) && (
            <ButtonGroup>
              {detail.editable && (
                editing
                  ? <Button type="button" onClick={finishEditing} disabled={Boolean(theirs)}>{t('Done')}</Button>
                  : <Button type="button" variant="secondary" onPointerEnter={() => void loadEditor()} onFocus={() => void loadEditor()} onClick={() => switchMode(true)}>{t('Edit')}</Button>
              )}
              {detail.source_url && !detail.editable && (
                <Button asChild variant="secondary"><a href={detail.source_url} target="_blank" rel="noreferrer">{t('Open source')}</a></Button>
              )}
              {detail.editable && (
                <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
                  <DropdownMenuTrigger asChild>
                    <Button
                      ref={menu.trigger}
                      type="button" variant="secondary" size="icon"
                      aria-label={t('More')}
                    >
                      <ChevronIcon expanded={menuOpen} />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="max-w-80" onCloseAutoFocus={menu.onCloseAutoFocus}>
                    <DropdownMenuLabel className="truncate text-xs font-normal text-muted-foreground">{detail.path}</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DocumentMenuItems
                      document={detail}
                      star={false}
                      onRename={editing ? undefined : () => actions.rename(detail)}
                      onMove={() => actions.move(detail)}
                      onArchive={() => actions.archive(detail)}
                    />
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </ButtonGroup>
          )}
        </div>
      </div>

      <header className="mt-4 mb-5">
        {editing ? (
          <Input
            id={headingID}
            className="h-auto rounded-none border-0 border-b bg-transparent px-0 pt-0 pb-1 text-[26px] leading-[1.2] font-medium shadow-none focus-visible:border-(--accent) focus-visible:ring-0 md:text-[26px] dark:bg-transparent"
            type="text"
            value={title}
            maxLength={200}
            autoFocus={focusTitle}
            aria-label={t('Title')}
            onChange={(event) => edit({ title: event.target.value })}
          />
        ) : (
          <h1 id={headingID} className="m-0 text-[26px] leading-[1.2] font-medium tracking-normal">{detail.title}</h1>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] text-muted-foreground">
          {editing ? (
            <NativeSelect
              size="sm"
              className="h-7 py-0.5 pr-7 pl-1.5 text-xs md:text-xs"
              aria-label={t('Category')}
              value={detail.category ?? ''}
              onChange={(event) => void setCategory(event.target.value as DocsCategory | '')}
            >
              <NativeSelectOption value="">{t('No category')}</NativeSelectOption>
              {categoryOptions(categories, detail.category).map((category) => (
                <NativeSelectOption key={category.id} value={category.id}>{category.label}</NativeSelectOption>
              ))}
            </NativeSelect>
          ) : (
            <span>{detail.category ? categoryLabel(categories, detail.category) : detail.editable ? t('Document') : t('Library')}</span>
          )}
          {!detail.editable && (
            <>
              {mirrorLabel(detail) !== (detail.category ? categoryLabel(categories, detail.category) : '') && (
                <>
                  <MetaSep />
                  <span>{mirrorLabel(detail)}</span>
                </>
              )}
              <MetaSep />
              <span>Synced {when || updatedAtLabel(detail.updated_at)}</span>
            </>
          )}
          {(detail.subjects.length > 0 || editing) && (
            <>
              <MetaSep />
              <span>about</span>
              {detail.subjects.map((subject) => (
                <SubjectChip
                  key={`${subject.system}:${subject.kind}:${subject.subject_id}`}
                  subject={subject}
                  names={names}
                  onRemove={editing ? () => removeSubject(subject) : undefined}
                />
              ))}
              {editing && (
                <span className="relative inline-flex">
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="rounded-full border-dashed font-normal text-muted-foreground hover:text-foreground"
                    onClick={() => setAddingSubject((current) => !current)}
                    aria-expanded={addingSubject}
                  >
                    {detail.subjects.length > 0 ? '+' : t('Add a project, lead or partner')}
                  </Button>
                  {addingSubject && <SubjectPicker kinds={DOCUMENT_SUBJECT_KINDS} onPick={addSubject} onClose={() => setAddingSubject(false)} />}
                </span>
              )}
            </>
          )}
          {detail.editable && detail.updated_by && <><MetaSep /><span>{detail.updated_by}</span></>}
          {detail.editable && when && <><MetaSep /><span>{when}</span></>}
          <MetaSep />
          <span>v{detail.version}</span>
          {/* A loose link save is its author's until it is filed (meet#431). */}
          {detail.private && <><MetaSep /><span>{t('Only you')}</span></>}
          {(openComments ?? detail.open_annotations) > 0 && (
            <>
              <MetaSep />
              <Button type="button" variant="link" className="h-auto p-0 text-[13px] font-normal text-foreground underline decoration-border underline-offset-[0.15em] hover:decoration-current" onClick={() => onCommentsOpenChange(true)}>
                {plural(openComments ?? detail.open_annotations ?? 0, { one: '{count} open comment', other: '{count} open comments' })}
              </Button>
            </>
          )}
        </div>
      </header>

      {/* Headings at the top two levels; a body with fewer than two has no outline. */}
      {outline.filter((entry) => entry.level <= 2).length > 1 && (
        <DocToc
          label={t('Outline')}
          className="mb-5"
          links={outline.flatMap((entry, index) => (entry.level <= 2
            ? [{ href: `#${headingID}-${index}`, label: entry.title, onSelect: () => showHeading(index) }]
            : []))}
        />
      )}

      {!detail.editable && (
        <Alert className="mb-3 bg-muted" role={undefined}>
          <AlertDescription>{t('Mirrored from {source}; change it there.', { source: sourceName(detail.source_system) })}</AlertDescription>
        </Alert>
      )}
      {saveError && !theirs && <ErrorNotice message={saveError} action={editing ? <Button type="button" variant="outline" size="xs" onClick={saveNow}>{t('Retry')}</Button> : undefined} />}
      {metaError && <ErrorNotice message={metaError} />}
      {imageError && editing && <ErrorNotice message={imageError} />}

      {actions.dialogs}
      {sharing && (
        <DocsShareDialog
          document={detail}
          onClose={() => setSharing(false)}
          onDocumentChange={(next) => {
            adopt(next);
            onChanged();
          }}
        />
      )}

      {theirs && (
        <Alert className="mb-3 border-destructive/55 bg-destructive/10 text-foreground">
          <AlertDescription className="block text-foreground">
            <p className="m-0">
              {theirs.updated_by
                ? t('This document changed while you were writing ({person}). Yours is on the left, the saved version on the right.', { person: theirs.updated_by })
                : t('This document changed while you were writing. Yours is on the left, the saved version on the right.')}
            </p>
            <div className="mt-2.5 flex gap-2">
              <Button type="button" onClick={keepMine}>{t('Keep mine')}</Button>
              <Button type="button" variant="secondary" onClick={() => void takeTheirs()}>{t('Take theirs')}</Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {theirs ? (
        <div className="grid grid-cols-1 gap-3 min-[761px]:grid-cols-2">
          <Card className="gap-2 p-3 shadow-none">
            <CardHeader className="px-0"><h3 className={columnHeadClass}>{t('Yours')}</h3></CardHeader>
            <CardContent className="px-0">
              <Textarea className={bodyClass} value={body} aria-label={t('Your body')} onChange={(event) => edit({ body: event.target.value })} />
            </CardContent>
          </Card>
          <Card className="gap-2 p-3 shadow-none">
            <CardHeader className="px-0"><h3 className={columnHeadClass}>{t('Saved')}</h3></CardHeader>
            <CardContent className="px-0">
              <Textarea className={bodyClass} value={theirs.body_md ?? ''} aria-label={t('Saved body')} readOnly />
            </CardContent>
          </Card>
        </div>
      ) : editing ? (
        <div className={DOCS_READER}>
          {/* While the chunk loads, the text as it is, so nothing jumps when the editor lands. */}
          <Suspense fallback={<div className="min-h-[min(60vh,640px)] leading-[1.6] whitespace-pre-wrap [overflow-wrap:anywhere]">{body}</div>}>
            <DocsEditor
              value={body}
              label={t('Body')}
              placeholder={t('Write in markdown.')}
              autoFocus={!focusTitle}
              onChange={(next) => edit({ body: next })}
              titles={docsTitles}
              images={editorImages}
              onReady={(handle) => { editorRef.current = handle; restoreScroll(); scrollMemo.current = null; }}
            />
          </Suspense>
        </div>
      ) : (
        // hover: the links inside are the targets, and `.md a` draws their hover.
        <div className={DOCS_READER} ref={readerRef} onClick={openLinkedDocument}><DocumentMarkdown text={detail.body_md ?? ''} resolveWikilink={resolveWikilink} renderImage={renderImage} /></div>
      )}

      {readerSelection && !editing && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="fixed z-[7] -translate-x-full rounded-full bg-card text-xs font-[560] shadow-[0_8px_24px_rgb(0_0_0/30%)] dark:bg-card"
          style={{ left: readerSelection.x, top: readerSelection.y + 6 }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setPendingAnchor(readerSelection.anchor);
            onCommentsOpenChange(true);
            setSelectedThread(null);
            window.getSelection()?.removeAllRanges();
          }}
        >
          <CommentIcon /> Comment
        </Button>
      )}

      {commentsColumn && (
        <div data-comments-column="" className={cn('min-[1300px]:sticky min-[1300px]:top-0 min-[1300px]:col-start-2 min-[1300px]:row-[1/span_20] min-[1300px]:max-h-screen min-[1300px]:overflow-y-auto', SCROLLBAR_AFFORDANCE_CLASS)}>
          {comments}
        </div>
      )}
      {!wide && (
        <Sheet open={commentsOpen} onOpenChange={onCommentsOpenChange}>
          <SheetContent
            side="right"
            className="w-full gap-0 overflow-y-auto p-4 pt-3 sm:max-w-sm [&_[data-comments-head]]:pr-8"
            aria-describedby={undefined}
            onEscapeKeyDown={(event) => {
              // The composer's own Escape cancels the comment and keeps the sheet.
              if ((event.target as Element | null)?.closest?.('[data-docs-composer]')) {
                event.preventDefault();
                return;
              }
              // Ours to close; the page's Escape (back to the list) must not fire too.
              event.stopPropagation();
            }}
          >
            <SheetTitle className="sr-only">{t('Comments')}</SheetTitle>
            {comments}
          </SheetContent>
        </Sheet>
      )}

      {!editing && detail.backlinks.length > 0 && (
        <div className="mt-5.5">
          <h3 className={columnHeadClass}>{t('Linked from')}</h3>
          {/* hover: the links inside are the targets; the ul only routes their clicks. */}
          <ul className="m-0 list-none p-0" onClick={openLinkedDocument}>
            {detail.backlinks.map((link) => (
              <li key={link.id} className="py-1 text-[13px]">
                <a href={documentHref(link.id)}>{link.title}</a>
                <small className="text-muted-foreground"> {link.path}</small>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** The document bar: one 36px row with the rail's first block and the list's heading. */
const documentBarClass = 'flex min-h-9 items-center justify-between gap-3';

const BODY_LINE_WIDTHS = ['w-full', 'w-[96%]', 'w-[92%]', 'w-full', 'w-[64%]'];

/** A document while it opens: its title, then two paragraphs of lines. */
function DocumentBodyPlaceholder({ label, immediate = false }: { label?: string; immediate?: boolean }) {
  return (
    <div className="mt-4 max-w-[70ch]">
      {label && <PlaceholderStatus label={label} />}
      <PlaceholderBar immediate={immediate} className="mb-6 h-7 w-[55%] rounded-lg" />
      {[0, 1].map((paragraph) => (
        <div key={paragraph} className="mb-6 grid gap-2.5">
          {BODY_LINE_WIDTHS.map((width, line) => (
            <PlaceholderBar key={line} immediate={immediate} className={cn('h-3 rounded-full', width)} />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * Docs while the session opens, drawn in the page's own columns: the rail's
 * first two blocks, the list under its heading, and the document when the
 * address opens one. The same containers as the loaded page, so nothing
 * moves when it lands.
 */
function DocsSkeleton({ selection, title, documentOpen, focus }: { selection: DocsSelection; title: string; documentOpen: boolean; focus: boolean }) {
  const rail = (
    <nav aria-label={t('Docs')} className="[&>.rail-section:first-child>.rail-section-head]:min-h-9">
      <RailSection title={t('Explore')} {...railBlockProps('docs', 'explore')}>
        <ul className={railListClass}><RailRow title={t('Graph')} active={selection.kind === 'graph'} /></ul>
      </RailSection>
      <RailSection title={t('Work')} {...railBlockProps('docs', 'work')}>
        <ul className={railListClass}><RailRow title={t('Recent')} active={selection.kind === 'recent'} /></ul>
        <RailRowsPlaceholder count={4} mark="none" subtitle={false} trailing immediate />
      </RailSection>
      <RailSection title={t('Folders')} {...railBlockProps('docs', 'folders')}>
        <RailRowsPlaceholder count={3} mark="none" subtitle={false} trailing immediate />
      </RailSection>
    </nav>
  );
  return (
    <SurfaceShell
      surface="docs"
      title={t('Docs')}
      className={!documentOpen ? undefined : focus ? DOCS_SPLIT_FOCUS : DOCS_SPLIT_OPEN}
      open={documentOpen}
      rail={rail}
      list={(
        <div className={cn(DOCS_LIST_COLUMN, documentOpen && (focus ? 'hidden' : DOCS_LIST_BESIDE))}>
          <PlaceholderStatus label={t('Opening…')} />
          <div className={docsListHeadClass}>
            <h2 className="m-0 ml-2.5 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">{title}</h2>
            <PlaceholderBar immediate className="h-8 w-[84px] shrink-0 rounded-md" />
          </div>
          <DocumentRowsPlaceholder immediate />
        </div>
      )}
    >
      {documentOpen && (
        <div className={cn('min-w-0', focus && DOCS_DOCUMENT_FOCUS)}>
          <div className={documentBarClass} />
          <DocumentBodyPlaceholder immediate />
        </div>
      )}
    </SurfaceShell>
  );
}

/** A small label over a column: Yours / Saved, Linked from. */
const columnHeadClass = 'm-0 mb-2 text-xs font-normal tracking-[0.06em] text-muted-foreground uppercase';

function MetaSep() {
  return <span className="opacity-60" aria-hidden="true">·</span>;
}

/** What a mirrored row is on its source: `newsletter_issue` reads as "Newsletter issue". */
function mirrorLabel(document: DocsDocumentDetail): string {
  const kind = document.source_kind?.replace(/_/gu, ' ') ?? 'document';
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

function sourceName(system: DocsDocumentDetail['source_system']): string {
  switch (system) {
    case 'core': return t('Records');
    case 'obsidian': return 'Obsidian';
    default: return t('Docs');
  }
}

/** A speech bubble: the comments column. */
function CommentIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M2.5 3.5a1.5 1.5 0 0 1 1.5-1.5h8a1.5 1.5 0 0 1 1.5 1.5v5A1.5 1.5 0 0 1 12 10H7.2L4.5 12.6V10H4a1.5 1.5 0 0 1-1.5-1.5Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

/** Two panes beside a page — the rail and the list a writer can put away. */
function PanesIcon() {
  return (
    <svg className="size-[18px]" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <rect x="1.75" y="3" width="14.5" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M6.25 3v12M10.75 3v12" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

/**
 * What a document is about, as a way into Work when Work knows the subject:
 * a Badge, with a remove Button while editing.
 */
function SubjectChip({ subject, names, onRemove }: { subject: DocsSubject; names: SubjectNames; onRemove?: () => void }) {
  const known = knownSubject(names, subject);
  const crmKind = known?.kind === 'project' || known?.kind === 'lead' || known?.kind === 'organization' ? known.kind : null;
  const label = known && crmKind ? known.title : subject.kind;
  const href = known && crmKind
    ? subjectHref({ kind: crmKind, id: subject.subject_id })
    : null;
  const name = href
    ? <a className="text-inherit no-underline hover:underline" href={href}>{label}</a>
    : <span>{label}</span>;
  return (
    <Badge variant="outline" className={cn('font-normal', onRemove && 'gap-0.5 pr-0.5')}>
      {name}
      {onRemove && (
        <Tip label={`Remove ${label}`}>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="size-4 rounded-full text-muted-foreground hover:text-destructive"
            aria-label={`Remove ${label}`}
            onClick={onRemove}
          >
            <XIcon aria-hidden="true" />
          </Button>
        </Tip>
      )}
    </Badge>
  );
}
