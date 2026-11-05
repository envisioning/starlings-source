import { useCallback, useEffect, useState } from 'react';
import { WORK_ACTIVITY_ACTIONS, type WorkActivityItem, type WorkActivityResponse } from '@starlings/contracts/work-activity';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { PlaceholderRows } from '@/ui/placeholder-rows';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table';
import { AdminHeader } from './AdminNav';
import { apiFetch } from './api';
import { ControlRequestError } from './config';
import { useDocumentTitle } from './document-title';
import { ErrorNotice } from './ErrorNotice';
import { dateLocale, t } from './i18n';
import { formatTime } from './meeting-time';
import { useOwnerSession } from './owner-session';
import { LEDGER, Note, PAGE, SectionCard, TableFrame } from './SectionCard';
import { SignInGate } from './SignInGate';
import { AppShell, MemberLoadingShell } from './SiteChrome';

/**
 * Admin › Activity: every work-model write the Worker sent to
 * D1, newest first, with the filters Core's activity feed has. Admins only.
 */
export function AdminActivityPage() {
  const session = useOwnerSession();
  useDocumentTitle(t('Activity'), t('Admin'));
  if (session.kind === 'loading') return <MemberLoadingShell />;
  if (session.kind === 'visitor') return <SignInGate title={t('Admin')} />;
  return (
    <AppShell variant="wide" member="home" memberNavCurrent={null}>
      <div className={PAGE}>
        <AdminHeader section="activity" />
        <ActivityFeed />
      </div>
    </AppShell>
  );
}

interface Filters {
  q: string;
  table: string;
  action: string;
  actor: string;
  from: string;
  to: string;
}

const NO_FILTERS: Filters = { q: '', table: '', action: '', actor: '', from: '', to: '' };

const ACTION_LABELS: Record<WorkActivityItem['action'], string> = {
  insert: t('Added'),
  update: t('Changed'),
  delete: t('Deleted'),
};

function queryOf(filters: Filters, cursor: number | null): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value.trim()) params.set(key, value.trim());
  if (cursor) params.set('cursor', String(cursor));
  const query = params.toString();
  return query ? `?${query}` : '';
}

function when(iso: string): string {
  const date = new Date(iso);
  return `${date.toLocaleDateString(dateLocale, { day: 'numeric', month: 'short', year: 'numeric' })} ${formatTime(date)}`;
}

function ActivityFeed() {
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [applied, setApplied] = useState<Filters>(NO_FILTERS);
  const [page, setPage] = useState<WorkActivityResponse | null>(null);
  const [items, setItems] = useState<WorkActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async (next: Filters, cursor: number | null) => {
    setLoading(true);
    setError('');
    try {
      const body = await apiFetch<WorkActivityResponse>(`/admin/activity${queryOf(next, cursor)}`, {
        fallbackError: t('Couldn’t load the activity.'),
        noStore: true,
      });
      setPage(body);
      setItems((current) => (cursor ? [...current, ...body.items] : body.items));
    } catch (cause) {
      if (cause instanceof ControlRequestError && cause.status === 403) setForbidden(true);
      else setError(cause instanceof Error ? cause.message : t('Couldn’t load the activity.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(NO_FILTERS, null); }, [load]);

  if (forbidden) return <Note>{t('Only an admin sees the activity.')}</Note>;

  const set = (key: keyof Filters) => (value: string) => setFilters((current) => ({ ...current, [key]: value }));
  const apply = () => { setApplied(filters); void load(filters, null); };
  const clear = () => { setFilters(NO_FILTERS); setApplied(NO_FILTERS); void load(NO_FILTERS, null); };
  const filtered = Object.values(applied).some((value) => value.trim() !== '');

  return (
    <SectionCard id="admin-activity" title={t('Activity')}>
      <form
        className={LEDGER.toolbar}
        onSubmit={(event) => { event.preventDefault(); apply(); }}
      >
        <div className={LEDGER.actions}>
          <Input className="w-56" type="search" value={filters.q} placeholder={t('Search')} aria-label={t('Search')} onChange={(event) => set('q')(event.target.value)} />
          <NativeSelect value={filters.table} aria-label={t('Table')} onChange={(event) => set('table')(event.target.value)}>
            <NativeSelectOption value="">{t('Every table')}</NativeSelectOption>
            {(page?.tables ?? []).map((table) => <NativeSelectOption key={table} value={table}>{table}</NativeSelectOption>)}
          </NativeSelect>
          <NativeSelect value={filters.action} aria-label={t('Action')} onChange={(event) => set('action')(event.target.value)}>
            <NativeSelectOption value="">{t('Every action')}</NativeSelectOption>
            {WORK_ACTIVITY_ACTIONS.map((action) => <NativeSelectOption key={action} value={action}>{ACTION_LABELS[action]}</NativeSelectOption>)}
          </NativeSelect>
          <NativeSelect value={filters.actor} aria-label={t('Who')} onChange={(event) => set('actor')(event.target.value)}>
            <NativeSelectOption value="">{t('Everyone')}</NativeSelectOption>
            {(page?.actors ?? []).map((actor) => <NativeSelectOption key={actor} value={actor}>{actor}</NativeSelectOption>)}
          </NativeSelect>
          <Input className="w-40" type="date" value={filters.from} aria-label={t('From')} onChange={(event) => set('from')(event.target.value)} />
          <Input className="w-40" type="date" value={filters.to} aria-label={t('To')} onChange={(event) => set('to')(event.target.value)} />
        </div>
        <div className={LEDGER.actions}>
          <Button type="submit" variant="secondary" disabled={loading}>{t('Filter')}</Button>
          {filtered && <Button type="button" variant="ghost" onClick={clear}>{t('Clear')}</Button>}
        </div>
      </form>
      {error && <ErrorNotice message={error} action={<Button type="button" size="sm" variant="secondary" onClick={() => void load(applied, null)}>{t('Retry')}</Button>} />}
      {loading && items.length === 0 ? (
        <PlaceholderRows count={6} label={t('Opening…')} />
      ) : items.length === 0 ? (
        <Note>{filtered ? t('Nothing matches these filters.') : t('No changes yet.')}</Note>
      ) : (
        <TableFrame>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{t('When')}</TableHead>
                <TableHead scope="col">{t('Who')}</TableHead>
                <TableHead scope="col">{t('Action')}</TableHead>
                <TableHead scope="col">{t('Record')}</TableHead>
                <TableHead scope="col">{t('Fields')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{when(item.at)}</TableCell>
                  <TableCell className={LEDGER.who}>{item.actor ?? '—'}</TableCell>
                  <TableCell><Badge variant={item.action === 'delete' ? 'outline' : 'secondary'}>{ACTION_LABELS[item.action]}</Badge></TableCell>
                  <TableCell>
                    <span className={LEDGER.title}>{item.label ?? item.row_id}</span>
                    <span className="block text-[12px] text-muted-foreground">{item.table}</span>
                  </TableCell>
                  <TableCell className="text-[13px] text-muted-foreground">{item.changed_fields.join(', ') || '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableFrame>
      )}
      {page?.next_cursor && (
        <div>
          <Button type="button" variant="secondary" disabled={loading} onClick={() => void load(applied, page.next_cursor)}>{t('Show more')}</Button>
        </div>
      )}
    </SectionCard>
  );
}
