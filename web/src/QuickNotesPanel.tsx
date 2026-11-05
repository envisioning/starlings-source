import { Tip } from './Tip';
import { composerFieldPadding, composerSendClass } from './composer-send';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import type { QuickNote } from '@starlings/contracts';
import { NoteIcon, PlusIcon } from './action-icons';
import { GlyphMark } from './SubjectMark';
import { DropdownMenuItem } from '@/ui/dropdown-menu';
import { useRowMenu } from './use-row-menu';
import { QuickNoteDialog } from './QuickNoteDialog';
import {
  deleteQuickNote,
  dropQuickNoteOutbox,
  fetchQuickNotes,
  flushQuickNoteOutbox,
  mergeQuickNotes,
  queueQuickNote,
  QUICK_NOTES_SNAPSHOT,
  readQuickNoteOutbox,
  settleQuickNoteOutbox,
} from './quick-notes';
import { loadSnapshot } from './snapshot-store';
import { MenuIcon } from './menu-icons';
import { t } from './i18n';
import { relativeTime } from './team-presence';
import { Spinner } from '@/ui/spinner';
import { PlaceholderRows } from '@/ui/placeholder-rows';
import { cn } from '@/lib/utils';
import { ErrorNotice } from './ErrorNotice';
import { HomeCardHead, HomeFoldToggle, HomeList, HomeMenuItem, HomeRow, HomeRowMark, homeCardClass, homeRowMenuOptions } from './HomeModule';
import { MenuGroups } from './row-menu-items';
import { quickNotesPageCount } from './quick-notes-page';

/**
 * Capture now, decide where it belongs later. The composer only captures;
 * a click on a note opens its dialog (`QuickNoteDialog`), which is where it
 * is rewritten, filed, copied or deleted — the same door as a Quick Note in
 * Work's INBOX. Home only: on Work, INBOX is the one list of unfiled notes,
 * as on the Mac and the phone (docs/WORK.md).
 *
 * Save first, send later: a new note goes into this browser's
 * outbox for `owner` and shows at once, marked unsent, while the request
 * runs behind it. A lost connection keeps it unsent and quiet; it goes again
 * when the browser is back online, the window comes back, or the list
 * refreshes.
 */
