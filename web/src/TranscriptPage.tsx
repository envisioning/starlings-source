import { SignInGate } from './SignInGate';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { confirmDataLoss } from './ConfirmDataLoss';
import { Button } from '@/ui/button';
import { Card, CardContent } from '@/ui/card';
import type { EraseMeetingResponse, MeetingDelivery, TranscriptSegment, TranscriptViewResponse } from '@starlings/contracts';
import { apiFetch } from './api';
import { ErrorNotice } from './ErrorNotice';
import { Note, PAGE, SectionCard } from './SectionCard';
import { AppShell, MemberLoadingShell } from './SiteChrome';
import { useDocumentTitle } from './document-title';
import { Markdown } from './markdown';
import { useOwnerSession } from './owner-session';
import { HOSTED_MEETING_KINDS } from './subject-pickers';
import { plural, t, dateLocale } from './i18n';
import { LoadingIndicator, Spinner } from '@/ui/spinner';
import {
  formatTranscript,
  transcriptExportAttendees,
  transcriptFileName,
  type TranscriptExportFormat,
  type TranscriptExportInput,
} from '@starlings/contracts/transcript-export';
import { toast } from './Toast';
import { transcriptPermalink } from './config';
import { DecisionCandidates, TranscriptLines } from './transcript-parts';

/**
 * One meeting's record: the notes, then every line of the transcript with a
 * checkbox. Select lines — click, shift-click a range — and strike them.
 * Gone means gone: from the record, the Docs document and Core alike. The
 * notes stay as written; Admin › Rewrite notes rewrites them from what is
 * left. Reached from Admin › Meetings.
 *
 * It is also the page a share opens: the link is this address on
 * the public origin, with no token in it. Who may read it is unchanged — a
 * visitor gets sign-in, a member who cannot read the meeting the refusal.
 */
export function TranscriptPage({ roomSlug, meetingID }: { roomSlug: string; meetingID: string }) {
  const session = useOwnerSession();
  if (session.kind === 'loading') return <MemberLoadingShell />;
  if (session.kind === 'visitor') {
    return (
      <SignInGate title={t('Transcript')} />
    );
  }
  return (
    <AppShell variant="wide" member="home" memberNavCurrent={null}>
      <div className={PAGE}>
        <Transcript roomSlug={roomSlug} meetingID={meetingID} />
      </div>
    </AppShell>
  );
}

