import { QUICK_NOTE_TRIAGE, type QuickNoteTriageKind } from '@starlings/contracts/quick-note-values';
import { Tip } from './Tip';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Textarea } from '@/ui/textarea';
import { Button } from '@/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/ui/dialog';
import type { QuickNote, QuickNoteSource } from '@starlings/contracts';
import { CloseIcon, TrashIcon } from './action-icons';
import {
  createTask,
  type CrmSubject,
  type TaskDraft,
} from './crm-work';
import { ErrorNotice } from './ErrorNotice';
import type { ThreadSummary } from './messages';
import {
  createQuickNote,
  createQuickNoteDocument,
  createQuickNoteIssue,
  deleteQuickNote,
  promoteQuickNote,
  sendQuickNoteMessage,
  updateQuickNote,
} from './quick-notes';
import { t } from './i18n';
import { Spinner } from '@/ui/spinner';
import { PlaceholderRows } from '@/ui/placeholder-rows';
import { cn } from '@/lib/utils';
import { editorDialogClass, editorFieldsetClass, editorHeaderClass, editorTitleClass } from './editor-dialog';
import { SearchablePicker } from './SearchablePicker';
import { SegmentedControl } from './SegmentedControl';
import {
  fetchQuickNoteDestinations,
  peekQuickNoteDestinations,
  searchQuickNoteSubjects,
  subjectDestinationOptions,
  threadDestinationOptions,
} from './quick-note-destinations';

/**
 * Where a note can go from here, in the contract's order. Doc goes through the Worker (`/api/docs/documents`), which holds the
 * Docs token; the browser never does.
 */
type TriageKind = QuickNoteTriageKind;
const TRIAGE_KINDS: readonly TriageKind[] = QUICK_NOTE_TRIAGE.map((row) => row.kind);

/** The words are the contract's (`quick-note-values.ts`), drawn in the page's language. */
const TRIAGE_LABEL = Object.fromEntries(QUICK_NOTE_TRIAGE.map((row) => [row.kind, t(row.label)])) as Record<TriageKind, string>;
const TRIAGE_ACTION = Object.fromEntries(QUICK_NOTE_TRIAGE.map((row) => [row.kind, t(row.action)])) as Record<TriageKind, string>;

/**
 * The dialog for one Quick Note, the web's peer of the phone's drawer and
 * the Mac's popover: the body to rewrite, then File…, Copy, Delete. File…
 * unfolds the triage form inside the same dialog, so filing is one door on
 * Home and on Work alike. With no note it captures one (Work's `+`, the
 * Mac's New Quick Note…): the body and Save, nothing to file yet.
 */
