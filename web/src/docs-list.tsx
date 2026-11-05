import { useState, type FormEvent, type ReactNode } from 'react';
import { docsKindFor } from '@starlings/contracts/subject-kinds';
import { fetchSubjects, type CrmSubject } from './crm-work';
import { SearchablePicker } from './SearchablePicker';
import { CheckIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { Card } from '@/ui/card';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/ui/command';
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '@/ui/dialog';
import { Input } from '@/ui/input';
import { Item, ItemContent, ItemDescription, ItemTitle } from '@/ui/item';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import {
  categoryOptions,
  docsDocumentURL,
  failureText,
  fetchDocsDocument,
  fetchMoveTargets,
  moveDocsDocument,
  setDocsSubjects,
  updateDocsDocument,
  useDocsCategories,
  type DocsCategory,
  type DocsCategoryRow,
  type DocsDocumentDetail,
  type DocsDocumentSummary,
  type DocsFolder,
} from './docs';
import { CopyLinkItem, RowMenuItems, StarItem } from './row-menu-items';
import type { RowMenuController } from './use-row-menu';
import { t } from './i18n';
import { documentHref } from './work-hrefs';
import { PLACEHOLDER_FADE, PlaceholderBar } from '@/ui/placeholder-rows';

/**
 * The parts a list of documents shares: the Docs page's middle column and
 * a subject's Documents pane in Work. shadcn Item rows, and the
 * new-document form on a Card.
 */

/** The list's heading row: one 36px baseline with the rail and the document bar. */
export const docsListHeadClass = 'flex min-h-9 items-center justify-between gap-3';

/** A quiet line in a list: loading, empty. */
export const docsMutedClass = 'mt-3.5 mb-0 text-[13px] text-muted-foreground';

export function DocumentRows({ children }: { children: ReactNode }) {
  return <ul className="m-0 mt-2.5 list-none divide-y divide-border p-0">{children}</ul>;
}

/**
 * One document: title, a second line, and the excerpt. A button where the
 * list opens the document beside it, a link where it goes to Docs. The
 * row's `…` (`menu`) sits at the right edge; a filled favorite
 * mark appears there only while the document is starred.
 */
export function DocumentRow({ title, meta, excerpt, selected = false, href, onOpen, trailing, menu }: {
  title: string;
  meta: string;
  excerpt?: string | null;
  selected?: boolean;
  href?: string;
  onOpen?: () => void;
  trailing?: ReactNode;
  menu?: { rowProps: ReturnType<RowMenuController['rowProps']>; panel: ReactNode };
}) {
  const body = (
    <ItemContent className="min-w-0 gap-0.5">
      <ItemTitle className="block w-full truncate font-[560]">{title}</ItemTitle>
      <ItemDescription className="text-xs">{meta}</ItemDescription>
      {excerpt && <ItemDescription className="mt-0.5 text-[12.5px] leading-snug [overflow-wrap:anywhere]">{excerpt}</ItemDescription>}
    </ItemContent>
  );
  const controls = Number(Boolean(trailing)) + Number(Boolean(menu?.panel));
  const rowClass = cn(
    'w-full min-w-0 cursor-pointer px-2.5 py-2.5 text-left text-inherit no-underline hover-lift',
    controls === 1 && 'pr-11',
    controls === 2 && 'pr-[72px]',
    selected && 'bg-card',
  );
  return (
    <li {...menu?.rowProps} className={cn('relative', menu?.rowProps.className)}>
      <Item asChild size="sm" className={rowClass}>
        {href
          ? <a href={href} data-row-target="">{body}</a>
          : /* hover: the Item's rowClass lifts the row */ <button type="button" data-row-target="" aria-current={selected ? 'true' : undefined} onClick={onOpen}>{body}</button>}
      </Item>
      {controls > 0 && (
        <div className="absolute top-[7px] right-[3px] flex items-center gap-0.5">
          {menu?.panel}
          {trailing}
        </div>
      )}
    </li>
  );
}

const DOCUMENT_TITLE_WIDTHS = ['w-[58%]', 'w-[42%]', 'w-[66%]'];

/**
 * `DocumentRows` while the list waits: each row a title bar, a meta bar and
 * two excerpt lines, at the real row's padding, so the column does not jump
 * when the documents land. Inside a page skeleton it draws at once
 * (`immediate`); a list waiting on a loaded page keeps the 250 ms fade.
 */
export function DocumentRowsPlaceholder({ count = 6, label, immediate = false }: { count?: number; label?: string; immediate?: boolean }) {
  return (
    <>
      {label !== undefined && <span role="status" aria-live="polite" className="sr-only">{label || t('Loading…')}</span>}
      <ul className={cn('m-0 mt-2.5 list-none divide-y divide-border p-0', !immediate && PLACEHOLDER_FADE)} aria-hidden="true">
        {Array.from({ length: count }, (_, index) => (
          <li key={index} className="grid gap-1.5 px-2.5 py-2.5">
            <PlaceholderBar immediate className={cn('h-3.5 rounded-full', DOCUMENT_TITLE_WIDTHS[index % 3])} />
            <PlaceholderBar immediate className="h-2.5 w-[34%] rounded-full" />
            <PlaceholderBar immediate className="mt-0.5 h-2.5 w-[88%] rounded-full" />
          </li>
        ))}
      </ul>
    </>
  );
}

/** The page a link save points at, when it is a web address. */
function pageURL(document: DocsDocumentSummary): string | null {
  const url = document.link?.url;
  return url && /^https?:\/\//iu.test(url) ? url : null;
}

/**
 * A document's menu, in the Mac's order (`DocsBrowser.rowMenu`):
 * Open, Open page, Copy link / Rename…, Move to… / Archive / Star. A link
 * save copies the page it saved; any other document its Docs address.
 * Rename, Move and Archive are for a document Meet can write, never a
 * mirror. `open` is the caller's door; `star` is off where a star already
 * sits beside the menu.
 */
export function DocumentMenuItems({ document, onOpen, openHref, star = true, onRename, onMove, onArchive }: {
  document: DocsDocumentSummary;
  onOpen?: () => void;
  openHref?: string;
  star?: boolean;
  onRename?: () => void;
  onMove?: () => void;
  onArchive?: () => void;
}) {
  const page = pageURL(document);
  const href = openHref ?? documentHref(document.id);
  return (
    <RowMenuItems kind="doc" context="row" facts={{ isSavedLink: !!page, isEditable: document.editable }}
      run={{
        open: onOpen,
        'file-document': document.editable ? onMove : undefined,
        rename: document.editable ? onRename : undefined,
        archive: document.editable ? onArchive : undefined,
      }}
      doors={{
        open: onOpen ? undefined : { href },
        'open-page': page ? { href: page, label: t('Open page'), external: true } : undefined,
      }}
      labels={{ 'file-document': t('Move to…') }}
      render={{
        'copy-page-link': page ? () => <CopyLinkItem href={page} label={t('Copy page link')} /> : undefined,
        'copy-link': () => <CopyLinkItem href={docsDocumentURL(document.path)} />,
        star: star ? () => <StarItem target={{ kind: 'docs.document', target_ref: document.id }} /> : undefined,
      }}
    />
  );
}

/** What a menu action did to a document, for the list and the open view. */
export type DocumentChange =
  | { kind: 'moved' | 'renamed'; document: DocsDocumentDetail }
  | { kind: 'archived'; id: string };

/**
 * Rename…, Move to… and Archive for a document on any list: the dialogs and
 * the calls, in one place. The caller draws `dialogs` and hears
 * each change through `onChanged`; a failure goes to `onError`.
 */
export function useDocumentActions({ onChanged, onError }: {
  onChanged: (change: DocumentChange) => void;
  onError: (message: string) => void;
}) {
  const [moving, setMoving] = useState<{
    document: DocsDocumentSummary;
    folders: DocsFolder[];
    to: string;
    /** The Mac's three filing acts (`DocsFilingAct`): move to a folder, attach a subject, set the category. */
    mode: FilingMode;
    subject: string;
    subjects: CrmSubject[] | null;
    /** '' files it under no category. */
    category: DocsCategory | '';
  } | null>(null);
  const [renaming, setRenaming] = useState<{ document: DocsDocumentSummary; title: string } | null>(null);
  const [archiving, setArchiving] = useState<string | null>(null);

  async function move(document: DocsDocumentSummary) {
    try {
      const folders = await fetchMoveTargets();
      const current = document.path.slice(0, document.path.lastIndexOf('/')) || '/';
      setMoving({
        document,
        folders,
        to: folders.some((folder) => folder.path === current) ? current : (folders[0]?.path ?? '/work'),
        mode: 'folder',
        subject: '',
        subjects: null,
        category: document.category ?? '',
      });
    } catch (cause) {
      onError(failureText(t('Couldn’t load the folders.'), cause));
    }
  }

  /** The subjects a document can be filed about, read once when the Subject choice is first made. */
  async function loadSubjects() {
    if (!moving || moving.subjects) return;
    const pages = await Promise.allSettled((['project', 'lead', 'organization'] as const).map((kind) => fetchSubjects(kind, '')));
    const subjects = pages.flatMap((page) => (page.status === 'fulfilled' ? page.value.subjects : []));
    setMoving((current) => (current ? { ...current, subjects } : current));
  }

  async function confirmMove() {
    if (!moving) return;
    try {
      let updated: DocsDocumentDetail;
      if (moving.mode === 'subject') {
        const picked = moving.subjects?.find((subject) => `${subject.kind}:${subject.id}` === moving.subject);
        const docsKind = picked ? docsKindFor(picked.kind) : null;
        if (!picked || !docsKind) return;
        // Attach: the path stays and the subject is the relation, so the ones already on it are kept.
        const current = await fetchDocsDocument(moving.document.id);
        const already = current.subjects.some((subject) => subject.kind === docsKind && subject.subject_id === picked.id);
        updated = already ? current : await setDocsSubjects(moving.document.id, [...current.subjects, { system: 'core', kind: docsKind, subject_id: picked.id }]);
      } else if (moving.mode === 'category') {
        updated = await updateDocsDocument(moving.document.id, { category: moving.category || null });
      } else {
        updated = await moveDocsDocument(moving.document.id, moving.to);
      }
      setMoving(null);
      onChanged({ kind: 'moved', document: updated });
    } catch (cause) {
      onError(failureText(t('Couldn’t move the document.'), cause));
    }
  }

  async function confirmRename() {
    if (!renaming) return;
    const title = renaming.title.trim();
    if (!title) return;
    if (title === renaming.document.title) {
      setRenaming(null);
      return;
    }
    try {
      const updated = await updateDocsDocument(renaming.document.id, { title });
      setRenaming(null);
      onChanged({ kind: 'renamed', document: updated });
    } catch (cause) {
      onError(failureText(t('Couldn’t rename the document.'), cause));
    }
  }

  async function archive(document: DocsDocumentSummary) {
    if (archiving) return;
    setArchiving(document.id);
    try {
      await updateDocsDocument(document.id, { status: 'archived' });
      onChanged({ kind: 'archived', id: document.id });
    } catch (cause) {
      onError(failureText(t('Couldn’t archive the document.'), cause));
    } finally {
      setArchiving(null);
    }
  }

  const dialogs = (
    <>
      {moving && (
        <MoveDialog
          folders={moving.folders}
          to={moving.to}
          mode={moving.mode}
          subject={moving.subject}
          subjects={moving.subjects}
          category={moving.category}
          current={moving.document.category}
          onMode={(mode) => { setMoving({ ...moving, mode }); if (mode === 'subject') void loadSubjects(); }}
          onSubject={(subject) => setMoving({ ...moving, subject })}
          onCategory={(category) => setMoving({ ...moving, category })}
          onChoose={(to) => setMoving({ ...moving, to })}
          onMove={() => void confirmMove()}
          onClose={() => setMoving(null)}
        />
      )}
      {renaming && (
        <RenameDialog
          title={renaming.title}
          onTitle={(title) => setRenaming({ ...renaming, title })}
          onRename={() => void confirmRename()}
          onClose={() => setRenaming(null)}
        />
      )}
    </>
  );

  return {
    /** A dialog is up: the page's own Escape waits. */
    open: moving !== null || renaming !== null,
    rename: (document: DocsDocumentSummary) => setRenaming({ document, title: document.title }),
    move: (document: DocsDocumentSummary) => void move(document),
    archive: (document: DocsDocumentSummary) => void archive(document),
    dialogs,
  };
}

/**
 * Move to…: every folder a document can go to, as a tree to filter (the
 * folder list the Mac's Move sheet shows). Choosing a folder
 * marks it; Move moves there.
 */
type FilingMode = 'folder' | 'subject' | 'category';

function MoveDialog({ folders, to, mode, subject, subjects, category, current, onMode, onSubject, onCategory, onChoose, onMove, onClose }: {
  folders: DocsFolder[];
  to: string;
  mode: FilingMode;
  subject: string;
  /** Null while they load. */
  subjects: CrmSubject[] | null;
  category: DocsCategory | '';
  /** The document's category now. */
  current: DocsCategory | null;
  onMode: (mode: FilingMode) => void;
  onSubject: (key: string) => void;
  onCategory: (category: DocsCategory | '') => void;
  onChoose: (path: string) => void;
  onMove: () => void;
  onClose: () => void;
}) {
  const sorted = [...folders].sort((a, b) => a.path.localeCompare(b.path));
  const categories = useDocsCategories();
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        className="gap-3 p-4 sm:max-w-md"
        aria-describedby={undefined}
        // Ours to close; the page's Escape (back to the list) must not fire too.
        onEscapeKeyDown={(event) => event.stopPropagation()}
      >
        <DialogTitle>{t('Move to')}</DialogTitle>
        <NativeSelect value={mode} aria-label={t('File by')} onChange={(event) => onMode(event.target.value as FilingMode)}>
          <NativeSelectOption value="folder">{t('A folder')}</NativeSelectOption>
          <NativeSelectOption value="subject">{t('A project, lead or partner')}</NativeSelectOption>
          <NativeSelectOption value="category">{t('A category')}</NativeSelectOption>
        </NativeSelect>
        {mode === 'subject' && (
          <SearchablePicker
            label={t('Subject')}
            placeholder={subjects ? t('Choose a project, lead or partner') : t('Loading…')}
            options={(subjects ?? []).map((row) => ({ id: `${row.kind}:${row.id}`, title: row.title, context: row.kind === 'project' ? t('Project') : row.kind === 'organization' ? t('Partner') : t('Lead'), subtitle: row.subtitle ?? undefined }))}
            value={subject}
            onChange={onSubject}
            emptyMessage={t('No options match that search.')}
          />
        )}
        {mode === 'category' && (
          <NativeSelect value={category} aria-label={t('Category')} onChange={(event) => onCategory(event.target.value)}>
            <NativeSelectOption value="">{t('No category')}</NativeSelectOption>
            {categoryOptions(categories, current).map((option) => <NativeSelectOption key={option.id} value={option.id}>{option.label}</NativeSelectOption>)}
          </NativeSelect>
        )}
        {mode === 'folder' && <Command loop className="rounded-lg border bg-transparent" defaultValue={to}>
          <CommandInput placeholder={t('Search')} aria-label={t('Search folders')} autoFocus />
          <CommandList className="max-h-72">
            <CommandEmpty>{t('No folder matches.')}</CommandEmpty>
            {sorted.map((folder) => {
              const depth = Math.max(0, folder.path.split('/').filter(Boolean).length - 1);
              return (
                <CommandItem
                  key={folder.id}
                  value={folder.path}
                  onSelect={() => onChoose(folder.path)}
                  aria-checked={folder.path === to}
                  style={{ paddingLeft: 8 + depth * 14 }}
                >
                  <span className="min-w-0 flex-1 truncate">{folder.path.split('/').filter(Boolean).pop() ?? '/'}</span>
                  {folder.path === to && <CheckIcon className="text-foreground" aria-hidden="true" />}
                </CommandItem>
              );
            })}
          </CommandList>
        </Command>}
        {mode === 'folder' && <p className="m-0 truncate text-xs text-muted-foreground">{to}</p>}
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={onClose}>{t('Cancel')}</Button>
          <Button type="button" onClick={onMove} disabled={mode === 'subject' && !subject}>{mode === 'folder' ? t('Move') : t('File')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Rename…: the title alone, as the Mac's rename sheet asks it. */
function RenameDialog({ title, onTitle, onRename, onClose }: {
  title: string;
  onTitle: (title: string) => void;
  onRename: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        className="gap-3 p-4 sm:max-w-md"
        aria-describedby={undefined}
        onEscapeKeyDown={(event) => event.stopPropagation()}
      >
        <DialogTitle>{t('Rename')}</DialogTitle>
        <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); onRename(); }}>
          <Input
            type="text"
            value={title}
            aria-label={t('Title')}
            maxLength={200}
            autoFocus
            onChange={(event) => onTitle(event.target.value)}
          />
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>{t('Cancel')}</Button>
            <Button type="submit" disabled={!title.trim()}>{t('Rename')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * New document: a title and a category, on a Card under the list's heading.
 * The categories are the workspace's; with none, the picker is left out.
 */
export function NewDocumentForm({ title, onTitle, category, categories, onCategory, busy, onSubmit, onCancel }: {
  title: string;
  onTitle: (title: string) => void;
  category: DocsCategory | '';
  categories: readonly DocsCategoryRow[];
  onCategory: (category: DocsCategory | '') => void;
  busy: boolean;
  onSubmit: (event: FormEvent) => void;
  onCancel: () => void;
}) {
  return (
    <Card className="mt-3 mb-1 gap-0 bg-muted p-3 shadow-none">
      <form className="flex flex-col gap-2" onSubmit={onSubmit}>
        <Input
          type="text"
          value={title}
          placeholder={t('Title')}
          aria-label={t('Document title')}
          maxLength={200}
          autoFocus
          onChange={(event) => onTitle(event.target.value)}
        />
        {categories.length > 0 && (
          <NativeSelect aria-label={t('Category')} value={category} onChange={(event) => onCategory(event.target.value)}>
            <NativeSelectOption value="">{t('No category')}</NativeSelectOption>
            {categories.map((entry) => (
              <NativeSelectOption key={entry.id} value={entry.id}>{entry.label}</NativeSelectOption>
            ))}
          </NativeSelect>
        )}
        <div className="flex gap-2">
          <Button type="submit" disabled={busy || !title.trim()}>{t('Create')}</Button>
          <Button type="button" variant="secondary" onClick={onCancel}>{t('Cancel')}</Button>
        </div>
      </form>
    </Card>
  );
}