export function QuickNotesPanel({ owner }: { owner: string }) {
  // Last known first (docs/CACHING.md): the saved list draws while the
  // live read runs, and there is no loading row over it.
  const [saved] = useState(() => loadSnapshot<QuickNote[]>(QUICK_NOTES_SNAPSHOT));
  const [allNotes, setNotes] = useState(() => saved?.value ?? []);
  /** This browser's unsent notes, drawn over the Worker's list. */
  const [pending, setPending] = useState(() => readQuickNoteOutbox(owner));
  const [draft, setDraft] = useState('');
  const [isExpanded, setIsExpanded] = useState(false);
  /** How many pages of notes are unfolded; per visit, not stored. */
  const [pages, setPages] = useState(1);
  const listRef = useRef<HTMLUListElement>(null);
  /** Each note's row height, measured when its row was on screen. */
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [viewport, setViewport] = useState(() => window.innerHeight);
  const [gap, setGap] = useState(0);
  /** How many notes stay showing after an add; cleared when the page changes. */
  const [floor, setFloor] = useState(0);
  /** The note open in the dialog, and whether it opens on the triage form. */
  const [editing, setEditing] = useState<{ note: QuickNote; filing: boolean } | null>(null);
  /** The row's menu — the same list the Mac and phone draw: Edit, File…, Delete. */
  const menu = useRowMenu(homeRowMenuOptions);
  const [loading, setLoading] = useState(saved === null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  /** Send the outbox; what went through takes its pending row's place. */
  const sync = useCallback(async () => {
    const result = await flushQuickNoteOutbox(owner).catch(() => null);
    if (result && result.sent.length > 0) {
      const sent = new Set(result.sent.map((note) => note.id));
      // The outbox sends oldest first; the list is newest first.
      setNotes((current) => [...[...result.sent].reverse(), ...current.filter((note) => !sent.has(note.id))]);
    }
    setPending(readQuickNoteOutbox(owner));
  }, [owner]);

  const load = useCallback(async () => {
    try {
      const notes = await fetchQuickNotes();
      setNotes(notes);
      setPending(settleQuickNoteOutbox(owner, notes));
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t load Quick Notes.'));
    } finally {
      setLoading(false);
    }
    void sync();
  }, [owner, sync]);

  useEffect(() => {
    void load();
  }, [load]);

  // An unsent note goes again when the way to the Worker may be back.
  useEffect(() => {
    const retry = () => { void sync(); };
    const onVisible = () => { if (document.visibilityState === 'visible') retry(); };
    window.addEventListener('online', retry);
    window.addEventListener('focus', retry);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('online', retry);
      window.removeEventListener('focus', retry);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [sync]);

  /**
   * Measures the rows on screen. It runs after every render and before paint,
   * so a page that grows to measure its next note, or shrinks when that note
   * does not fit, never draws the in-between state.
   */
  const measure = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const rows = Array.from(list.children) as HTMLElement[];
    setGap(parseFloat(getComputedStyle(list).rowGap) || 0);
    setHeights((current) => {
      let next = current;
      for (const row of rows) {
        const id = row.querySelector('[data-note-id]')?.getAttribute('data-note-id');
        const height = row.getBoundingClientRect().height;
        if (!id || height <= 0 || current[id] === height) continue;
        if (next === current) next = { ...current };
        next[id] = height;
      }
      return next;
    });
  }, []);

  useLayoutEffect(measure);

  // A narrower card wraps its notes onto more lines, and a shorter window
  // holds a smaller page.
  const hasList = !loading && (pending.length > 0 || allNotes.some((note) => note.state === 'open'));
  useEffect(() => {
    const list = listRef.current;
    const resize = () => { setFloor(0); setViewport(window.innerHeight); };
    window.addEventListener('resize', resize);
    const observer = list ? new ResizeObserver(measure) : null;
    if (list) observer?.observe(list);
    return () => {
      window.removeEventListener('resize', resize);
      observer?.disconnect();
    };
  }, [measure, hasList]);

  function cancelComposer() {
    if (saving) return;
    setDraft('');
    setIsExpanded(false);
    setError('');
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = draft.trim();
    if (!body || saving) return;
    // Saved here before anything is sent: the draft can go.
    queueQuickNote(owner, body, 'home');
    setPending(readQuickNoteOutbox(owner));
    // Everything that was showing stays, and the new note joins it.
    setFloor((current) => Math.max(current, listed.length) + 1);
    setDraft('');
    setIsExpanded(false);
    setError('');
    void sync();
  }

  async function removeNote(note: QuickNote) {
    if (unsent.has(note.id)) {
      // It only ever lived in this browser: no request.
      dropQuickNoteOutbox(owner, note.id);
      setPending(readQuickNoteOutbox(owner));
      return;
    }
    if (saving) return;
    setSaving(true);
    try {
      await deleteQuickNote(note.id);
      setNotes((current) => current.filter((row) => row.id !== note.id));
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t delete that Quick Note.'));
    } finally {
      setSaving(false);
    }
  }

  // Home is the capture surface: what is still unfiled.
  const shown = mergeQuickNotes(allNotes, pending).filter((note) => note.state === 'open');
  const unsent = new Map(pending.map((entry) => [entry.id, entry]));
  // A note the Worker refused for good stays, red, until it is deleted.
  const refused = pending.find((entry) => entry.error)?.error ?? '';
  // Re-render on a slow tick so "just now" becomes "1 minute ago" while the
  // page sits open, as INBOX's message times do.
  const hasShown = shown.length > 0;
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!hasShown) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 30_000);
    return () => window.clearInterval(timer);
  }, [hasShown]);
  const listed = shown.slice(0, quickNotesPageCount(shown, heights, viewport, pages, gap, floor));
  const hidden = shown.length - listed.length;
  // Capture is primary, triage comes later: the section stays as quiet
  // furniture on Home. Only the composer folds; the plus stays in
  // the header as the way to write.
  return (
    <section
      className={cn(homeCardClass, 'grid border bg-card text-card-foreground')}
      aria-label={t('Quick Notes')}
    >
      <HomeCardHead title={t('Quick Notes')} count={shown.length > 0 ? shown.length : undefined} className="justify-start gap-2 [&>[data-slot=card-title]]:mr-auto">
        {!isExpanded && (
          <Tip label={t('Add Quick Note')}><Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 flex-none rounded-full border border-transparent text-muted-foreground hover-edge hover:text-foreground"
            aria-label={t('Add Quick Note')}
            onClick={() => setIsExpanded(true)}
          >
            <PlusIcon />
          </Button></Tip>
        )}
      </HomeCardHead>
      {isExpanded && (
        <form className="grid gap-2" onSubmit={save}>
          {/* One line, so Enter saves; a longer thought is still one note. */}
          <div className="relative">
          <Input
            type="text"
            className={cn('rounded-full pl-3.5', composerFieldPadding)}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={t('What’s on your mind?')}
            aria-label={t('Quick Note')}
            maxLength={5000}
            autoCapitalize="sentences"
            disabled={saving}
            autoFocus
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                cancelComposer();
              }
            }}
          />
          {/* A round + inside the pill, like a send button (meet#621). */}
          <Tip label={t('Add')}><Button
            type="submit"
            size="icon"
            className={composerSendClass}
            aria-label={saving ? t('Saving…') : t('Add')}
            disabled={saving || draft.trim().length === 0}
          >
            {saving ? <Spinner aria-hidden /> : <PlusIcon />}
          </Button></Tip>
          </div>
        </form>
      )}
      {(error || refused) && <ErrorNotice message={error || refused} />}
      {loading ? (
        isExpanded && <PlaceholderRows className="mt-3" />
      ) : shown.length > 0 ? (
        <HomeList className="mt-3" ref={listRef}>
          {listed.map((note) => {
            const outbox = unsent.get(note.id);
            return (
            <HomeMenuItem
              key={note.id}
              menu={menu}
              id={note.id}
              items={(
                <MenuGroups groups={[
                  // An unsent note has nothing on the Worker to edit or file yet.
                  ...(outbox ? [] : [[
                    <DropdownMenuItem key="edit" onClick={() => { menu.close(); setEditing({ note, filing: false }); }}><MenuIcon name="edit" />{t('Edit')}</DropdownMenuItem>,
                    <DropdownMenuItem key="file" onClick={() => { menu.close(); setEditing({ note, filing: true }); }}><MenuIcon name="file" />{t('File…')}</DropdownMenuItem>,
                  ]]),
                  [<DropdownMenuItem key="delete" variant="destructive" disabled={saving} onClick={() => { menu.close(); void removeNote(note); }}><MenuIcon name="delete" />{t('Delete')}</DropdownMenuItem>],
                ]} />
              )}
            >
              {/* The row is what you aim at, so the row lifts; the body is the
                  control, and a click opens the note's dialog. */}
              <HomeRow interactive className="cursor-pointer">
                <HomeRowMark aria-hidden="true"><GlyphMark size={24} shape="square"><NoteIcon /></GlyphMark></HomeRowMark>
                {/* hover: the HomeRow around it lifts */}
                {/* shadcn: the whole note row is the target */}
                <button
                  type="button"
                  className="group/note flex min-w-0 flex-1 cursor-pointer flex-col items-start gap-[3px] rounded-md border-0 bg-transparent p-0 text-left disabled:cursor-default disabled:opacity-55"
                  data-home-row
                  data-note-id={note.id}
                  aria-label={t('Quick Note: {body}', { body: note.body })}
                  onClick={() => { if (!outbox) setEditing({ note, filing: false }); }}
                  disabled={saving}
                >
                  {/* A note wraps: its body is the whole point, not a title to truncate. */}
                  <strong className="max-w-full text-[15px] font-[460] whitespace-pre-wrap text-foreground [overflow-wrap:anywhere] group-hover/note:underline group-hover/note:decoration-muted-foreground group-hover/note:underline-offset-3">{note.body}</strong>
                  <small className="max-w-full truncate text-xs text-muted-foreground">
                    {noteWhen(note.created_at)}
                    {outbox && !outbox.error && ` · ${t('Not sent yet')}`}
                  </small>
                </button>
              </HomeRow>
            </HomeMenuItem>
            );
          })}
        </HomeList>
      ) : null}
      {(hidden > 0 || pages > 1) && (
        <HomeFoldToggle
          className="mt-2.5 justify-self-start"
          aria-expanded={pages > 1}
          onClick={() => { setFloor(0); setPages((current) => (hidden > 0 ? current + 1 : 1)); }}
        >
          {hidden > 0 ? t('See {hidden} more', { hidden }) : t('Show fewer')}
        </HomeFoldToggle>
      )}
      {editing && (
        <QuickNoteDialog
          key={editing.note.id}
          note={editing.note}
          startFiling={editing.filing}
          onChange={(note) => setNotes((current) => current.map((row) => row.id === note.id ? note : row))}
          onDelete={(note) => setNotes((current) => current.filter((row) => row.id !== note.id))}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

/** When a note was written, relative, as the Mac and the phone draw it. */
function noteWhen(value: string): string {
  const at = Date.parse(value);
  return Number.isNaN(at) ? '' : relativeTime(at);
}
