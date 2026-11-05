import { useEffect, useState, type ReactNode } from 'react';
import { Card } from '@/ui/card';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import type { AmbientMeetingsResponse, ConnectorStatus, ConnectorsResponse } from '@starlings/contracts';
import { apiFetch } from './api';
import { ErrorNotice } from './ErrorNotice';
import { Note, SectionCard } from './SectionCard';
import { useOwnerSession } from './owner-session';
import { t, dateLocale } from './i18n';
import { formatTime } from './meeting-time';
import { Spinner } from '@/ui/spinner';
import { PlaceholderBar } from '@/ui/placeholder-rows';

/**
 * Connectors — every outside source that writes meetings into Meet, one card
 * each, the same shape for all of them. Granola (docs/GRANOLA_BRIDGE.md) is
 * the one with a bridge today; the Mac recorder is the other source of
 * meetings and gets a card so the page is the whole inventory. The next
 * connector adds a card, not a page.
 */
/**
 * The cards, drawn inside Admin's Connectors section (`AdminPage`, docs/ADMIN.md
 * §10) under the Configured table. Each card reads its own status so a slow
 * source never holds the others.
 */
export function ConnectorsGrid() {
  const session = useOwnerSession();
  return (
    <SectionCard id="admin-connectors" title={t('Connectors')}>
      <Note>{t('Where meetings come from, and where each source stands.')}</Note>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
        <GranolaCard />
        <GithubCard />
        <SlackCard />
        <BeeperCard />
        {session.kind === 'owner' && session.room && <MacRecorderCard roomSlug={session.room.slug} />}
      </div>
    </SectionCard>
  );
}

/**
 * One source's card: its name and state on one line, its error, then the
 * facts and actions the caller passes. `on` inks the state in the accent.
 */
function ConnectorCard({ id, name, state, on, error, children }: {
  id: string;
  name: string;
  state: ReactNode;
  on: boolean;
  error: string;
  children: ReactNode;
}) {
  return (
    <Card role="region" aria-labelledby={`connector-${id}`} className="gap-3.5 px-[18px] py-4 shadow-none">
      <div className="flex items-baseline justify-between gap-3">
        <h3 id={`connector-${id}`} className="m-0 text-[17px] font-semibold">{name}</h3>
        <span className={cn('text-xs text-muted-foreground', on && 'text-primary')}>{state}</span>
      </div>
      {error && <ErrorNotice message={error} />}
      {children}
    </Card>
  );
}

