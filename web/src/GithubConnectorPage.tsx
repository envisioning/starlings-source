import { SignInGate } from './SignInGate';
import { useCallback, useEffect, useState } from 'react';
import { confirmDataLoss } from './ConfirmDataLoss';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table';
import { Button } from '@/ui/button';
import { SegmentedFilter } from './SegmentedFilter';
import type { DocsSubject, GithubConnectorResponse, GithubConnectorRow, GithubMappingResponse } from '@starlings/contracts';
import { apiFetch } from './api';
import { apiBase } from './config';
import type { CrmSubject } from './crm-work';
import { ErrorNotice } from './ErrorNotice';
import { LEDGER, Note, PAGE, TableFrame } from './SectionCard';
import { SubjectPicker } from './SubjectPicker';
import { AppShell, MemberLoadingShell } from './SiteChrome';
import { ConnectorHeader } from './AdminNav';
import { useDocumentTitle } from './document-title';
import { useOwnerSession } from './owner-session';
import { t, dateLocale } from './i18n';
import { formatTime } from './meeting-time';
import { PlaceholderBar, PlaceholderRows } from '@/ui/placeholder-rows';

/**
 * Connectors → GitHub: Connect GitHub until the workspace has an
 * installation of the Starlings App, then every repository the App can see, and for each one the decision — which project or lead it belongs to,
 * or skip — beside how far the sync has read it. The list is the mapping and
 * the ledger at once, as the Granola page is. Nothing is mapped for anybody.
 */
export function GithubConnectorPage() {
  const session = useOwnerSession();
  useDocumentTitle(t('GitHub'));

  if (session.kind === 'loading') return <MemberLoadingShell />;
  if (session.kind === 'visitor') {
    return (
      <SignInGate title={t('GitHub')} />
    );
  }

  return (
    <AppShell variant="wide" member="home" memberNavCurrent={null}>
      <div className={PAGE}>
        <ConnectorHeader name={t('GitHub')} lede={t('Every repository the App can see. Map each one to a project or a lead, and its pull requests land on that subject.')} />
        <RepositoryList />
      </div>
    </AppShell>
  );
}

type Filter = 'all' | 'unmapped' | 'mapped' | 'skipped';

/** While a repository is importing, the list asks again this often. */
const SYNC_POLL_MS = 5_000;

