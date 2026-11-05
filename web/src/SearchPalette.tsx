import { MEMBER_SURFACES, type MemberSurfaceId } from '@starlings/contracts/member-surfaces';
import { Fragment, useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { Button } from '@/ui/button';
import { ErrorNotice } from './ErrorNotice';
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from '@/ui/command';
import { Dialog, DialogContent, DialogTitle } from '@/ui/dialog';
import type { DocsSearchHit } from '@starlings/contracts';
import {
  SEARCH_DESTINATIONS,
  SEARCH_SCOPES,
  SEARCH_SETTINGS_PAGES,
  SEARCH_VERBS,
  isSearchRow,
  parseSearchDoor,
  search,
  searchDoorString,
  searchPersonVerbs,
  searchRowVerbs,
  searchRowKey,
  type SearchKind,
  type SearchPersonVerb,
  type SearchRowVerb,
  type SearchRow,
  type SearchSettingsPage,
  type SearchVerb,
  SEARCH_KIND_LABELS,
  SEARCH_PERSON_VERB_TITLES,
  SEARCH_SETTINGS_TITLES,
  SEARCH_SUBJECT_VERB_TITLES,
  SEARCH_VERB_TITLES,
} from '@starlings/contracts/search-values';
import type { SearchResponse } from '@starlings/contracts/search';
import { apiFetch } from './api';
import { apiBase } from './config';
import { searchDocs, snippetText } from './docs';
import { localTimeZone } from './meeting-time';
import { hrefForDoor, isExternalDoor, loadRecents, reconcileAgentRecents, SEARCH_RECENTS_EVENT, storeRecent, type SearchPaletteRequest } from './search-doors';
import type { CoreEntity, CoreSearchHit } from '@starlings/contracts/core-fields';
import { coreHitSubjectKind, coreRecordURL, fetchCoreRegistry, searchCore } from './core-fields';
import { documentHref, subjectHref } from './work-hrefs';
import { ChevronRightIcon } from './action-icons';
import { t } from './i18n';
import { navigate } from './navigation';
import { subscribePeers } from './team-presence';
import { useVisibleSurfaces } from './calendar-sources';

/**
 * ⌘K — one palette to find anything and jump anywhere (AGENTS.md
 * invariant 27). Hits come from `GET /api/search` in the contract's order;
 * doors (the five destinations, Settings pages, verbs) and recents are this
 * device's, and the same `search` runs once more over all of them so a
 * recent row and a door rank by the one rule. Document titles are in the
 * first answer; full text (`/api/docs/search`) arrives after a pause, below.
 * Core: one row per registry entity ranks with the rest, as on
 * Mac and iOS, and opens Core's own list of it; Core's record search
 * (`/api/core/search`, the web's Search Core) arrives after the same pause,
 * below Docs. A project or lead found there opens on its Fields in Work;
 * anything else opens on Core's page for it, beside the app.
 *
 * shadcn's Command (cmdk) in a Radix dialog. The ranking is the
 * contract's, so cmdk's own filter is off. ↑↓ moves, Enter opens, → or
 * ⌘-Enter on a person or subject shows its verbs, ← or Esc goes back, Esc
 * closes. SearchPaletteHost loads this module the first time ⌘K is pressed.
 */

/** Titles answer on the first keystroke; this is the wait before full text. */
const DOCS_DEBOUNCE_MS = 400;
/** The Worker fan-out is eight upstream reads; a keystroke should not fire it. */
const HITS_DEBOUNCE_MS = 150;

// MARK: - Doors on the web

const DESTINATION_TITLES = Object.fromEntries(MEMBER_SURFACES.map((surface) => [surface.id, t(surface.title)])) as Record<MemberSurfaceId, string>;
/** Every shared Settings door: the pages every client lists, drawn as cards of `/settings`. */
const WEB_SETTINGS_PAGES: readonly SearchSettingsPage[] = SEARCH_SETTINGS_PAGES;
const words = <K extends string>(table: Record<K, string>) =>
  Object.fromEntries(Object.entries<string>(table).map(([key, word]) => [key, t(word)])) as Record<K, string>;
/** The palette's words are the contract's (`search-values.ts`), drawn in the page's language. */
const SETTINGS_TITLES = words(SEARCH_SETTINGS_TITLES);
const VERB_TITLES = words(SEARCH_VERB_TITLES);
/**
 * The verbs the web can do from a bare row. New task and New issue take a
 * subject on this client (invariant 24; the issue form lives on a linked
 * project) and wait for "verbs that take an argument" (Later).
 */
const WEB_VERBS: readonly SearchVerb[] = SEARCH_VERBS.filter((verb) => verb !== 'new-task' && verb !== 'new-issue');
const PERSON_VERB_TITLES = words(SEARCH_PERSON_VERB_TITLES);
/** A subject's verbs: the same names as the bare ones, with the subject as their argument. */
const ROW_VERB_TITLES: Record<SearchRowVerb, string> = { ...PERSON_VERB_TITLES, ...words(SEARCH_SUBJECT_VERB_TITLES) };
/** The browser cannot start a room filed under a subject; the other three open the subject's own editor. */
function webRowVerbs(row: SearchRow): readonly SearchRowVerb[] {
  return searchRowVerbs(row).filter((verb) => verb !== 'start-room');
}
const KIND_LABELS = words(SEARCH_KIND_LABELS);

function doorRows(roomSlug: string | null, surfaces: ReadonlySet<MemberSurfaceId>): SearchRow[] {
  return [
    // A destination the nav does not list has no door either.
    ...SEARCH_DESTINATIONS.filter((destination) => surfaces.has(destination)).map((destination): SearchRow => ({
      kind: 'destination', id: destination, title: DESTINATION_TITLES[destination], subtitle: '',
      door: searchDoorString({ to: 'destination', destination }),
    })),
    ...WEB_SETTINGS_PAGES.map((page): SearchRow => ({
      kind: 'settings', id: page, title: SETTINGS_TITLES[page], subtitle: t('Settings'),
      door: searchDoorString({ to: 'settings', page }),
    })),
    ...WEB_VERBS
      .filter((verb) => verb !== 'start-room' || roomSlug)
      .map((verb): SearchRow => ({
        kind: 'verb', id: verb, title: VERB_TITLES[verb], subtitle: '',
        door: searchDoorString({ to: 'verb', verb }),
      })),
  ];
}

// MARK: - The palette

async function fetchHits(query: string, signal: AbortSignal): Promise<{ rows: SearchRow[]; partial: string[] }> {
  const params = new URLSearchParams({ q: query, tz: localTimeZone() });
  const response = await apiFetch<SearchResponse>(`/search?${params}`, {
    fallbackError: t('Couldn’t search.'),
    noStore: true,
    signal,
  });
  if (signal.aborted) return { rows: [], partial: [] };
  return {
    rows: response.rows.filter(isSearchRow),
    partial: response.partial ?? [],
  };
}

async function fetchRoomSlug(): Promise<string | null> {
  try {
    const response = await fetch(`${apiBase}/owner/room`, { cache: 'no-store' });
    if (!response.ok) return null;
    const body = await response.json() as { room?: { slug?: string } };
    return body.room?.slug ?? null;
  } catch {
    return null;
  }
}

type Entry =
  | { id: string; row: SearchRow; recent: boolean }
  | { id: string; hit: DocsSearchHit }
  | { id: string; core: CoreSearchHit; label: string };

/** Core's registry as rows: one per entity Core lets this person read, as the Mac and the phone list them. */
function coreRows(entities: CoreEntity[]): SearchRow[] {
  return entities
    .filter((entity) => entity.access.canRead)
    .map((entity): SearchRow => ({
      kind: 'core', id: entity.id, title: entity.pluralLabel, subtitle: t('Records'),
      door: searchDoorString({ to: 'core', id: entity.id }),
    }));
}

function openBeside(href: string | null): void {
  if (!href) return;
  window.open(href, '_blank', 'noopener,noreferrer');
}

export function SearchPalette({ open, onOpenChange, request = {} }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The opener's words and scope; ⌘K and the header icon ask for neither. */
  request?: SearchPaletteRequest;
}) {
  const [query, setQuery] = useState('');
  /** Docs only, when Work's rail tail opened the palette; otherwise everything. */
  const [scope, setScope] = useState<SearchPaletteRequest['scope'] | null>(null);
  const [hits, setHits] = useState<SearchRow[]>([]);
  /** Sources the Worker could not read for the current hits. */
  const [partial, setPartial] = useState<string[]>([]);
  /**
   * The whole request failed — offline, a 5xx — as opposed to nothing
   * matching. Recents and doors still rank; the line under them
   * says the Worker was not heard, with Retry.
   */
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [docHits, setDocHits] = useState<DocsSearchHit[]>([]);
  /** Core's registry entities, read once per page load; none when Core is not reachable. */
  const [coreEntities, setCoreEntities] = useState<CoreEntity[]>([]);
  const [coreHits, setCoreHits] = useState<CoreSearchHit[]>([]);
  const [recents, setRecents] = useState<SearchRow[]>(() => loadRecents());
  const [roomSlug, setRoomSlug] = useState<string | null>(null);
  const surfaces = useVisibleSurfaces();
  /** The highlighted row: cmdk's value, which is the entry's id. */
  const [selected, setSelected] = useState('');
  /** The person or subject whose verbs are showing, once → or ⌘-Enter asked for them. */
  const [verbsFor, setVerbsFor] = useState<SearchRow | null>(null);

  // Closed is empty: the next ⌘K starts from recents and doors.
  useEffect(() => {
    if (open) {
      setRecents(loadRecents());
      const refreshRecents = () => setRecents(loadRecents());
      window.addEventListener(SEARCH_RECENTS_EVENT, refreshRecents);
      const stopPeers = subscribePeers({ onValue: ({ peers }) => {
        const agentEmails = new Set(peers.filter((peer) => peer.kind === 'agent').map((peer) => peer.email.toLowerCase()));
        setRecents(reconcileAgentRecents(agentEmails));
      } });
      if (roomSlug === null) void fetchRoomSlug().then((slug) => { if (slug) setRoomSlug(slug); });
      if (coreEntities.length === 0) void fetchCoreRegistry().then(setCoreEntities, () => undefined);
      return () => {
        window.removeEventListener(SEARCH_RECENTS_EVENT, refreshRecents);
        stopPeers();
      };
    }
    setQuery('');
    setScope(null);
    setHits([]);
    setDocHits([]);
    setCoreHits([]);
    setVerbsFor(null);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // An opener's words land in the field; a new request object is a new open.
  useEffect(() => {
    if (!open) return;
    setQuery(request.query ?? '');
    setScope(request.scope ?? null);
    setVerbsFor(null);
  }, [open, request]);

  // Hits: one debounced call. Titles, people, subjects, events, tasks, issues.
  // The abort on cleanup is what keeps a slow answer to the previous query
  // from landing on this one: a settled promise checks its own signal
  // before it writes, and an aborted one writes nothing.
  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (!trimmed) { setHits([]); setPartial([]); setFailed(false); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      fetchHits(trimmed, controller.signal)
        .then((found) => {
          if (controller.signal.aborted) return;
          setHits(found.rows);
          setPartial(found.partial);
          setFailed(false);
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          setHits([]);
          setPartial([]);
          setFailed(true);
        });
    }, HITS_DEBOUNCE_MS);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [open, query, attempt]);

  // Full text, after a pause, appended below.
  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (trimmed.length < 2) { setDocHits([]); return; }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      searchDocs(trimmed)
        .then((found) => { if (!cancelled) setDocHits(found); })
        .catch(() => { if (!cancelled) setDocHits([]); });
    }, DOCS_DEBOUNCE_MS);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [open, query]);

  // Core's records, after the same pause, when the palette is not scoped.
  // A failure is an absent tail, as with Docs: the rows above still stand.
  useEffect(() => {
    if (!open || scope) { setCoreHits([]); return; }
    const trimmed = query.trim();
    if (trimmed.length < 2) { setCoreHits([]); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      searchCore(trimmed, controller.signal)
        .then((found) => { if (!controller.signal.aborted) setCoreHits(found); })
        .catch(() => { if (!controller.signal.aborted) setCoreHits([]); });
    }, DOCS_DEBOUNCE_MS);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [open, query, scope]);

  const entries = useMemo((): Entry[] => {
    if (verbsFor) return [];
    const recentKeys = recents.map(searchRowKey);
    const hitKeys = new Set(hits.map(searchRowKey));
    const rows: SearchRow[] = [
      ...hits,
      ...recents.filter((row) => !hitKeys.has(searchRowKey(row))),
      ...coreRows(coreEntities),
      ...doorRows(roomSlug, surfaces),
    ];
    const ranked = search(rows, query, { scope: scope ? SEARCH_SCOPES[scope] : SEARCH_SCOPES.palette, order: 'rank', recents: recentKeys });
    const seen = new Set(ranked.map(searchRowKey));
    return [
      ...ranked.map((row): Entry => ({ id: searchRowKey(row), row, recent: recentKeys.includes(searchRowKey(row)) })),
      ...docHits
        .filter((hit) => !seen.has(`document:${hit.id}`))
        .map((hit): Entry => ({ id: `docs:${hit.id}`, hit })),
      ...coreHits
        .filter((hit) => {
          const kind = coreHitSubjectKind(hit);
          return !kind || !seen.has(searchRowKey({ kind: 'subject', id: hit.id }));
        })
        .map((hit): Entry => ({
          id: `core-record:${hit.entity}:${hit.id}`,
          core: hit,
          label: coreEntities.find((entity) => entity.id === hit.entity)?.singularLabel ?? KIND_LABELS.core,
        })),
    ];
  }, [hits, recents, docHits, coreHits, coreEntities, query, roomSlug, surfaces, verbsFor, scope]);

  const verbEntries = useMemo(() => (verbsFor ? webRowVerbs(verbsFor) : []), [verbsFor]);

  // A new list starts on its first row, as the contract ranked it.
  useEffect(() => {
    setSelected(verbsFor ? `verb:${verbEntries[0] ?? ''}` : entries[0]?.id ?? '');
  }, [entries, verbsFor, verbEntries]);

  function go(href: string | null) {
    if (!href) return;
    onOpenChange(false);
    navigate(href);
  }

  function openRow(row: SearchRow, verb?: SearchRowVerb) {
    const door = parseSearchDoor(row.door);
    if (!door) return;
    const href = hrefForDoor(door, { roomSlug, verb });
    if (!href) return;
    setRecents(storeRecent(row));
    if (isExternalDoor(door)) {
      onOpenChange(false);
      openBeside(href);
      return;
    }
    go(href);
  }

  function openEntry(entry: Entry) {
    if ('hit' in entry) {
      go(documentHref(entry.hit.id));
      return;
    }
    if ('core' in entry) {
      const kind = coreHitSubjectKind(entry.core);
      if (kind) {
        go(subjectHref({ kind, id: entry.core.id }, { pane: 'fields' }));
        return;
      }
      onOpenChange(false);
      openBeside(coreRecordURL(entry.core));
      return;
    }
    openRow(entry.row);
  }

  function showVerbs(entry: Entry | undefined) {
    if (!entry || 'hit' in entry || 'core' in entry) return;
    if (webRowVerbs(entry.row).length === 0) return;
    setVerbsFor(entry.row);
  }

  /** The keys cmdk does not own. Enter, ↑ and ↓ are cmdk's. */
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const current = entries.find((entry) => entry.id === selected);
    switch (event.key) {
      case 'ArrowRight':
        if (verbsFor || event.currentTarget.selectionStart !== event.currentTarget.value.length) return;
        event.preventDefault();
        showVerbs(current);
        break;
      case 'ArrowLeft':
        if (!verbsFor) return;
        event.preventDefault();
        setVerbsFor(null);
        break;
      case 'Enter':
        if (verbsFor || !(event.metaKey || event.ctrlKey)) return;
        event.preventDefault();
        showVerbs(current);
        break;
      default:
        break;
    }
  }

  const empty = query.trim().length === 0;
  const sections = sectionsOf(entries, empty);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="top-[12vh] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl"
        // Esc on a verb list goes back to the rows; on the rows it closes.
        onEscapeKeyDown={(event) => { if (verbsFor) { event.preventDefault(); setVerbsFor(null); } }}
      >
        <DialogTitle className="sr-only">{t('Search')}</DialogTitle>
        <Command shouldFilter={false} loop value={selected} onValueChange={setSelected}>
          <CommandInput
            className="h-12"
            placeholder={verbsFor ? verbsFor.title : scope === 'docs' ? t('Search Docs') : t('Search')}
            value={query}
            onValueChange={(next) => { setQuery(next); setVerbsFor(null); }}
            onKeyDown={onKeyDown}
            autoComplete="off"
            spellCheck={false}
          />
          <CommandList className="max-h-[60vh]">
            {verbsFor ? (
              <CommandGroup heading={verbsFor.title}>
                {verbEntries.map((verb) => (
                  <CommandItem key={verb} value={`verb:${verb}`} onSelect={() => openRow(verbsFor, verb)}>
                    {ROW_VERB_TITLES[verb]}
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : entries.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {empty ? t('Type to search.') : failed ? t('Couldn’t search.') : t('Nothing matches.')}
              </p>
            ) : (
              sections.map((section) => (
                <Fragment key={section.entries[0]!.id}>
                  <CommandGroup heading={section.heading ?? undefined}>
                    {section.entries.map((entry) => (
                      <CommandItem key={entry.id} value={entry.id} onSelect={() => openEntry(entry)}>
                        <EntryRow entry={entry} onVerbs={() => showVerbs(entry)} />
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </Fragment>
              ))
            )}
            {failed && !empty && entries.length > 0 && (
              <ErrorNotice
                inline
                className="px-3 py-2 text-xs"
                message={t('Couldn’t search.')}
                action={<Button type="button" variant="outline" size="xs" onClick={() => setAttempt((current) => current + 1)}>{t('Retry')}</Button>}
              />
            )}
            {partial.length > 0 && !empty && !failed && (
              <p className="px-3 py-2 text-xs text-muted-foreground">{t('Some results are missing.')}</p>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

/** One row: title, then its subtitle, then its kind; a person or subject adds the → to its verbs. */
function EntryRow({ entry, onVerbs }: { entry: Entry; onVerbs: () => void }) {
  if ('core' in entry) {
    return (
      <>
        <span className="min-w-0 shrink-0 truncate font-medium">{entry.core.name}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{entry.core.description ?? ''}</span>
        <span className="shrink-0 text-xs text-muted-foreground max-sm:hidden">{entry.label}</span>
      </>
    );
  }
  if ('hit' in entry) {
    return (
      <>
        <span className="min-w-0 shrink-0 truncate font-medium">{entry.hit.title}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{snippetText(entry.hit.snippet)}</span>
        <span className="shrink-0 text-xs text-muted-foreground max-sm:hidden">{KIND_LABELS.document}</span>
      </>
    );
  }
  const verbs = webRowVerbs(entry.row);
  return (
    <>
      <span className="min-w-0 shrink-0 truncate font-medium">{entry.row.title}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{entry.row.subtitle ? t(entry.row.subtitle) : ''}</span>
      <span className="shrink-0 text-xs text-muted-foreground max-sm:hidden">{KIND_LABELS[entry.row.kind]}</span>
      {verbs.length > 0 && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="-my-1 text-muted-foreground"
          aria-label={t('{title}: {verbs}', { title: entry.row.title, verbs: verbs.map((verb) => ROW_VERB_TITLES[verb]).join(', ') })}
          onPointerDown={(event) => event.preventDefault()}
          onClick={(event) => { event.stopPropagation(); onVerbs(); }}
        >
          <ChevronRightIcon />
        </Button>
      )}
    </>
  );
}

/** Runs of entries under one heading (`headingBefore`), each a cmdk group. */
function sectionsOf(entries: Entry[], empty: boolean): { heading: string | null; entries: Entry[] }[] {
  const sections: { heading: string | null; entries: Entry[] }[] = [];
  entries.forEach((entry, index) => {
    const heading = headingBefore(entries, index, empty);
    const last = sections[sections.length - 1];
    if (!last || heading) sections.push({ heading, entries: [entry] });
    else last.entries.push(entry);
  });
  return sections;
}

/**
 * Section titles. With no query the list is Recent, then Go to, then Do —
 * the fixture's empty-query order made visible. With a query the list is
 * one ranked run and only the full-text tail gets a title, because a header
 * per kind would have to reorder what the contract already ordered.
 */
function headingBefore(entries: Entry[], index: number, empty: boolean): string | null {
  const entry = entries[index]!;
  const previous = index > 0 ? entries[index - 1]! : null;
  if ('core' in entry) return previous && 'core' in previous ? null : t('Records');
  if ('hit' in entry) return previous && 'hit' in previous ? null : t('Docs');
  if (!empty) return null;
  const section = entry.recent ? 'Recent' : entry.row.kind === 'verb' ? 'Do' : 'Go to';
  const previousSection = previous && 'row' in previous
    ? (previous.recent ? 'Recent' : previous.row.kind === 'verb' ? 'Do' : 'Go to')
    : null;
  return section === previousSection ? null : section;
}