/** The facts under a source's name: a label over a figure, two columns. */
function Facts({ rows }: { rows: Array<[label: string, value: ReactNode]> }) {
  return (
    <dl className="m-0 grid grid-cols-2 gap-x-3 gap-y-2.5">
      {rows.map(([label, value]) => (
        <div key={label} className="flex flex-col gap-0.5">
          <dt className="text-xs font-medium tracking-[0.04em] text-muted-foreground uppercase">{label}</dt>
          <dd className="m-0 text-[15px] font-semibold">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

const ACTIONS = 'flex flex-wrap gap-2';

function when(at: number | null): string {
  if (!at) return t('never');
  const date = new Date(at);
  return `${date.toLocaleDateString(dateLocale, { month: 'short', day: 'numeric' })} ${formatTime(date)}`;
}

function useGranolaConnector(refreshKey = '') {
  const [status, setStatus] = useState<ConnectorStatus | null>();
  const [error, setError] = useState('');

  // Once on open, then every few seconds — a history import takes half an
  // hour and is usually watched from a tab that did not start it, so the
  // count has to move for whoever is looking, not only for whoever pressed.
  useEffect(() => {
    let cancelled = false;
    const read = () => {
      void apiFetch<ConnectorsResponse>('/connectors', { fallbackError: t('Couldn’t read the connectors.'), noStore: true })
        .then((body) => {
          if (!cancelled) {
            setStatus(body.connectors.find((row) => row.id === 'granola') ?? null);
            setError('');
          }
        })
        .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : t('Couldn’t read the connectors.')); });
    };
    read();
    const handle = window.setInterval(read, 20_000);
    return () => { cancelled = true; window.clearInterval(handle); };
  }, [refreshKey]);

  return { status, error, setError };
}

/** The operations note follows the same connector inventory as its card. */
export function GranolaConnectorNote() {
  const { status } = useGranolaConnector();
  return status ? <Note>{t('Meetings Granola captured, with import and filing, are on')} <a href="/admin/connectors/granola">{t('Connectors')}</a>.</Note> : null;
}

function GranolaCard() {
  const [backfill, setBackfill] = useState<'idle' | 'busy' | 'done'>('idle');
  const { status, error, setError } = useGranolaConnector(backfill);

  async function importHistory() {
    setBackfill('busy');
    try {
      await apiFetch<{ from: string }>('/granola/backfill', {
        method: 'POST',
        body: { months: 36 },
        fallbackError: t('Couldn’t start the import.'),
        noStore: true,
      });
      setBackfill('done');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t start the import.'));
      setBackfill('idle');
    }
  }

  if (status === null) return null;
  return (
    <ConnectorCard
      id="granola"
      name={t('Granola')}
      on={Boolean(status?.configured)}
      error={error}
      state={status === undefined ? (error ? t('Unavailable') : <PlaceholderBar label={t('Reading…')} className="h-3 w-20 rounded-full" />) : status.configured ? t('Connected') : t('Not configured')}
    >
      {status && (
        <>
          <Facts rows={[
            [t('In Work'), status.imported],
            [t('To file'), status.unfiled],
            [t('Suggested'), status.suggesting ? status.suggested : t('off')],
            [t('Confirmed · corrected'), <>{status.accepted} · {status.corrected}</>],
            [t('Last webhook'), when(status.last_webhook_at)],
            [t('Last import'), when(status.last_import_at)],
          ]} />
          <div className={ACTIONS}>
            <Button asChild><a href="/admin/connectors/granola">{t('Open')}</a></Button>
            {status.configured && (
              <Button
                type="button"
                variant="secondary"
                disabled={backfill !== 'idle' || Boolean(status.run)}
                onClick={() => void importHistory()}
             >
                {backfill === 'busy' && <Spinner aria-hidden />}
                {backfill === 'busy'
                  ? t('Starting…')
                  : status.run
                    ? t('Importing {done} of {total}', { done: status.run.done, total: status.run.total })
                    : t('Import everything')}
              </Button>
            )}
          </div>
        </>
      )}
    </ConnectorCard>
  );
}

/**
 * GitHub: repositories mapped to subjects, pulls read by an hourly
 * pass. The stale case is the one fact this card exists for: the sync found
 * news and Core's webhook edge did not report any.
 */
function GithubCard() {
  const [status, setStatus] = useState<ConnectorStatus | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    void apiFetch<ConnectorsResponse>('/connectors', { fallbackError: t('Couldn’t read the connectors.'), noStore: true })
      .then((body) => { if (!cancelled) setStatus(body.connectors.find((row) => row.id === 'github') ?? null); })
      .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : t('Couldn’t read the connectors.')); });
    return () => { cancelled = true; };
  }, []);

  return (
    <ConnectorCard
      id="github"
      name={t('GitHub')}
      on={Boolean(status?.configured && status.enabled)}
      error={error}
      state={status === null ? (error ? t('Unavailable') : <PlaceholderBar label={t('Reading…')} className="h-3 w-20 rounded-full" />) : !status.configured ? t('Not configured') : status.stale ? t('Webhook stale') : status.enabled ? t('Syncing') : t('Sync off')}
    >
      {status && (
        <>
          <Facts rows={[
            [t('Pull requests'), status.imported],
            [t('Backfilling'), status.unfiled],
            [t('Last webhook'), when(status.last_webhook_at)],
            [t('Last sync'), when(status.last_sync_at ?? null)],
            [t('Last mapping'), when(status.last_import_at)],
          ]} />
          <div className={ACTIONS}>
            <Button asChild><a href="/admin/connectors/github">{t('Open')}</a></Button>
          </div>
        </>
      )}
    </ConnectorCard>
  );
}

/**
 * Slack (docs/SLACK_IMPORT.md): channel history into subject
 * channels, mapped on its own page, synced hourly.
 */
