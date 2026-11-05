import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { AccessEntry, ReleaseEntry, VaultAccess } from '@keep/contracts';
import { BotIcon } from 'lucide-react';
import { Button } from '@/ui/button';
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from '@/ui/item';
import { api } from './api';
import { ConfirmDataLoss, ErrorNotice, Fine, errorMessage, when } from './parts';

/*
 * Who can use a vault or an item (ADR 0007 decision 7): people,
 * agents with standing access, and agents with an active release. "Can use",
 * not "has": with the broker, no agent holds a value. Each row has its last
 * use from the audit trail, and Revoke where the caller can revoke.
 */

/** Load a "can use" list and reload it on demand. */
export function useAccess(load: () => Promise<VaultAccess>): { access: VaultAccess | null; error: string | null; reload: () => void } {
  const [access, setAccess] = useState<VaultAccess | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    load()
      .then((result) => {
        setAccess(result);
        setError(null);
      })
      .catch((caught) => setError(errorMessage(caught)));
  }, [load]);
  useEffect(reload, [reload]);
  return { access, error, reload };
}

/**
 * Revoke on a release row: ask first, then end it now and reload the list.
 * `dialog` is the confirm; render it next to the list.
 */
export function useEndRelease(
  vaultId: string,
  reload: () => void,
): { ending: string | null; error: string | null; end: (release: ReleaseEntry) => void; dialog: ReactNode } {
  const [ending, setEnding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<ReleaseEntry | null>(null);
  const run = useCallback(
    (release: ReleaseEntry) => {
      setEnding(release.id);
      setError(null);
      api
        .endRelease(vaultId, release.id)
        .then(reload)
        .catch((caught) => setError(errorMessage(caught)))
        .finally(() => setEnding(null));
    },
    [vaultId, reload],
  );
  const dialog = confirming && (
    <ConfirmDataLoss
      title={`Revoke ${confirming.agent.name}?`}
      body={`${confirming.agent.name} can’t use “${confirming.item_name}” after this. A new release needs a new approval.`}
      action="Revoke"
      final={false}
      onCancel={() => setConfirming(null)}
      onConfirm={() => {
        setConfirming(null);
        run(confirming);
      }}
    />
  );
  return { ending, error, end: setConfirming, dialog };
}

export function CanUse({
  access,
  error,
  canRevoke,
  busy,
  onRevoke,
  onEndRelease,
}: {
  access: VaultAccess | null;
  error: string | null;
  /** Whether this row offers Revoke. */
  canRevoke: (entry: AccessEntry) => boolean;
  /** The row being revoked, if any: an address, or a release id. */
  busy: string | null;
  onRevoke: (entry: AccessEntry) => void;
  /** Revoke on a release row: ends it now. Absent, the rows offer nothing. */
  onEndRelease?: (release: ReleaseEntry) => void;
}) {
  if (error) return <ErrorNotice message={error} />;
  if (!access) return <Fine>Loading…</Fine>;
  const releases = access.releases ?? [];
  return (
    <div className="grid gap-3">
      <Section title="People">
        {access.people.length === 0 ? (
          <Fine>No person can use {access.item_id ? 'this item' : 'this vault'}.</Fine>
        ) : (
          access.people.map((entry) => <Row key={entry.address} entry={entry} canRevoke={canRevoke(entry)} busy={busy} onRevoke={onRevoke} />)
        )}
      </Section>
      {access.agents.length > 0 && (
        <Section title="Agents">
          {access.agents.map((entry) => <Row key={entry.address} entry={entry} canRevoke={canRevoke(entry)} busy={busy} onRevoke={onRevoke} />)}
        </Section>
      )}
      {releases.length > 0 && (
        <Section title="Active releases">
          {releases.map((release) => (
            <Item key={release.id} variant="outline" size="sm" className="bg-(--surface-raised)">
              <ItemContent className="min-w-0 gap-0">
                <ItemTitle className="w-full min-w-0">
                  <span className="truncate">
                    {release.agent.name} <span className="font-normal text-muted-foreground">· {release.item_name}</span>
                  </span>
                </ItemTitle>
                <ItemDescription className="text-[11.5px]">
                  approved by {release.approver} for {release.task} · until {when(release.expires_at)} · {release.last_used_at ? `used ${when(release.last_used_at)}` : 'not used yet'}
                </ItemDescription>
              </ItemContent>
              {onEndRelease && (
                <ItemActions>
                  <Button variant="ghost" size="xs" className="text-muted-foreground" disabled={busy !== null} onClick={() => onEndRelease(release)}>
                    {busy === release.id ? 'Revoking…' : 'Revoke'}
                  </Button>
                </ItemActions>
              )}
            </Item>
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-1.5">
      <h3 className="m-0 text-[11px] font-semibold tracking-[0.07em] text-muted-foreground uppercase">{title}</h3>
      <ul className="m-0 grid list-none gap-1.5 p-0">{children}</ul>
    </section>
  );
}

function Row({ entry, canRevoke, busy, onRevoke }: { entry: AccessEntry; canRevoke: boolean; busy: string | null; onRevoke: (entry: AccessEntry) => void }) {
  return (
    <li>
      <Item variant="outline" size="sm" className="bg-(--surface-raised)">
        <ItemContent className="min-w-0 gap-0">
          <ItemTitle className="w-full min-w-0">
            <span className="flex min-w-0 items-center gap-1.5 truncate">
              {entry.kind === 'agent' && <BotIcon aria-hidden="true" className="size-3.5 flex-none text-muted-foreground" />}
              {entry.name} <span className="font-normal text-muted-foreground">({entry.address})</span>
            </span>
          </ItemTitle>
          <ItemDescription className="text-[11.5px]">
            can use · added by {entry.granted_by} · {lastUse(entry.last_used_at)}
          </ItemDescription>
        </ItemContent>
        {canRevoke && (
          <ItemActions>
            <Button variant="ghost" size="xs" className="text-muted-foreground" disabled={busy !== null} onClick={() => onRevoke(entry)}>
              {busy === entry.address ? 'Revoking…' : 'Revoke'}
            </Button>
          </ItemActions>
        )}
      </Item>
    </li>
  );
}

function lastUse(at: string | null): string {
  return at ? `last use ${when(at)}` : 'not used yet';
}
