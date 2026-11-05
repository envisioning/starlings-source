import { SignInGate } from './SignInGate';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Checkbox } from '@/ui/checkbox';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table';
import { Input } from '@/ui/input';
import { Item, ItemGroup } from '@/ui/item';
import { Button } from '@/ui/button';
import { SegmentedFilter } from './SegmentedFilter';
import type { GranolaLedgerResponse, GranolaNoteRow, GranolaNotesResponse, GranolaProposal, GranolaProposalsResponse, GranolaRefreshResponse, MeetingCategoryResponse } from '@starlings/contracts';
import { apiFetch } from './api';
import { ControlRequestError } from './config';
import { ErrorNotice } from './ErrorNotice';
import { LEDGER, Note, PAGE, SectionCard, TableFrame } from './SectionCard';
import { Filing, bodyFor, suggestedBody } from './MeetingFiling';
import { createSubject } from './crm-work';
import { AppShell, MemberLoadingShell } from './SiteChrome';
import { ConnectorHeader } from './AdminNav';
import { useDocumentTitle } from './document-title';
import { useOwnerSession } from './owner-session';
import { t, dateLocale } from './i18n';
import { LoadingIndicator, Spinner } from '@/ui/spinner';
import { PlaceholderBar, PlaceholderRows } from '@/ui/placeholder-rows';

/**
 * Connectors → Granola: Granola's history beside Core's ledger.
 *
 * One list, three states a row can be in: not imported, imported, imported and
 * filed. Import writes the note into Core through the same path a hosted Meet
 * session takes; filing is the same kind + subject the Calendar inspector
 * sets on a Meet meeting. An unfiled row may carry the model's suggestion
 * (docs/GRANOLA_BRIDGE.md §Suggested filing), one tap to confirm. Nothing here
 * is a wizard — the list is the probe, the import and the reconciliation, and
 * it reads the same after each.
 */
export function GranolaConnectorPage() {
  const session = useOwnerSession();
  useDocumentTitle(t('Granola'));

  if (session.kind === 'loading') return <MemberLoadingShell />;
  if (session.kind === 'visitor') {
    return (
      <SignInGate title={t('Granola')} />
    );
  }

  return (
    <AppShell variant="wide" member="home" memberNavCurrent={null}>
      <div className={PAGE}>
        <ConnectorHeader name={t('Granola')} lede={t('Every meeting Granola captured, and whether each is in Work yet. Import, then file on a project or a lead.')} />
        <GranolaList />
      </div>
    </AppShell>
  );
}

type Filter = 'all' | 'new' | 'unfiled' | 'filed';

/** How long the list keeps asking after an import before it stops on its own. */
const IMPORT_WATCH_MS = 90_000;
const IMPORT_POLL_MS = 10_000;
/** How a rate-limited page read waits before asking again. */
const RATE_LIMIT_PAUSE_MS = 4_000;
const RATE_LIMIT_RETRIES = 5;
/** `granolaImportSchema` caps one request's ids. */
const IMPORT_BATCH = 200;

