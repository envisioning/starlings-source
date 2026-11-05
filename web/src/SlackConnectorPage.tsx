import { SignInGate } from './SignInGate';
import { useCallback, useEffect, useState } from 'react';
import { confirmDataLoss } from './ConfirmDataLoss';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table';
import { Button } from '@/ui/button';
import { SegmentedFilter } from './SegmentedFilter';
import type { DocsSubject, SlackConnectorResponse, SlackConnectorRow, SlackMappingResponse, SlackSubjectKind } from '@starlings/contracts';
import { apiFetch } from './api';
import type { CrmSubject } from './crm-work';
import { ErrorNotice } from './ErrorNotice';
import { LEDGER, Note, PAGE, TableFrame } from './SectionCard';
import { SubjectPicker } from './SubjectPicker';
import { SLACK_SUBJECT_KINDS } from './subject-pickers';
import { AppShell, MemberLoadingShell } from './SiteChrome';
import { ConnectorHeader } from './AdminNav';
import { useDocumentTitle } from './document-title';
import { useOwnerSession } from './owner-session';
import { t, dateLocale } from './i18n';
import { formatTime } from './meeting-time';
import { PlaceholderBar, PlaceholderRows } from '@/ui/placeholder-rows';

/**
 * Connectors → Slack: every channel the token's user is in, and
 * for each one the decision — which project or lead channel its history
 * lands in, Team, or skip — beside how far the sync has read it. The list is
 * the mapping and the ledger at once, as the GitHub page is.
 */
export function SlackConnectorPage() {
  const session = useOwnerSession();
  useDocumentTitle(t('Slack'));

  if (session.kind === 'loading') return <MemberLoadingShell />;
  if (session.kind === 'visitor') {
    return (
      <SignInGate title={t('Slack')} />
    );
  }

  return (
    <AppShell variant="wide" member="home" memberNavCurrent={null}>
      <div className={PAGE}>
        <ConnectorHeader name={t('Slack')} lede={t('Every channel the token can see. Map each one to a project, a lead, or Team, and its history lands in that channel.')} />
        <ChannelList />
      </div>
    </AppShell>
  );
}

type Filter = 'all' | 'unmapped' | 'mapped' | 'skipped';

/** While a channel is importing, the list asks again this often. */
const SYNC_POLL_MS = 5_000;

type MappingBody = { subject_kind: SlackSubjectKind | null; subject_id: string | null; subject_title?: string | null };