function Transcript({ roomSlug, meetingID }: { roomSlug: string; meetingID: string }) {
  const [view, setView] = useState<TranscriptViewResponse | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [erased, setErased] = useState<EraseMeetingResponse | null>(null);

  const load = useCallback(async () => {
    const body = await apiFetch<TranscriptViewResponse>(`/rooms/${encodeURIComponent(roomSlug)}/meetings/${encodeURIComponent(meetingID)}/transcript`, {
      fallbackError: t('Couldn’t load the transcript.'),
      noStore: true,
    });
    setView(body);
    setError('');
  }, [roomSlug, meetingID]);

  useEffect(() => {
    void load().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : t('Couldn’t load the transcript.')));
  }, [load]);

  const title = view?.artifact.title ?? t('Meeting');
  useDocumentTitle(title, t('Transcript'));
  const lines = useMemo(() => view?.artifact.transcript ?? [], [view]);

  function toggle(line: TranscriptSegment, shift: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (shift && anchor) {
        // A range from the last plain click to this one, inclusive.
        const from = lines.findIndex((l) => l.id === anchor);
        const to = lines.findIndex((l) => l.id === line.id);
        if (from >= 0 && to >= 0) {
          for (let index = Math.min(from, to); index <= Math.max(from, to); index += 1) next.add(lines[index]!.id);
          return next;
        }
      }
      if (next.has(line.id)) next.delete(line.id); else next.add(line.id);
      return next;
    });
    if (!shift) setAnchor(line.id);
  }

  async function rename(line: TranscriptSegment) {
    const name = window.prompt(t('Rename {speaker_name} on every line:', { speaker_name: line.speaker_name }), line.speaker_name)?.trim();
    if (!name || name === line.speaker_name) return;
    setBusy(true);
    setNotice('');
    try {
      const body = await apiFetch<{ renamed: number }>(`/rooms/${encodeURIComponent(roomSlug)}/meetings/${encodeURIComponent(meetingID)}/transcript`, {
        method: 'PATCH',
        body: { speaker_id: line.speaker_id, speaker_name: name },
        fallbackError: t('Couldn’t rename the speaker.'),
        noStore: true,
      });
      setNotice(t('Renamed {lines} to {name}.', { lines: plural(body.renamed, { one: '{count} line', other: '{count} lines' }), name }));
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t rename the speaker.'));
    } finally {
      setBusy(false);
    }
  }

  async function strike() {
    const ids = [...selected];
    if (!ids.length) return;
    if (!await confirmDataLoss({
      title: t('Delete {lines} from the transcript?', { lines: plural(ids.length, { one: '{count} line', other: '{count} lines' }) }),
      body: t('This can’t be undone.'),
      action: t('Delete'),
    })) return;
    setBusy(true);
    setNotice('');
    try {
      const body = await apiFetch<{ removed: number }>(`/rooms/${encodeURIComponent(roomSlug)}/meetings/${encodeURIComponent(meetingID)}/transcript`, {
        method: 'DELETE',
        body: { segment_ids: ids },
        fallbackError: t('Couldn’t delete the lines.'),
        noStore: true,
      });
      setSelected(new Set());
      setAnchor(null);
      setNotice(t('Deleted {lines}.', { lines: plural(body.removed, { one: '{count} line', other: '{count} lines' }) }));
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t delete the lines.'));
    } finally {
      setBusy(false);
    }
  }

  /** The owner's Delete meeting: every copy, then the receipt. */
  async function eraseAll() {
    if (!await confirmDataLoss({
      title: t('Delete this meeting for everyone?'),
      body: t('This deletes the notes, the transcript and its Docs document. Tasks and decisions stay. Backups keep the meeting for 30 days. This can’t be undone.'),
      action: t('Delete meeting'),
    })) return;
    setBusy(true);
    setNotice('');
    setError('');
    try {
      setErased(await apiFetch<EraseMeetingResponse>(`/rooms/${encodeURIComponent(roomSlug)}/meetings/${encodeURIComponent(meetingID)}/erase`, {
        method: 'POST',
        body: {},
        fallbackError: t('Couldn’t delete the meeting.'),
        noStore: true,
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t delete the meeting.'));
    } finally {
      setBusy(false);
    }
  }

  if (erased) return <ErasureReceipt receipt={erased} retry={() => void eraseAll()} busy={busy} />;
  if (error && !view) return <ErrorNotice message={error} action={<Button type="button" variant="secondary" onClick={() => void load().catch(() => {})}>{t('Retry')}</Button>} />;
  if (!view) return <LoadingIndicator placement="full-page" label={t('Opening…')} labelVisibility="visible" />;

  const started = new Date(view.artifact.startedAt);
  const kind = view.category.meeting_kind === 'uncategorized' ? 'Unfiled' : view.category.subject_title ?? view.category.meeting_kind;
  const readOnly = view.read_only === true;
  const exportInput = transcriptExportInput(view, title);
  const attendees = transcriptExportAttendees(exportInput);

  return (
    <>
      <p className="m-0 text-sm text-muted-foreground">{started.toLocaleDateString(dateLocale, { year: 'numeric', month: 'long', day: 'numeric' })} · {kind}</p>
      <h1>{title}</h1>
      <dl className="m-0 mb-3 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
        {attendees.length > 0 && (
          <>
            <dt className="text-muted-foreground">{t('Attendees')}</dt>
            <dd className="m-0">{attendees.join(', ')}</dd>
          </>
        )}
        {view.category.subject_title && (
          <>
            <dt className="text-muted-foreground">{t('Subject')}</dt>
            <dd className="m-0">{view.category.subject_title}</dd>
          </>
        )}
      </dl>
      <TranscriptShare input={exportInput} />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      {view.artifact.summary && (
        <Card role="region" aria-label={t('Notes')} className="py-4 shadow-none">
          <CardContent className="px-5">
            <Markdown text={view.artifact.summary} />
          </CardContent>
        </Card>
      )}
      <DecisionCandidates
        candidates={view.decision_candidates ?? []}
        filed={(HOSTED_MEETING_KINDS as string[]).includes(view.category.meeting_kind)}
        answer={async (index, accept) => {
          await apiFetch(`/rooms/${encodeURIComponent(roomSlug)}/meetings/${encodeURIComponent(meetingID)}/decision-candidates/${index}`, {
            method: 'POST',
            fallbackError: accept ? t('Couldn’t record that decision.') : t('Couldn’t dismiss that.'),
            body: { accept },
          });
          await load();
        }}
      />
      <SectionCard id="transcript-heading" title={t('Transcript')}>
        <div className="flex items-center justify-between gap-3">
          <Note as="span" role="status">{plural(lines.length, { one: '{count} line', other: '{count} lines' })}{selected.size ? t(' · {count} selected', { count: selected.size }) : ''}</Note>
          {!readOnly && <Button type="button" variant="secondary" disabled={!selected.size || busy} onClick={() => void strike()}>
            {busy && <Spinner aria-hidden />}
            {busy ? t('Deleting…') : selected.size ? t('Delete {selected}', { selected: selected.size }) : t('Delete')}
          </Button>}
        </div>
        {error && <ErrorNotice message={error} />}
        {notice && <Note role="status">{notice}</Note>}
        {!readOnly && <Note role="status">{deliveryLine(view.deliveries, view.notes_stale)}</Note>}
        {lines.length === 0 && <Note>{t('No transcript.')}</Note>}
        <TranscriptLines
          lines={lines}
          selected={selected}
          readOnly={readOnly}
          onToggle={toggle}
          onRename={(line) => void rename(line)}
        />
      </SectionCard>
      {!readOnly && (
        <SectionCard id="delete-meeting-heading" title={t('Delete meeting')}>
          <Note>{t('Deletes the meeting from Starlings and Docs for everyone who was in it.')}</Note>
          <div>
            <Button type="button" variant="destructive" disabled={busy} onClick={() => void eraseAll()}>{t('Delete meeting')}</Button>
          </div>
        </SectionCard>
      )}
      </div>
    </>
  );
}

/**
 * What a Delete meeting reached, store by store (docs/DATA_REQUESTS.md). A
 * failed store is finished by deleting again: every step is idempotent.
 */
function ErasureReceipt({ receipt, retry, busy }: { receipt: EraseMeetingResponse; retry: () => void; busy: boolean }) {
  const names: Record<EraseMeetingResponse['steps'][number]['store'], string> = {
    room: t('Meeting record'), ledger: t('Delivery records'), subject_records: t('Subject history'),
    docs: t('Docs document'), core: t('Filed record'), tasks: t('Tasks'), decisions: t('Decisions'), backups: t('Backups'),
  };
  const result = (step: EraseMeetingResponse['steps'][number]) => {
    switch (step.result) {
      case 'erased': return t('Deleted');
      case 'none': return t('Nothing there');
      case 'failed': return t('Failed');
      case 'not_reachable': return t('Not reached: ask an admin');
      case 'kept': return step.store === 'backups'
        ? t('Kept until {date}', { date: new Date(receipt.backups_end_at).toLocaleDateString(dateLocale, { year: 'numeric', month: 'long', day: 'numeric' }) })
        : step.count ? t('Kept: {count}', { count: step.count }) : t('Kept');
    }
  };
  const failed = receipt.steps.some((step) => step.result === 'failed');
  return (
    <>
      <h1>{t('Meeting deleted')}</h1>
      <SectionCard id="erasure-receipt-heading" title={t('Receipt {id}', { id: receipt.request_id })}>
        <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
          {receipt.steps.map((step) => (
            <div key={step.store} className="contents">
              <dt className="text-muted-foreground">{names[step.store]}</dt>
              <dd className="m-0">{result(step)}</dd>
            </div>
          ))}
        </dl>
        {failed && (
          <ErrorNotice
            message={t('Starlings couldn’t delete some copies.')}
            action={<Button type="button" variant="secondary" size="xs" disabled={busy} onClick={retry}>{t('Retry')}</Button>}
          />
        )}
      </SectionCard>
    </>
  );
}

/** The record as the shared formatter reads it: this page's view, in this browser's zone. */
function transcriptExportInput(view: TranscriptViewResponse, title: string): TranscriptExportInput {
  return {
    title,
    started_at: view.artifact.startedAt,
    time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    subject: view.category.subject_title,
    attendees: view.attendees ?? [],
    link: transcriptPermalink(view.artifact.roomSlug, view.artifact.meetingId),
    lines: view.artifact.transcript,
  };
}

/**
 * Getting the transcript out: the link to this page, the system
 * share sheet where the browser has one, the text on the clipboard, and the
 * `.md` / `.txt` files. Every client formats with the same rule
 * (`@starlings/contracts/transcript-export`), so a file from the web and one from
 * the Mac say the same thing. Struck lines are already gone from the record;
 * renamed speakers already carry the new name.
 */
function TranscriptShare({ input }: { input: TranscriptExportInput }) {
  const [error, setError] = useState('');
  const link = input.link ?? '';
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  async function copy(text: string, done: string, failed: string) {
    setError('');
    try {
      await navigator.clipboard.writeText(text);
      toast(done);
    } catch {
      setError(failed);
    }
  }

  async function share() {
    setError('');
    try {
      await navigator.share({ title: input.title, url: link });
    } catch (cause) {
      // Closing the sheet is a choice, not a failure.
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setError(t('Couldn’t share the link.'));
    }
  }

  function download(format: TranscriptExportFormat) {
    setError('');
    try {
      const text = formatTranscript(input, format);
      const type = format === 'md' ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8';
      const url = URL.createObjectURL(new Blob([text], { type }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = transcriptFileName(input.title, input.started_at, input.time_zone, format);
      // A download, not a navigation: the document click listener leaves it to the browser.
      anchor.dataset.reload = '';
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
      setError(t('Couldn’t download the transcript.'));
    }
  }

  return (
    <div className="mb-5 grid gap-2">
    <div className="flex flex-wrap gap-2" role="group" aria-label={t('Share transcript')}>
      <Button type="button" variant="secondary" size="sm" onClick={() => void copy(link, t('Link copied'), t('Couldn’t copy the link.'))}>{t('Copy link')}</Button>
      {canShare && <Button type="button" variant="secondary" size="sm" onClick={() => void share()}>{t('Share…')}</Button>}
      <Button type="button" variant="secondary" size="sm" onClick={() => void copy(formatTranscript(input, 'txt'), t('Transcript copied'), t('Couldn’t copy the transcript.'))}>{t('Copy transcript')}</Button>
      <Button type="button" variant="secondary" size="sm" onClick={() => download('md')}>{t('Download .md')}</Button>
      <Button type="button" variant="secondary" size="sm" onClick={() => download('txt')}>{t('Download .txt')}</Button>
    </div>
    {error && <ErrorNotice message={error} />}
    </div>
  );
}


/**
 * Saved in Meet, then what each destination has: the record is
 * here; Docs and Core are copies that arrive, or have not yet, or failed.
 * A page that once said "follow in a moment" promised what it could not see.
 */
function deliveryLine(deliveries: MeetingDelivery[], notesStale: boolean): string {
  const names: Record<MeetingDelivery['destination'], string> = { docs: 'Docs', core: t('Filed record'), proposals: 'Work', followup: 'Inbox' };
  const parts = deliveries.map((row) => {
    const name = names[row.destination];
    if (row.status === 'delivered') return t('{name} current', { name });
    if (row.status === 'failed') return t('{name} failed, retrying', { name });
    return t('{name} pending', { name });
  });
  const line = [t('Saved in Starlings'), ...parts].join(' · ');
  return notesStale ? `${line} · ${t('Notes predate the transcript')}` : line;
}