export function QuickNoteDialog({ note, source = 'work', startFiling = false, onChange, onDelete, onClose }: {
  /** `null` captures a new note. */
  note: QuickNote | null;
  /** Where a new note says it came from. */
  source?: Extract<QuickNoteSource, 'home' | 'work'>;
  /** Open on the triage form — the row's File… chose that already. */
  startFiling?: boolean;
  /** The note after a capture, a save or a filing. */
  onChange: (note: QuickNote) => void;
  onDelete: (note: QuickNote) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(note?.body ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  /**
   * The id a new note is sent with. A retry of the same text
   * sends the same id, so a save whose answer was lost does not make two.
   */
  const capture = useRef<{ body: string; id: string; captured_at: number } | null>(null);
  const [filing, setFiling] = useState(false);
  const [triageSubjects, setTriageSubjects] = useState<CrmSubject[]>([]);
  /** `kind:id` of the subjects this person starred; they list first. */
  const [triageStarred, setTriageStarred] = useState<Set<string>>(() => new Set());
  const [triageThreads, setTriageThreads] = useState<ThreadSummary[]>([]);
  const [triageProjectsHaveMore, setTriageProjectsHaveMore] = useState(false);
  const [triageLeadsHaveMore, setTriageLeadsHaveMore] = useState(false);
  const [triagePartnersHaveMore, setTriagePartnersHaveMore] = useState(false);
  const [triageSubjectKey, setTriageSubjectKey] = useState('');
  const [triageTitle, setTriageTitle] = useState(note?.body ?? '');
  const [triageKind, setTriageKind] = useState<TriageKind>('task');
  const [triageLoading, setTriageLoading] = useState(false);

  useEffect(() => {
    if (startFiling) void beginFiling();
    // Mount only: `startFiling` is how the dialog was opened, not state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const body = draft.trim();
  const canSave = body.length > 0 && body !== note?.body && !busy;

  async function save() {
    if (!canSave) return;
    setBusy(true);
    try {
      if (note) {
        onChange(await updateQuickNote(note.id, body));
      } else {
        if (capture.current?.body !== body) capture.current = { body, id: crypto.randomUUID(), captured_at: Date.now() };
        onChange(await createQuickNote(body, source, null, capture.current));
      }
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t save that Quick Note.'));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!note) return;
    try {
      await navigator.clipboard.writeText(note.body);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError(t('Couldn’t copy that Quick Note.'));
    }
  }

  async function remove() {
    if (busy || !note) return;
    setBusy(true);
    try {
      await deleteQuickNote(note.id);
      onDelete(note);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t delete that Quick Note.'));
      setBusy(false);
    }
  }

  async function beginFiling() {
    setFiling(true);
    const cached = peekQuickNoteDestinations();
    if (cached) {
      setTriageSubjects(cached.subjects);
      setTriageStarred(cached.starred);
      setTriageThreads(cached.threads);
      setTriageProjectsHaveMore(cached.projectsHaveMore);
      setTriageLeadsHaveMore(cached.leadsHaveMore);
      setTriagePartnersHaveMore(cached.partnersHaveMore);
      setError('');
      setTriageLoading(false);
      return;
    }
    setTriageLoading(true);
    try {
      const destinations = await fetchQuickNoteDestinations();
      setTriageSubjects(destinations.subjects);
      setTriageStarred(destinations.starred);
      setTriageThreads(destinations.threads);
      setTriageProjectsHaveMore(destinations.projectsHaveMore);
      setTriageLeadsHaveMore(destinations.leadsHaveMore);
      setTriagePartnersHaveMore(destinations.partnersHaveMore);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t load places to file this note.'));
    } finally {
      setTriageLoading(false);
    }
  }

  const searchSubjects = useCallback(async (query: string) => {
    const projectsOnly = triageKind === 'issue';
    const found = await searchQuickNoteSubjects(query, projectsOnly);
    setTriageSubjects((current) => {
      const byID = new Map(current.map((subject) => [`${subject.kind}:${subject.id}`, subject]));
      for (const subject of found) byID.set(`${subject.kind}:${subject.id}`, subject);
      return [...byID.values()];
    });
    return subjectDestinationOptions(found, triageStarred, projectsOnly);
  }, [triageKind, triageStarred]);

  const needsSubject = triageKind === 'task' || triageKind === 'issue';
  const needsTitle = triageKind !== 'message';
  const canSearchSubjects = triageKind === 'issue'
    ? triageProjectsHaveMore
    : triageProjectsHaveMore || triageLeadsHaveMore || triagePartnersHaveMore;
  const offeredSubjects = subjectDestinationOptions(triageSubjects, triageStarred, triageKind === 'issue');
  const canFile = !busy && !triageLoading
    && (triageKind === 'doc' || triageSubjectKey.length > 0)
    && (!needsTitle || triageTitle.trim().length > 0);

  async function file() {
    const subject = triageSubjects.find((candidate) => `${candidate.kind}:${candidate.id}` === triageSubjectKey);
    const thread = triageThreads.find((candidate) => candidate.id === triageSubjectKey);
    const title = triageTitle.trim();
    if (!note || !canFile || (needsSubject && !subject) || (triageKind === 'message' && !thread)) return;
    setBusy(true);
    try {
      let promoted: QuickNote;
      if (triageKind === 'task') {
        const taskDraft: TaskDraft = {
          title,
          // The note is the task's notes unless it *is* the title — the same
          // rule as Mac `QuickNoteFiling` and iOS, so a long note filed under
          // a short heading keeps its detail (#221).
          notes: note.body.trim() === title ? '' : note.body,
          status: 'pending',
          // No assignee: a filed note is the filer's task.
          responsible_party: 'team',
          due_date: '',
          goal_id: null,
        };
        const task = await createTask(subject!, taskDraft);
        promoted = await promoteQuickNote(note.id, 'task', task.id);
      } else if (triageKind === 'issue') {
        const issue = await createQuickNoteIssue(subject!.id, title, note.body);
        promoted = await promoteQuickNote(note.id, 'issue', issue.id);
      } else if (triageKind === 'message') {
        const message = await sendQuickNoteMessage(thread!.id, note.body);
        promoted = await promoteQuickNote(note.id, 'message', message.id);
      } else {
        const document = await createQuickNoteDocument(title, note.body);
        promoted = await promoteQuickNote(note.id, 'doc', document.id);
      }
      onChange(promoted);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t file that Quick Note.'));
      setBusy(false);
    }
  }

  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogContent
      showCloseButton={false}
      aria-describedby={undefined}
      className={cn(editorDialogClass, 'gap-3 bg-card p-5 sm:max-w-[520px]')}
      // An editor keeps its draft: only Esc or Close leaves, never a stray click outside.
      onInteractOutside={(event) => event.preventDefault()}
    >
    <form className="m-0" onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className={editorHeaderClass}>
        <DialogTitle asChild><h2 className={editorTitleClass}>{note ? t('Quick Note') : t('New Quick Note')}</h2></DialogTitle>
        <Button type="button" variant="ghost" size="icon" className="rounded-full text-muted-foreground" aria-label={t('Close')} disabled={busy} onClick={onClose}><CloseIcon /></Button>
      </div>
      {error && <ErrorNotice message={error} />}
      <fieldset className={editorFieldsetClass} disabled={busy}>
        <Textarea
          rows={3}
          maxLength={5000}
          value={draft}
          aria-label={t('Quick Note')}
          autoCapitalize="sentences"
          autoFocus
          className="resize-y"
          onChange={event => setDraft(event.target.value)}
        />
      </fieldset>
      {filing && (
        <div className="mt-3.5 grid gap-2 pt-[5px]">
          {triageLoading ? (
            <PlaceholderRows count={2} label={t('Loading places to file this…')} />
          ) : (
            <>
              {/* The destination control takes the dialog's full width. */}
              <SegmentedControl
                label={t('Destination')}
                value={triageKind}
                options={TRIAGE_KINDS.map((kind) => ({ value: kind, label: TRIAGE_LABEL[kind] }))}
                onChange={(kind) => {
                  setTriageKind(kind);
                  setTriageSubjectKey('');
                }}
                disabled={busy}
              />
              {needsSubject && (
                <SearchablePicker
                  label={triageKind === 'issue' ? t('File under (project)') : t('File under')}
                  placeholder={triageKind === 'issue' ? t('Choose a project') : t('Choose a project, lead or partner')}
                  options={offeredSubjects}
                  value={triageSubjectKey}
                  onChange={setTriageSubjectKey}
                  emptyMessage={t('No destinations match that search.')}
                  disabled={busy}
                  onSearch={canSearchSubjects ? searchSubjects : undefined}
                />
              )}
              {triageKind === 'message' && (
                <SearchablePicker
                  label={t('Send to')}
                  placeholder={t('Choose a conversation')}
                  options={threadDestinationOptions(triageThreads)}
                  value={triageSubjectKey}
                  onChange={setTriageSubjectKey}
                  emptyMessage={t('No conversations match that search.')}
                  disabled={busy}
                />
              )}
              {needsTitle && (
                <Label className="flex flex-col gap-1 text-xs text-muted-foreground font-normal leading-normal items-stretch">
                  {triageKind === 'issue' ? t('Issue title') : triageKind === 'doc' ? t('Document title') : t('Task title')}
                  <Input
                    value={triageTitle}
                    maxLength={200}
                    onChange={(event) => setTriageTitle(event.target.value)}
                    disabled={busy}
                  />
                </Label>
              )}
            </>
          )}
        </div>
      )}
      <div className="mt-[18px] flex flex-none flex-wrap items-center justify-end gap-2">
        {filing ? (
          <Button type="button" disabled={!canFile} onClick={() => { void file(); }}>
            {busy && <Spinner aria-hidden />}
            {busy ? t('Filing…') : TRIAGE_ACTION[triageKind]}
          </Button>
        ) : (
          <>
            <Button disabled={!canSave}>{busy ? 'Saving…' : 'Save'}</Button>
            {note && <Button type="button" variant="secondary" disabled={busy} onClick={() => { void beginFiling(); }}>{t('File…')}</Button>}
            {note && <Button type="button" variant="secondary" disabled={busy} onClick={() => { void copy(); }}>{copied ? 'Copied' : 'Copy'}</Button>}
          </>
        )}
        {note && <Tip label={t('Delete Quick Note')}><Button type="button" variant="ghost" size="icon" className="ml-auto rounded-full text-muted-foreground hover:text-destructive" aria-label={t('Delete Quick Note')} disabled={busy} onClick={() => { void remove(); }}><TrashIcon /></Button></Tip>}
      </div>
    </form>
    </DialogContent>
  </Dialog>;
}