function ChannelList() {
  const [page, setPage] = useState<SlackConnectorResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notConfigured, setNotConfigured] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => apiFetch<SlackConnectorResponse>('/connectors/slack', {
    fallbackError: t('Couldn’t read Slack.'),
    noStore: true,
  }), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void load().then((body) => {
      if (cancelled) return;
      setPage(body);
      setError('');
    }).catch((cause: unknown) => {
      if (cancelled) return;
      const message = cause instanceof Error ? cause.message : t('Couldn’t read Slack.');
      if (/not configured/iu.test(message)) setNotConfigured(true);
      else setError(message);
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [load]);

  // A pass in flight writes the ledger behind the list's back.
  const importing = page?.rows.some((row) => row.state === 'importing' || row.state === 'queued') ?? false;
  useEffect(() => {
    if (!importing) return;
    const handle = window.setInterval(() => {
      void load().then(setPage).catch(() => { /* the next tick tries again */ });
    }, SYNC_POLL_MS);
    return () => window.clearInterval(handle);
  }, [importing, load]);

  function replaceRow(row: SlackConnectorRow) {
    setPage((current) => current ? { ...current, rows: current.rows.map((item) => (item.id === row.id ? row : item)) } : current);
  }

  async function save(row: SlackConnectorRow, body: MappingBody) {
    setNotice('');
    try {
      const result = await apiFetch<SlackMappingResponse>(`/connectors/slack/${encodeURIComponent(row.id)}`, {
        method: 'PUT',
        body,
        fallbackError: t('Couldn’t save the mapping.'),
        noStore: true,
      });
      replaceRow(result.row);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t save the mapping.'));
    }
  }

  async function syncNow(row: SlackConnectorRow) {
    setNotice('');
    try {
      await apiFetch<{ queued: number }>(`/connectors/slack/${encodeURIComponent(row.id)}/sync`, {
        method: 'POST',
        fallbackError: t('Couldn’t start the sync.'),
        noStore: true,
      });
      replaceRow({ ...row, state: 'queued', error: null });
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t start the sync.'));
    }
  }

  async function reverse(row: SlackConnectorRow) {
    if (!await confirmDataLoss({
      title: t('Remove every message Starlings imported from #{channel}?', { channel: row.name }),
      body: t('The mapping stays. This can’t be undone.'),
      action: t('Remove'),
    })) return;
    setNotice('');
    try {
      const result = await apiFetch<{ removed: number }>(`/connectors/slack/${encodeURIComponent(row.id)}/items`, {
        method: 'DELETE',
        fallbackError: t('Couldn’t reverse the import.'),
        noStore: true,
      });
      replaceRow({ ...row, state: 'queued', messages: 0, cursor: null, error: null });
      setNotice(t('Removed {removed}.', { removed: result.removed }));
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t reverse the import.'));
    }
  }

  if (notConfigured) {
    return <Note>{t('The Slack import isn’t configured on this deployment — SLACK_USER_TOKEN is needed.')}</Note>;
  }

  const rows = page?.rows ?? [];
  const visible = rows.filter((row) => {
    if (filter === 'unmapped') return row.state === 'unmapped';
    if (filter === 'mapped') return row.mapping?.subject_kind != null;
    if (filter === 'skipped') return row.state === 'skipped';
    return true;
  });
  const mappedCount = rows.filter((row) => row.mapping?.subject_kind).length;

  return (
    <section className="grid grid-cols-[minmax(0,1fr)] gap-3">
      <div className={LEDGER.toolbar}>
        <SegmentedFilter
          label={t('Show')}
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: t('All') },
            { value: 'unmapped', label: t('Not mapped') },
            { value: 'mapped', label: t('Mapped') },
            { value: 'skipped', label: t('Skipped') },
          ]}
        />
        <div className={LEDGER.actions}>
          {loading
            ? <PlaceholderBar className="h-3 w-44 rounded-full" />
            : <Note as="span">{t('{channels} channels · {mapped} mapped', { channels: rows.length, mapped: mappedCount })}{page?.team ? ` · ${page.team}` : ''}</Note>}
          {page && !page.enabled && <Note as="span">{t('Sync off')}</Note>}
        </div>
      </div>

      {error && <ErrorNotice message={error} action={<Button type="button" variant="secondary" onClick={() => void load().then(setPage).catch(() => {})}>{t('Retry')}</Button>} />}
      {notice && <Note role="status">{notice}</Note>}

      {loading && <PlaceholderRows count={5} label={t('Reading Slack…')} />}
      {!loading && visible.length === 0 && (
        <Note>
          {rows.length === 0 ? t('The token sees no channels.') : filter === 'unmapped' ? t('Every channel has a decision.') : filter === 'mapped' ? t('Nothing is mapped yet.') : t('Nothing is skipped.')}
        </Note>
      )}

      {visible.length > 0 && (
        <TableFrame>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{t('Channel')}</TableHead>
                <TableHead scope="col">{t('Created')}</TableHead>
                <TableHead scope="col">{t('Subject')}</TableHead>
                <TableHead scope="col">{t('Sync')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((row) => (
                <ChannelRow
                  key={row.id}
                  row={row}
                  enabled={page?.enabled ?? false}
                  onMap={(subject, title) => void save(row, { subject_kind: subject.kind as Exclude<SlackSubjectKind, 'team'>, subject_id: subject.subject_id, subject_title: title })}
                  onTeam={() => void save(row, { subject_kind: 'team', subject_id: null })}
                  onSkip={() => void save(row, { subject_kind: null, subject_id: null })}
                  onSync={() => void syncNow(row)}
                  onReverse={() => void reverse(row)}
                />
              ))}
            </TableBody>
          </Table>
        </TableFrame>
      )}
    </section>
  );
}