function GranolaList() {
  const [pages, setPages] = useState<GranolaNotesResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notConfigured, setNotConfigured] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState('');
  const watchUntil = useRef(0);

  const notes = useMemo(() => pages.flatMap((page) => page.notes), [pages]);
  const importedCount = pages.length ? pages[pages.length - 1]!.imported_count : 0;

  // One read of Meet's own index; Granola is not touched. The first open of
  // an empty index is the one slow case (the Worker walks Granola once), and
  // a 429 there is asked again after a pause rather than failing.
  const load = useCallback(async () => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await apiFetch<GranolaNotesResponse>('/granola/notes', {
          fallbackError: t('Couldn’t read Granola.'),
          noStore: true,
        });
      } catch (cause) {
        const status = cause instanceof ControlRequestError ? cause.status : 0;
        if (status !== 429 || attempt >= RATE_LIMIT_RETRIES) throw cause;
        await new Promise((resolve) => window.setTimeout(resolve, RATE_LIMIT_PAUSE_MS * (attempt + 1)));
      }
    }
  }, []);

  const loadAll = useCallback(async () => [await load()], [load]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void loadAll().then((all) => {
      if (cancelled) return;
      setPages(all);
      setError('');
    }).catch((cause: unknown) => {
      if (cancelled) return;
      const message = cause instanceof Error ? cause.message : t('Couldn’t read Granola.');
      if (/not configured/iu.test(message)) setNotConfigured(true);
      else setError(message);
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [loadAll]);

  // Ask Granola for what the index lacks — one page when nothing is new —
  // then re-read the index.
  const [checking, setChecking] = useState(false);
  async function checkGranola() {
    setChecking(true);
    setNotice('');
    try {
      const body = await apiFetch<GranolaRefreshResponse>('/granola/refresh', {
        method: 'POST',
        fallbackError: t('Couldn’t read Granola.'),
        noStore: true,
      });
      setPages(await loadAll());
      setNotice(body.added ? t('{added} new in Granola.', { added: body.added }) : t('Nothing new in Granola.'));
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t read Granola.'));
    } finally {
      setChecking(false);
    }
  }

  // Re-read everything — after an import lands, after a filing.
  const refresh = useCallback(async () => {
    const fresh = await loadAll();
    setPages(fresh);
    return fresh.flatMap((page) => page.notes);
  }, [loadAll]);

  // Core's side alone, merged into the pages we hold: one cached Core read,
  // no Granola reads. The poll below used to re-walk every page.
  const refreshLedger = useCallback(async () => {
    const ledger = await apiFetch<GranolaLedgerResponse>('/granola/ledger', { fallbackError: t('Couldn’t read Granola.'), noStore: true });
    setPages((current) => current.map((page) => ({
      ...page,
      imported_count: ledger.imported_count,
      notes: page.notes.map((note) => ({ ...note, imported: ledger.imported[note.id] ?? null })),
    })));
    return ledger;
  }, []);

  // While an import is in flight the queue writes Core behind the list's
  // back, so the list asks Core again until every queued note shows as
  // imported — or gives up after a while and says so.
  useEffect(() => {
    if (!pending.size) return;
    const handle = window.setInterval(() => {
      void refreshLedger().then((ledger) => {
        const landed = new Set(Object.keys(ledger.imported));
        setPending((current) => {
          const next = new Set([...current].filter((id) => !landed.has(id)));
          if (next.size === 0) setNotice(t('Imported.'));
          else if (Date.now() > watchUntil.current) {
            setNotice(t('{next} still importing. The list shows them once they arrive.', { next: next.size }));
            return new Set();
          }
          return next;
        });
      }).catch(() => { /* the next tick tries again */ });
    }, IMPORT_POLL_MS);
    return () => window.clearInterval(handle);
  }, [pending.size, refreshLedger]);

  async function importSelected(ids: string[]) {
    if (!ids.length) return;
    setImporting(true);
    setNotice('');
    try {
      // The route takes two hundred ids at a time; a whole history goes in
      // as many requests as that needs, one after the other.
      let queued = 0;
      for (let index = 0; index < ids.length; index += IMPORT_BATCH) {
        const body = await apiFetch<{ queued: number }>('/granola/import', {
          method: 'POST',
          body: { note_ids: ids.slice(index, index + IMPORT_BATCH) },
          fallbackError: t('Couldn’t start the import.'),
          noStore: true,
        });
        queued += body.queued;
      }
      watchUntil.current = Date.now() + IMPORT_WATCH_MS * Math.ceil(ids.length / IMPORT_BATCH);
      setPending(new Set(ids));
      setSelected(new Set());
      setNotice(t('Importing {queued}…', { queued }));
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t start the import.'));
    } finally {
      setImporting(false);
    }
  }

  const visible = notes.filter((row) => {
    if (filter === 'new') return !row.imported;
    if (filter === 'unfiled') return row.imported && row.imported.meeting_kind === 'uncategorized';
    if (filter === 'filed') return row.imported && row.imported.meeting_kind !== 'uncategorized';
    return true;
  });
  const importable = visible.filter((row) => !row.imported && !pending.has(row.id));
  const notImported = notes.filter((row) => !row.imported && !pending.has(row.id));
  const unfiledWithoutSuggestion = notes.filter((row) => row.imported && row.imported.meeting_kind === 'uncategorized' && !row.imported.suggestion).length;
  const [suggesting, setSuggesting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  /** The visible rows whose suggestion files in one step, with the body each files as. */
  const confirmable = visible.flatMap((row) => {
    const suggestion = row.imported?.meeting_kind === 'uncategorized' ? row.imported.suggestion : null;
    if (!suggestion) return [];
    const body = suggestedBody(suggestion);
    return body ? [{ row, body }] : [];
  });

  /** Everything not yet in Core, whatever the filter shows, in batches. */
  function importEverything() {
    void importSelected(notes.filter((row) => !row.imported && !pending.has(row.id)).map((row) => row.id));
  }

  /** One row, filed: the same state move whether a person tapped it or a batch did. */
  const markFiled = useCallback((id: string, category: MeetingCategoryResponse) => {
    setPages((current) => current.map((page) => ({
      ...page,
      notes: page.notes.map((note) => (note.id === id && note.imported
        ? {
          ...note,
          imported: {
            ...note.imported,
            meeting_kind: category.meeting_kind,
            lead_id: category.lead_id,
            project_id: category.project_id,
            subject_title: category.subject_title,
            suggestion: null,
          },
        }
        : note)),
    })));
  }, []);

  /**
   * Confirm every drawn suggestion the filter shows, one request after the
   * other. The same act as tapping each row's suggestion button and the same
   * route, so Core sees no new kind of write and each row is still a person
   * saying yes — to a list they are looking at, rather than to 411 buttons.
   *
   * Only suggestions that file in one step: a kind whose subject the model
   * could not name opens the picker, and a lead that does not exist yet has
   * to be created. Those stay one at a time.
   */
  async function confirmSuggested() {
    const rows = confirmable;
    if (!rows.length) return;
    setConfirming(true);
    setError('');
    let filed = 0;
    for (const { row, body } of rows) {
      try {
        const category = await apiFetch<MeetingCategoryResponse>(`/granola/notes/${encodeURIComponent(row.id)}/category`, {
          method: 'PUT',
          body,
          fallbackError: t('Couldn’t file the meeting.'),
          noStore: true,
        });
        filed += 1;
        markFiled(row.id, category);
        setNotice(t('Filed {filed} of {total}…', { filed, total: rows.length }));
      } catch (cause) {
        // One refusal stops the run: the rest are still there to confirm,
        // and filing on through an error would hide which row broke.
        setError(cause instanceof Error ? cause.message : t('Couldn’t file the meeting.'));
        break;
      }
    }
    setNotice(t('Filed {filed} of {total}.', { filed, total: rows.length }));
    setConfirming(false);
  }

  /** Suggestions for the imported rows that have none (docs/GRANOLA_BRIDGE.md §Suggested filing). */
  async function suggestFiling() {
    setSuggesting(true);
    setNotice('');
    try {
      const body = await apiFetch<{ queued: number }>('/granola/suggest', {
        method: 'POST',
        fallbackError: t('Couldn’t ask for suggestions.'),
        noStore: true,
      });
      setNotice(body.queued ? t('Asking for {queued} suggestions. Reload in a minute.', { queued: body.queued }) : t('Every unfiled row has its answer, or suggestions are off.'));
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t ask for suggestions.'));
    } finally {
      setSuggesting(false);
    }
  }
  const allImportableSelected = importable.length > 0 && importable.every((row) => selected.has(row.id));

  function toggleAll() {
    setSelected(allImportableSelected ? new Set() : new Set(importable.map((row) => row.id)));
  }

  if (notConfigured) {
    return <Note>{t('The Granola bridge isn’t configured on this deployment — GRANOLA_API_KEY and records sync are both needed.')}</Note>;
  }

  return (
    <section className="grid grid-cols-[minmax(0,1fr)] gap-3">
      <div className={LEDGER.toolbar}>
        <SegmentedFilter
          label={t('Show')}
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: t('All') },
            { value: 'new', label: t('Not imported') },
            { value: 'unfiled', label: t('Unfiled') },
            { value: 'filed', label: t('Filed') },
          ]}
        />
        <div className={LEDGER.actions}>
          {loading
            ? <PlaceholderBar className="h-3 w-44 rounded-full" />
            : <Note as="span">{t('{notes} in Granola · {imported} in Work', { notes: notes.length, imported: importedCount })}</Note>}
          <Button type="button" variant="secondary" disabled={loading || checking} onClick={() => void checkGranola()}>
            {checking && <Spinner aria-hidden />}
            {checking ? t('Checking…') : t('Check Granola')}
          </Button>
          <Button type="button" variant="secondary" disabled={!selected.size || importing} onClick={() => void importSelected([...selected])}>
            {importing && <Spinner aria-hidden />}
            {importing ? t('Starting…') : selected.size ? t('Import {selected}', { selected: selected.size }) : t('Import')}
          </Button>
          {!loading && notImported.length > 0 && (
            <Button type="button" variant="secondary" disabled={importing} onClick={importEverything}>
              {t('Import everything ({count})', { count: notImported.length })}
            </Button>
          )}
          {!loading && confirmable.length > 0 && (
            <Button type="button" disabled={confirming} onClick={() => void confirmSuggested()}>
              {confirming && <Spinner aria-hidden />}
              {confirming ? t('Filing…') : t('Confirm {count} suggestions', { count: confirmable.length })}
            </Button>
          )}
          {!loading && unfiledWithoutSuggestion > 0 && (
            <Button type="button" variant="secondary" disabled={suggesting} onClick={() => void suggestFiling()}>
              {suggesting && <Spinner aria-hidden />}
              {suggesting ? t('Asking…') : t('Suggest filing ({count})', { count: unfiledWithoutSuggestion })}
            </Button>
          )}
        </div>
      </div>

      <ProposedLeads onFiled={markFiled} />

      {error && <ErrorNotice message={error} action={<Button type="button" variant="secondary" onClick={() => void refresh().catch(() => {})}>{t('Retry')}</Button>} />}
      {notice && <Note role="status">{notice}</Note>}

      {loading && <PlaceholderRows count={5} label={t('Reading…')} />}
      {!loading && visible.length === 0 && (
        <Note>
          {notes.length === 0 ? t('Granola has no notes the key can see.') : filter === 'new' ? t('Everything here is already in Work.') : filter === 'unfiled' ? t('Nothing imported is waiting to be filed.') : t('Nothing has been filed yet.')}
        </Note>
      )}

      {visible.length > 0 && (
        <TableFrame>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col" className={LEDGER.check}>
                  <Checkbox aria-label={t('Select every meeting not yet imported')} checked={allImportableSelected} disabled={importable.length === 0} onCheckedChange={toggleAll} />
                </TableHead>
                <TableHead scope="col">{t('Meeting')}</TableHead>
                <TableHead scope="col">{t('When')}</TableHead>
                <TableHead scope="col">{t('Who')}</TableHead>
                <TableHead scope="col">{t('In Work')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((row) => (
                <MeetingRow
                  key={row.id}
                  row={row}
                  pending={pending.has(row.id)}
                  selected={selected.has(row.id)}
                  onSelect={(on) => setSelected((current) => {
                    const next = new Set(current);
                    if (on) next.add(row.id); else next.delete(row.id);
                    return next;
                  })}
                  onImport={() => void importSelected([row.id])}
                  onFiled={(category) => markFiled(row.id, category)}
                />
              ))}
            </TableBody>
          </Table>
        </TableFrame>
      )}

    </section>
  );
}