function RepositoryList() {
  const [page, setPage] = useState<GithubConnectorResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notConfigured, setNotConfigured] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    const body = await apiFetch<GithubConnectorResponse>('/connectors/github', {
      fallbackError: t('Couldn’t read GitHub.'),
      noStore: true,
    });
    return body;
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void load().then((body) => {
      if (cancelled) return;
      setPage(body);
      setError('');
    }).catch((cause: unknown) => {
      if (cancelled) return;
      const message = cause instanceof Error ? cause.message : t('Couldn’t read GitHub.');
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

  function replaceRow(row: GithubConnectorRow) {
    setPage((current) => current ? { ...current, rows: current.rows.map((item) => (item.id === row.id ? row : item)) } : current);
  }

  async function save(row: GithubConnectorRow, body: { subject_kind: 'project' | 'lead' | null; subject_id: string | null; subject_title?: string | null }) {
    setNotice('');
    try {
      const result = await apiFetch<GithubMappingResponse>(`/connectors/github/${encodeURIComponent(row.owner)}/${encodeURIComponent(row.repo)}`, {
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

  async function syncNow(row: GithubConnectorRow) {
    setNotice('');
    try {
      await apiFetch<{ queued: number }>(`/connectors/github/${encodeURIComponent(row.owner)}/${encodeURIComponent(row.repo)}/sync`, {
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

  async function reverse(row: GithubConnectorRow) {
    if (!await confirmDataLoss({
      title: t('Remove every pull request Starlings read from {repo}?', { repo: row.id }),
      body: t('The mapping stays. This can’t be undone.'),
      action: t('Remove'),
    })) return;
    setNotice('');
    try {
      const result = await apiFetch<{ removed: number }>(`/connectors/github/${encodeURIComponent(row.owner)}/${encodeURIComponent(row.repo)}/items`, {
        method: 'DELETE',
        fallbackError: t('Couldn’t reverse the import.'),
        noStore: true,
      });
      replaceRow({ ...row, state: 'queued', pulls: 0, cursor: null, error: null });
      setNotice(t('Removed {removed}.', { removed: result.removed }));
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t reverse the import.'));
    }
  }

  async function disconnect() {
    setNotice('');
    try {
      await apiFetch<{ removed: number }>('/connectors/github/disconnect', {
        method: 'POST',
        fallbackError: t('Couldn’t disconnect GitHub.'),
        noStore: true,
      });
      setPage(await load());
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t disconnect GitHub.'));
    }
  }

  if (notConfigured) {
    return <Note>{t('GitHub isn’t available on this workspace.')}</Note>;
  }

  if (page && !page.connected) {
    return (
      <section className="grid grid-cols-[minmax(0,1fr)] gap-3">
        {error && <ErrorNotice message={error} />}
        <div>
          <Button asChild>
            <a href={`${apiBase}/connectors/github/connect/start`}>{t('Connect GitHub')}</a>
          </Button>
        </div>
      </section>
    );
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
            : <Note as="span">{t('{repos} repositories · {mapped} mapped', { repos: rows.length, mapped: mappedCount })}</Note>}
          {page && !page.enabled && <Note as="span">{t('Sync off')}</Note>}
          {page?.account && <Note as="span">{page.account}</Note>}
          {page?.connected && <Button type="button" variant="secondary" onClick={() => void disconnect()}>{t('Disconnect')}</Button>}
        </div>
      </div>

      {error && <ErrorNotice message={error} action={<Button type="button" variant="secondary" onClick={() => void load().then(setPage).catch(() => {})}>{t('Retry')}</Button>} />}
      {notice && <Note role="status">{notice}</Note>}

      {loading && <PlaceholderRows count={5} label={t('Reading GitHub…')} />}
      {!loading && visible.length === 0 && (
        <Note>
          {rows.length === 0 ? t('The App sees no repositories.') : filter === 'unmapped' ? t('Every repository has a decision.') : filter === 'mapped' ? t('Nothing is mapped yet.') : t('Nothing is skipped.')}
        </Note>
      )}

      {visible.length > 0 && (
        <TableFrame>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{t('Repository')}</TableHead>
                <TableHead scope="col">{t('Last push')}</TableHead>
                <TableHead scope="col">{t('Subject')}</TableHead>
                <TableHead scope="col">{t('Sync')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((row) => (
                <RepositoryRow
                  key={row.id}
                  row={row}
                  enabled={page?.enabled ?? false}
                  onMap={(subject, title) => void save(row, { subject_kind: subject.kind as 'project' | 'lead', subject_id: subject.subject_id, subject_title: title })}
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

function when(at: number | string | null): string {
  if (!at) return t('never');
  const date = new Date(at);
  return `${date.toLocaleDateString(dateLocale, { month: 'short', day: 'numeric' })} ${formatTime(date)}`;
}

const STATE_LABEL: Record<GithubConnectorRow['state'], string> = {
  unmapped: t('Not mapped'),
  skipped: t('Skipped'),
  queued: t('Queued'),
  importing: t('Importing…'),
  synced: t('Synced'),
  failed: t('Failed'),
};

function RepositoryRow({ row, enabled, onMap, onSkip, onSync, onReverse }: {
  row: GithubConnectorRow;
  enabled: boolean;
  onMap: (subject: DocsSubject, title: string) => void;
  onSkip: () => void;
  onSync: () => void;
  onReverse: () => void;
}) {
  const [picking, setPicking] = useState(false);
  const mapped = row.mapping?.subject_kind != null;
  const label = row.mapping?.subject_kind
    ? `${row.mapping.subject_kind === 'project' ? t('Project') : t('Lead')} · ${row.mapping.subject_title ?? row.mapping.subject_id}`
    : row.state === 'skipped' ? t('Skipped') : t('Map…');

  function onPick(subject: DocsSubject, crm: CrmSubject) {
    setPicking(false);
    onMap(subject, crm.title);
  }

  return (
    <TableRow>
      <TableCell>
        <strong className={LEDGER.title}>{row.id}</strong>
        {row.archived && <> <Note as="span">{t('archived')}</Note></>}
        {row.description && <small className="text-muted-foreground"> {row.description}</small>}
      </TableCell>
      <TableCell>{row.pushed_at ? <time dateTime={row.pushed_at}>{when(row.pushed_at)}</time> : t('never')}</TableCell>
      <TableCell className={LEDGER.state}>
        <span className={LEDGER.controls}>
          <Button type="button" variant="secondary" size="sm" onClick={() => setPicking(true)}>{label}</Button>
          {!mapped && row.state !== 'skipped' && (
            <Button type="button" variant="secondary" size="sm" onClick={onSkip}>{t('Skip')}</Button>
          )}
          {picking && <span className="absolute inset-y-0 right-0"><SubjectPicker onPick={onPick} onClose={() => setPicking(false)} /></span>}
        </span>
      </TableCell>
      <TableCell className={LEDGER.state}>
        {mapped ? (
          <>
            <span className={row.state === 'failed' ? 'text-[13px] text-muted-foreground' : undefined} title={row.error ?? undefined}>
              {STATE_LABEL[row.state]}{row.pulls ? ` · ${t('{pulls} pulls', { pulls: row.pulls })}` : ''}
              {row.last_synced_at ? ` · ${when(row.last_synced_at)}` : ''}
            </span>
            {enabled && row.state !== 'importing' && (
              <> <Button type="button" variant="secondary" size="sm" onClick={onSync}>{t('Sync now')}</Button></>
            )}
            {row.pulls > 0 && (
              <> <Button type="button" variant="secondary" size="sm" onClick={onReverse}>{t('Reverse')}</Button></>
            )}
          </>
        ) : <span className="text-muted-foreground">{STATE_LABEL[row.state]}</span>}
      </TableCell>
    </TableRow>
  );
}