function SlackCard() {
  const [status, setStatus] = useState<ConnectorStatus | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    void apiFetch<ConnectorsResponse>('/connectors', { fallbackError: t('Couldn’t read the connectors.'), noStore: true })
      .then((body) => { if (!cancelled) setStatus(body.connectors.find((row) => row.id === 'slack') ?? null); })
      .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : t('Couldn’t read the connectors.')); });
    return () => { cancelled = true; };
  }, []);

  return (
    <ConnectorCard
      id="slack"
      name={t('Slack')}
      on={Boolean(status?.configured && status.enabled)}
      error={error}
      state={status === null ? (error ? t('Unavailable') : <PlaceholderBar label={t('Reading…')} className="h-3 w-20 rounded-full" />) : !status.configured ? t('Not configured') : status.enabled ? t('Syncing') : t('Sync off')}
    >
      {status && (
        <>
          <Facts rows={[
            [t('Messages'), status.imported],
            [t('Backfilling'), status.unfiled],
            [t('Last sync'), when(status.last_sync_at ?? null)],
            [t('Last mapping'), when(status.last_import_at)],
          ]} />
          <div className={ACTIONS}>
            <Button asChild><a href="/admin/connectors/slack">{t('Open')}</a></Button>
          </div>
        </>
      )}
    </ConnectorCard>
  );
}

/**
 * Beeper: WhatsApp, LinkedIn, Telegram and Signal
 * threads as interactions on every subject the contact is linked to.
 *
 * The Mac is the reader — Beeper Desktop's API is loopback-only — so this
 * card watches for what that reader reports rather than offering a backfill
 * button of its own. It is a running connector, not a one-shot import, and
 * reads "Not configured" until the owner turns it on in the Mac app.
 */
function BeeperCard() {
  const [status, setStatus] = useState<ConnectorStatus | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    void apiFetch<ConnectorsResponse>('/connectors', { fallbackError: t('Couldn’t read the connectors.'), noStore: true })
      .then((body) => { if (!cancelled) setStatus(body.connectors.find((row) => row.id === 'beeper') ?? null); })
      .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : t('Couldn’t read the connectors.')); });
    return () => { cancelled = true; };
  }, []);

  return (
    <ConnectorCard
      id="beeper"
      name={t('Beeper')}
      on={Boolean(status?.configured && status.enabled)}
      error={error}
      state={status === null ? (error ? t('Unavailable') : <PlaceholderBar label={t('Reading…')} className="h-3 w-20 rounded-full" />) : !status.configured ? t('Not configured') : status.enabled ? t('Syncing') : t('Sync off')}
    >
      {status && (
        <>
          <Facts rows={[
            [t('Chats'), status.imported],
            [t('Last sync'), when(status.last_sync_at ?? null)],
            [t('Last import'), when(status.last_import_at)],
          ]} />
          {!status.configured && (
            <Note>
              {t('Turn Beeper on in the Mac app, under Settings → Connectors.')}
            </Note>
          )}
        </>
      )}
    </ConnectorCard>
  );
}

function MacRecorderCard({ roomSlug }: { roomSlug: string }) {
  const [count, setCount] = useState<{ recorded: number; unfiled: number } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    void apiFetch<AmbientMeetingsResponse>(`/rooms/${encodeURIComponent(roomSlug)}/meetings?capture=ambient`, {
      fallbackError: t('Couldn’t read the recordings.'),
      noStore: true,
    }).then((body) => {
      if (cancelled) return;
      setCount({ recorded: body.meetings.length, unfiled: body.meetings.filter((row) => row.meeting_kind === 'uncategorized').length });
    }).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : t('Couldn’t read the recordings.'));
    });
    return () => { cancelled = true; };
  }, [roomSlug]);

  return (
    <ConnectorCard
      id="mac"
      name={t('Mac recorder')}
      on
      error={error}
      state={t('On this Mac')}
    >
      {count && (
        <Facts rows={[
          [t('Recorded'), count.recorded],
          [t('To file'), count.unfiled],
        ]} />
      )}
      <div className={ACTIONS}>
        <Button asChild><a href="/meetings">{t('Open')}</a></Button>
      </div>
    </ConnectorCard>
  );
}
