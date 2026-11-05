import { SignInGate } from './SignInGate';
import { useEffect, useMemo, useState } from 'react';
import { Checkbox } from '@/ui/checkbox';
import { Label } from '@/ui/label';
import { Button } from '@/ui/button';
import { mcpRedirectDestination } from '@starlings/contracts/mcp';
import { apiFetch } from './api';
import { AppShell } from './SiteChrome';
import { GuestCard } from './GuestCard';
import { ErrorNotice } from './ErrorNotice';
import { useOwnerSession } from './owner-session';
import { useDocumentTitle } from './document-title';
import { t } from './i18n';
import { LoadingIndicator } from '@/ui/spinner';

/**
 * `/connect` — the OAuth consent page for the MCP door (docs/MCP.md decision
 * 12). `/oauth/authorize` sends the browser here with the client's query
 * intact; the page shows the client's own name, where its code goes, and
 * the scope it asked for, and one Allow. The name is the client's claim; the
 * destination is the fact, so both are drawn. The POST goes back to the Worker with the session cookie,
 * which checks the query again — this page is a relay, never an authority.
 */

type ClientPreview = {
  client_id: string;
  client_name: string;
  client_uri: string | null;
  scopes: Array<'read' | 'write'>;
};

const AUTHORIZE_KEYS = ['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource'] as const;

export function ConnectPage() {
  const session = useOwnerSession();
  useDocumentTitle(t('Connect'));
  const query = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    const body: Record<string, string> = {};
    for (const key of AUTHORIZE_KEYS) {
      const value = params.get(key);
      if (value !== null) body[key] = value;
    }
    return body;
  }, []);

  if (!query.client_id) {
    return (
      <AppShell variant="centered">
        <GuestCard>
          <h1>{t('Connect Claude to Starlings')}</h1>
          <p className="lede">{t('Claude opens this page when it pairs with Starlings.')}</p>
          <a href="/help/howto/connect-claude">{t('How to connect Claude')}</a>
        </GuestCard>
      </AppShell>
    );
  }

  if (session.kind === 'loading') return <LoadingIndicator placement="full-page" />;
  if (session.kind === 'visitor') {
    return (
      <SignInGate title={t('Sign in')} />
    );
  }

  return <Consent query={query} ownerEmail={session.owner.email} />;
}

function Consent({ query, ownerEmail }: { query: Record<string, string>; ownerEmail: string }) {
  const [client, setClient] = useState<ClientPreview | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  // Writes are the person's choice at pairing, never the client's ask
  // (docs/MCP.md decision 8). Off by default.
  const [writes, setWrites] = useState(false);
  const destination = query.redirect_uri ? mcpRedirectDestination(query.redirect_uri) : null;

  useEffect(() => {
    if (!query.client_id) {
      setError(t('This link is incomplete.'));
      return;
    }
    const scope = query.scope ? `&scope=${encodeURIComponent(query.scope)}` : '';
    void apiFetch<ClientPreview>(`/mcp/client?client_id=${encodeURIComponent(query.client_id)}${scope}`, {
      fallbackError: t('Couldn’t load the client.'),
    }).then(setClient).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : t('Couldn’t load the client.')));
  }, [query]);

  async function allow() {
    setBusy(true);
    setError(undefined);
    try {
      const answer = await apiFetch<{ redirect: string }>('/mcp/authorize', {
        method: 'POST',
        body: { ...query, scope: writes ? 'read write' : 'read' },
        fallbackError: t('Couldn’t connect.'),
      });
      window.location.assign(answer.redirect);
    } catch (cause) {
      setBusy(false);
      setError(cause instanceof Error ? cause.message : t('Couldn’t connect.'));
    }
  }

  function deny() {
    try {
      const back = new URL(query.redirect_uri ?? '');
      back.searchParams.set('error', 'access_denied');
      if (query.state) back.searchParams.set('state', query.state);
      window.location.assign(back.toString());
    } catch {
      window.location.assign('/');
    }
  }

  return (
    <AppShell variant="centered">
      <GuestCard>
        <h1>{client?.client_name ?? '…'}</h1>
        {client ? <p className="lede">{writes ? 'Reads and writes' : 'Reads'} Starlings as {ownerEmail}.</p> : null}
        {client && destination ? (
          <p className="lede">
            {destination.kind === 'loopback'
              ? t('Signs in through an app on this computer.')
              : t('Signs in through {host}.', { host: destination.host })}
          </p>
        ) : null}
        {client ? (
          <Label className="mt-1 mb-3 flex cursor-pointer items-start gap-2.5 text-[13px] leading-[1.45] font-normal text-foreground">
            <Checkbox checked={writes} onCheckedChange={(checked) => setWrites(checked === true)} />
            <span className="min-w-0">{t('Also write: messages, tasks, issues, decisions, goals, calendar, Docs and website content')}</span>
          </Label>
        ) : null}
        {error ? <ErrorNotice message={error} /> : null}
        <div className="grid gap-3">
          <Button type="button" disabled={!client || !destination || busy} onClick={() => void allow()}>
            {t('Allow')}
          </Button>
          <Button type="button" variant="secondary" disabled={busy} onClick={deny}>
            {t('Cancel')}
          </Button>
        </div>
      </GuestCard>
    </AppShell>
  );
}