function when(at: number | null): string {
  if (!at) return t('never');
  const date = new Date(at);
  return `${date.toLocaleDateString(dateLocale, { month: 'short', day: 'numeric' })} ${formatTime(date)}`;
}

function whenDay(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString(dateLocale, { year: 'numeric', month: 'short', day: 'numeric' });
}

const STATE_LABEL: Record<SlackConnectorRow['state'], string> = {
  unmapped: t('Not mapped'),
  skipped: t('Skipped'),
  queued: t('Queued'),
  importing: t('Importing…'),
  synced: t('Synced'),
  failed: t('Failed'),
};

function ChannelRow({ row, enabled, onMap, onTeam, onSkip, onSync, onReverse }: {
  row: SlackConnectorRow;
  enabled: boolean;
  onMap: (subject: DocsSubject, title: string) => void;
  onTeam: () => void;
  onSkip: () => void;
  onSync: () => void;
  onReverse: () => void;
}) {
  const [picking, setPicking] = useState(false);
  const mapped = row.mapping?.subject_kind != null;
  const label = row.mapping?.subject_kind === 'team'
    ? t('Team')
    : row.mapping?.subject_kind
      ? `${row.mapping.subject_kind === 'project' ? t('Project') : row.mapping.subject_kind === 'organization' ? t('Partner') : t('Lead')} · ${row.mapping.subject_title ?? row.mapping.subject_id}`
      : row.state === 'skipped' ? t('Skipped') : t('Map…');

  function onPick(subject: DocsSubject, crm: CrmSubject) {
    setPicking(false);
    onMap(subject, crm.title);
  }

  return (
    <TableRow>
      <TableCell>
        <strong className={LEDGER.title}>#{row.name}</strong>
        {row.private && <> <Note as="span">{t('private')}</Note></>}
        {row.shared && <> <Note as="span">{t('shared')}</Note></>}
        {row.archived && <> <Note as="span">{t('archived')}</Note></>}
        {row.purpose && <small className="text-muted-foreground"> {row.purpose}</small>}
      </TableCell>
      <TableCell>{whenDay(row.created)}{row.members ? ` · ${t('{members} members', { members: row.members })}` : ''}</TableCell>
      <TableCell className={LEDGER.state}>
        <span className={LEDGER.controls}>
          <Button type="button" variant="secondary" size="sm" onClick={() => setPicking(true)}>{label}</Button>
          {!mapped && row.state !== 'skipped' && (
            <>
              <Button type="button" variant="secondary" size="sm" onClick={onTeam}>{t('Team')}</Button>
              <Button type="button" variant="secondary" size="sm" onClick={onSkip}>{t('Skip')}</Button>
            </>
          )}
          {picking && <span className="absolute inset-y-0 right-0"><SubjectPicker kinds={SLACK_SUBJECT_KINDS} onPick={onPick} onClose={() => setPicking(false)} /></span>}
        </span>
      </TableCell>
      <TableCell className={LEDGER.state}>
        {mapped ? (
          <>
            <span className={row.state === 'failed' ? 'text-[13px] text-muted-foreground' : undefined} title={row.error ?? undefined}>
              {STATE_LABEL[row.state]}{row.messages ? ` · ${t('{messages} messages', { messages: row.messages })}` : ''}
              {row.last_synced_at ? ` · ${when(row.last_synced_at)}` : ''}
            </span>
            {enabled && row.state !== 'importing' && (
              <> <Button type="button" variant="secondary" size="sm" onClick={onSync}>{t('Sync now')}</Button></>
            )}
            {row.messages > 0 && (
              <> <Button type="button" variant="secondary" size="sm" onClick={onReverse}>{t('Reverse')}</Button></>
            )}
          </>
        ) : <span className="text-muted-foreground">{STATE_LABEL[row.state]}</span>}
      </TableCell>
    </TableRow>
  );
}