/**
 * The leads the unfiled meetings suggest but Core does not hold.
 *
 * One card per company, not per meeting: the name comes from Core's
 * organization or from the guest email domain, and confirming creates the
 * lead once and files every meeting in the cluster on it. Nothing here is
 * automatic — the name is editable and the act is a tap, because inferring a
 * lead from a domain is exactly the silent wrong link MEETING_LOG.md forbids.
 */
function ProposedLeads({ onFiled }: { onFiled: (noteId: string, category: MeetingCategoryResponse) => void }) {
  const [proposals, setProposals] = useState<GranolaProposal[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    void apiFetch<GranolaProposalsResponse>('/granola/proposals', { fallbackError: t('Couldn’t read the proposals.'), noStore: true })
      .then((body) => { if (!cancelled) setProposals(body.proposals); })
      .catch(() => { /* the list is the page; a missing block is not an error worth shouting */ });
    return () => { cancelled = true; };
  }, []);

  async function createAndFile(proposal: GranolaProposal) {
    const title = (names[proposal.domain] ?? proposal.name).trim();
    if (!title) return;
    if (!proposal.existing && !proposal.organization_id) {
      setError(t('This lead needs an organization before it can be created.'));
      return;
    }
    setBusy(proposal.domain);
    setError('');
    try {
      // An existing subject means this was never a new lead: file on it.
      const subject = proposal.existing
        ? { id: proposal.existing.id, kind: proposal.existing.kind }
        : {
          id: (await createSubject({
            kind: 'lead',
            title,
            status: 'Conversations',
            start_date: '',
            end_date: '',
            description: '',
            url: '',
            notes: '',
            organization_id: proposal.organization_id!,
          })).id,
          kind: 'lead' as const,
        };
      let filed = 0;
      for (const meeting of proposal.meetings) {
        const category = await apiFetch<MeetingCategoryResponse>(`/granola/notes/${encodeURIComponent(meeting.note_id)}/category`, {
          method: 'PUT',
          body: bodyFor(subject.kind, subject.id),
          fallbackError: t('Couldn’t file the meeting.'),
          noStore: true,
        });
        onFiled(meeting.note_id, category);
        filed += 1;
        setNotice(t('Filed {filed} of {total} on {title}…', { filed, total: proposal.meetings.length, title }));
      }
      setProposals((current) => current.filter((row) => row.domain !== proposal.domain));
      setNotice(t('Filed {filed} meetings on {title}.', { filed, title }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t create that lead.'));
    } finally {
      setBusy(null);
    }
  }

  if (proposals.length === 0) return null;
  return (
    <SectionCard id="granola-proposals" title={t('Leads these meetings suggest')}>
      <Note>
        {t('Meetings with a company not on record yet, grouped by who was in the room. One lead per company, not per meeting.')}
      </Note>
      {error && <ErrorNotice message={error} />}
      {notice && <Note role="status">{notice}</Note>}
      <ItemGroup className="gap-2">
        {proposals.map((proposal) => (
          <Item key={proposal.domain} role="listitem" variant="muted" size="sm" className="gap-3">
            <Input
              className="flex-[1_1_220px]"
              type="text"
              aria-label={t('Lead name')}
              value={names[proposal.domain] ?? proposal.name}
              onChange={(event) => setNames((current) => ({ ...current, [proposal.domain]: event.target.value }))}
              disabled={Boolean(proposal.existing) || busy === proposal.domain}
            />
            <Note as="span">
              {proposal.domain} · {t('{count} meetings', { count: proposal.meetings.length })}
              {proposal.existing && ` · ${t('already on record as {title}', { title: proposal.existing.title })}`}
            </Note>
            <Button type="button" disabled={busy !== null} onClick={() => void createAndFile(proposal)}>
              {busy === proposal.domain && <Spinner aria-hidden />}
              {busy === proposal.domain
                ? t('Filing…')
                : proposal.existing ? t('File on {title}', { title: proposal.existing.title }) : t('Create & file')}
            </Button>
          </Item>
        ))}
      </ItemGroup>
    </SectionCard>
  );
}

function MeetingRow({ row, pending, selected, onSelect, onImport, onFiled }: {
  row: GranolaNoteRow;
  pending: boolean;
  selected: boolean;
  onSelect: (on: boolean) => void;
  onImport: () => void;
  onFiled: (category: MeetingCategoryResponse) => void;
}) {
  const when = new Date(row.started_at);
  const people = row.attendees.map((person) => person.name || person.email || '').filter(Boolean);
  return (
    <TableRow>
      <TableCell className={LEDGER.check}>
        {!row.imported && !pending && (
          <Checkbox aria-label={t('Select {title}', { title: row.title ?? t('this meeting') })} checked={selected} onCheckedChange={(checked) => onSelect(checked === true)} />
        )}
      </TableCell>
      <TableCell>
        <strong className={LEDGER.title}>{row.title ?? t('Untitled meeting')}</strong>
        {row.web_url && <> <span className="ml-1.5 text-xs text-muted-foreground"><a href={row.web_url} target="_blank" rel="noreferrer" className="no-underline hover:underline">{t('Granola ↗')}</a></span></>}
      </TableCell>
      <TableCell><time dateTime={row.started_at}>{when.toLocaleDateString(dateLocale, { year: 'numeric', month: 'short', day: 'numeric' })}</time></TableCell>
      <TableCell className={LEDGER.who}>{people.slice(0, 3).join(', ')}{people.length > 3 ? ` +${people.length - 3}` : ''}</TableCell>
      <TableCell className={LEDGER.state}>
        {pending && <LoadingIndicator placement="inline" label={t('Importing…')} labelVisibility="visible" />}
        {!pending && !row.imported && (
          <Button type="button" variant="secondary" size="sm" onClick={onImport}>{t('Import')}</Button>
        )}
        {row.imported && (
          <Filing
            kind={row.imported.meeting_kind}
            subjectTitle={row.imported.subject_title}
            hasTranscript={row.imported.has_transcript}
            title={row.title}
            suggestion={row.imported.suggestion}
            file={(body) => apiFetch<MeetingCategoryResponse>(`/granola/notes/${encodeURIComponent(row.id)}/category`, {
              method: 'PUT',
              body,
              fallbackError: t('Couldn’t file the meeting.'),
              noStore: true,
            })}
            onFiled={onFiled}
          />
        )}
      </TableCell>
    </TableRow>
  );
}
