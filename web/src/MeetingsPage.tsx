import { SignInGate } from './SignInGate';
import { useEffect, useState } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table';
import type { AmbientMeetingRow, AmbientMeetingsResponse, MeetingCategoryResponse } from '@starlings/contracts';
import { apiFetch } from './api';
import { ErrorNotice } from './ErrorNotice';
import { Filing } from './MeetingFiling';
import { LEDGER, Note, PAGE, SectionCard, TableFrame } from './SectionCard';
import { AppShell, MemberLoadingShell } from './SiteChrome';
import { useDocumentTitle } from './document-title';
import { useOwnerSession } from './owner-session';
import { t, dateLocale } from './i18n';
import { PlaceholderBar, PlaceholderRows } from '@/ui/placeholder-rows';

/**
 * Meetings — what this Mac recorded outside any room, and whether
 * each is in the CRM yet. Granola's history moved to `/connectors/granola`;
 * the filing control is shared (`MeetingFiling.tsx`).
 */
export function MeetingsPage() {
  const session = useOwnerSession();
  useDocumentTitle(t('Meetings'));

  if (session.kind === 'loading') return <MemberLoadingShell />;
  if (session.kind === 'visitor') {
    return (
      <SignInGate title={t('Meetings')} />
    );
  }

  return (
    <AppShell variant="wide" member="home" memberNavCurrent={null}>
      <div className={PAGE}>
        <h1>{t('Meetings')}</h1>
        <p className="lede">{t('Every meeting this Mac recorded, and whether each is in Work yet. File a recording on a project or a lead.')} <a href="/admin/connectors/granola">{t('Granola meetings')}</a></p>
        {session.room && <AmbientList roomSlug={session.room.slug} />}
      </div>
    </AppShell>
  );
}

/**
 * The meetings the Mac recorded outside any room. Each already
 * has its transcript in Docs; filing it is what writes the CRM interaction.
 */
function AmbientList({ roomSlug }: { roomSlug: string }) {
  const [rows, setRows] = useState<AmbientMeetingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void apiFetch<AmbientMeetingsResponse>(`/rooms/${encodeURIComponent(roomSlug)}/meetings?capture=ambient`, {
      fallbackError: t('Couldn’t read the recordings.'),
      noStore: true,
    }).then((body) => {
      if (cancelled) return;
      setRows(body.meetings);
      setError('');
    }).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : t('Couldn’t read the recordings.'));
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [roomSlug]);

  if (!loading && !error && rows.length === 0) return <Note>{t('Nothing recorded yet.')}</Note>;
  const unfiled = rows.filter((row) => row.meeting_kind === 'uncategorized').length;

  return (
    <SectionCard id="meetings-ambient" title={t('Recorded on the Mac')}>
      {loading
        ? <PlaceholderBar className="h-3 w-44 rounded-full" />
        : <Note>{t('{rows} recorded · {unfiled} to file', { rows: rows.length, unfiled })}</Note>}
      {error && <ErrorNotice message={error} />}
      {loading && <PlaceholderRows count={5} label={t('Reading…')} />}
      {rows.length > 0 && (
        <TableFrame>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{t('Meeting')}</TableHead>
                <TableHead scope="col">{t('When')}</TableHead>
                <TableHead scope="col">{t('Who')}</TableHead>
                <TableHead scope="col">{t('In Work')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <AmbientRow
                  key={row.id}
                  row={row}
                  onFiled={(category) => setRows((current) => current.map((item) => (item.id === row.id
                    ? { ...item, meeting_kind: category.meeting_kind, lead_id: category.lead_id, project_id: category.project_id, subject_title: category.subject_title }
                    : item)))}
                />
              ))}
            </TableBody>
          </Table>
        </TableFrame>
      )}
    </SectionCard>
  );
}

function AmbientRow({ row, onFiled }: { row: AmbientMeetingRow; onFiled: (category: MeetingCategoryResponse) => void }) {
  const when = new Date(row.started_at);
  const people = row.attendees.map((person) => person.name || person.email || '').filter(Boolean);
  return (
    <TableRow>
      <TableCell>
        <strong className={LEDGER.title}><a href={`/meetings/${encodeURIComponent(row.room_slug)}/${row.id}`}>{row.title ?? 'Untitled recording'}</a></strong>
        {row.summary_line && <Note as="span" className="mt-0.5 block">{row.summary_line}</Note>}
      </TableCell>
      <TableCell><time dateTime={row.started_at}>{when.toLocaleDateString(dateLocale, { year: 'numeric', month: 'short', day: 'numeric' })}</time></TableCell>
      <TableCell className={LEDGER.who}>{people.slice(0, 3).join(', ')}{people.length > 3 ? ` +${people.length - 3}` : ''}</TableCell>
      <TableCell className={LEDGER.state}>
        <Filing
          kind={row.meeting_kind}
          subjectTitle={row.subject_title}
          hasTranscript={row.has_transcript}
          file={(body) => apiFetch<MeetingCategoryResponse>(`/rooms/${encodeURIComponent(row.room_slug)}/meetings/${row.id}/category`, {
            method: 'PUT',
            body,
            fallbackError: t('Couldn’t file the meeting.'),
            noStore: true,
          })}
          onFiled={onFiled}
        />
      </TableCell>
    </TableRow>
  );
}
