import { useCallback, useEffect, useState } from 'react';
import type { AuditEvent, ItemBody, ItemKind, ItemSummary, MachineVaultDetail } from '@keep/contracts';
import { generateVaultKey, importVaultKey, sealItem, uuid, wrapKeyToPublicKey } from '@keep/crypto';
import { BotIcon, EllipsisIcon, PlusIcon } from 'lucide-react';
import { Button } from '@/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/ui/dropdown-menu';
import { Separator } from '@/ui/separator';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table';
import { api } from './api';
import { CanUse, useAccess } from './CanUse';
import { ConfirmDataLoss, ErrorNotice, Fine, PageHeader, Panel, Warning, errorMessage, toast, when } from './parts';
import { Tip } from './Tip';
import { ActivityTable, ItemEditor, KIND_LABEL } from './Vault';

/*
 * An agent's machine vault (ADR 0007). Its only member is the agent.
 * A person adds and rotates items here and never reads one: each item is
 * sealed under a fresh item key, and that key is wrapped to the agent's
 * public key, on this device. Only the broker opens them.
 */

type MachinePanel =
  | { kind: 'none' }
  | { kind: 'new' }
  | { kind: 'item'; item: ItemSummary }
  | { kind: 'rotate'; item: ItemSummary }
  | { kind: 'activity' }
  | { kind: 'access' };

/** Seal one body to the agent. The item key lives only inside this call. */
async function sealToAgent(vault: MachineVaultDetail, itemId: string, body: ItemBody) {
  if (!vault.agent.public_key) throw new Error('The agent has no key yet.');
  const itemKey = generateVaultKey();
  const sealed = await sealItem(await importVaultKey(itemKey), vault.id, itemId, vault.key_version, body);
  const wrapped_key = await wrapKeyToPublicKey(itemKey, vault.agent.public_key);
  itemKey.fill(0);
  return { sealed, wrapped_key };
}

async function saveMachineItem(vault: MachineVaultDetail, item: ItemSummary | null, name: string, kind: ItemKind, body: ItemBody): Promise<void> {
  const id = item?.id ?? uuid();
  const sealedToAgent = await sealToAgent(vault, id, body);
  if (item) await api.updateMachineItem(vault.id, id, { name, kind, key_version: vault.key_version, ...sealedToAgent });
  else await api.createMachineItem(vault.id, { id, name, kind, key_version: vault.key_version, ...sealedToAgent });
}

export function MachineVault({ id }: { id: string }) {
  const [vault, setVault] = useState<MachineVaultDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<MachinePanel>({ kind: 'none' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setVault(await api.machineVault(id));
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);
  const close = useCallback(() => setPanel({ kind: 'none' }), []);

  if (error) return <div className="max-w-[1100px]"><ErrorNotice message={error} /></div>;
  if (!vault) return <div className="max-w-[1100px]"><Fine>Loading…</Fine></div>;

  async function grantAgain(current: MachineVaultDetail): Promise<void> {
    if (!current.agent.public_key) return;
    setBusy(true);
    try {
      // A fresh vault key for the new generation, wrapped to the agent only.
      const key = generateVaultKey();
      await api.grantAgent(current.id, await wrapKeyToPublicKey(key, current.agent.public_key));
      key.fill(0);
      toast(`${current.agent.name} can use this vault again`);
      await load();
    } catch (caught) {
      toast(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const saved = () => {
    close();
    void load();
  };

  return (
    <div className="max-w-[1100px]">
      <PageHeader
        title={
          <h1 className="m-0 flex items-center gap-2 text-[clamp(24px,2.6vw,30px)]">
            <BotIcon aria-hidden="true" className="size-6 text-muted-foreground" />
            {vault.name}
          </h1>
        }
        meta={<>Agent’s vault · {vault.agent.name} ({vault.agent.address}) · key v{vault.key_version}</>}
        actions={
          <>
            <DropdownMenu>
              <Tip label="More">
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="icon" aria-label="More">
                    <EllipsisIcon />
                  </Button>
                </DropdownMenuTrigger>
              </Tip>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setPanel({ kind: 'activity' })}>Activity</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button variant="outline" onClick={() => setPanel({ kind: 'access' })}>
              Can use
            </Button>
            <Button disabled={!vault.agent_member} onClick={() => setPanel({ kind: 'new' })}>
              <PlusIcon aria-hidden="true" />
              New item
            </Button>
          </>
        }
      />

      <Fine className="mb-4">Only {vault.agent.name} can use these values, through the broker. Nobody can read them here.</Fine>

      {!vault.agent_member && (
        <div className="mb-4 grid gap-2">
          <Warning>
            {vault.agent.name} has no access to this vault.{' '}
            {vault.agent.public_key ? 'Grant it again to add items.' : 'The broker registers a new key first.'}
          </Warning>
          {vault.agent.public_key && (
            <Button className="w-fit" variant="outline" disabled={busy} onClick={() => void grantAgain(vault)}>
              Grant again
            </Button>
          )}
        </div>
      )}

      {vault.items.length === 0 ? (
        <p className="py-12 text-center text-muted-foreground">Nothing here yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead className="max-[720px]:hidden">Added by</TableHead>
              <TableHead className="max-[720px]:hidden">Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {vault.items.map((item) => (
              <TableRow
                key={item.id}
                tabIndex={0}
                className="cursor-pointer hover-lift"
                onClick={() => setPanel({ kind: 'item', item })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setPanel({ kind: 'item', item });
                  }
                }}
              >
                <TableCell>
                  {item.name}
                  {item.key_version < vault.key_version && <span className="ml-2 text-xs text-(--danger-ink)">Needs a new value</span>}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{KIND_LABEL[item.kind]}</TableCell>
                <TableCell className="text-xs text-muted-foreground max-[720px]:hidden">{item.created_by}</TableCell>
                <TableCell className="text-xs whitespace-nowrap text-muted-foreground tabular-nums max-[720px]:hidden">{when(item.updated_at)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {panel.kind === 'new' && (
        <ItemEditor title="New item" item={null} onSave={(name, kind, body) => saveMachineItem(vault, null, name, kind, body)} onClose={close} onSaved={saved} />
      )}
      {panel.kind === 'rotate' && (
        <ItemEditor
          title={`New value for ${panel.item.name}`}
          item={panel.item}
          onSave={(name, kind, body) => saveMachineItem(vault, panel.item, name, kind, body)}
          onClose={close}
          onSaved={saved}
        />
      )}
      {panel.kind === 'item' && (
        <MachineItemPanel vault={vault} item={panel.item} onClose={close} onRotate={() => setPanel({ kind: 'rotate', item: panel.item })} onChanged={saved} />
      )}
      {panel.kind === 'activity' && <MachineActivity vaultId={vault.id} onClose={close} />}
      {panel.kind === 'access' && (
        <Panel title="Can use" onClose={close}>
          <MachineCanUse vault={vault} itemId={null} onChanged={saved} />
          <Fine>People add and replace items here. No person can use them.</Fine>
        </Panel>
      )}
    </div>
  );
}

/** An item a person can replace or delete, and never open. */
function MachineItemPanel({ vault, item, onClose, onRotate, onChanged }: {
  vault: MachineVaultDetail;
  item: ItemSummary;
  onClose: () => void;
  onRotate: () => void;
  onChanged: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <Panel title={item.name} onClose={onClose}>
      <Fine>
        {KIND_LABEL[item.kind]} · added by {item.created_by} · {when(item.created_at)}
        {item.rotated_at && <> · new value {when(item.rotated_at)}</>}
      </Fine>
      <Fine>Only {vault.agent.name} can use this value. A new value replaces it; nobody sees the old one.</Fine>
      {item.key_version < vault.key_version && <Warning>Sealed before the last Revoke. Rotate it at the vendor, then enter the new value.</Warning>}
      <Separator className="my-1" />
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" disabled={!vault.agent_member} onClick={onRotate}>
          New value
        </Button>
        <Button variant="outline" onClick={() => setConfirming(true)}>
          Delete
        </Button>
      </div>
      <Separator className="my-1" />
      <h2 className="m-0 text-[13px] font-semibold">Can use</h2>
      <MachineCanUse vault={vault} itemId={item.id} onChanged={onChanged} />
      {confirming && (
        <ConfirmDataLoss
          title={`Delete “${item.name}”?`}
          body={`${vault.agent.name} can no longer use it. The audit trail keeps its name.`}
          action="Delete"
          onCancel={() => setConfirming(false)}
          onConfirm={async () => {
            setConfirming(false);
            try {
              await api.deleteMachineItem(vault.id, item.id);
              onChanged();
            } catch (caught) {
              toast(errorMessage(caught));
            }
          }}
        />
      )}
    </Panel>
  );
}

function MachineActivity({ vaultId, onClose }: { vaultId: string; onClose: () => void }) {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  useEffect(() => {
    api.machineAudit(vaultId).then((result) => setEvents(result.events));
  }, [vaultId]);
  return (
    <Panel title="Activity" onClose={onClose}>
      {events === null ? <Fine>Loading…</Fine> : <ActivityTable events={events} />}
    </Panel>
  );
}

/**
 * A machine vault's "can use": its agent, while it is a member. Revoke ends
 * the agent's standing access (tokens, membership, key; a new key version).
 * It asks first: every item then needs a new value before the agent can use
 * it again.
 */
function MachineCanUse({ vault, itemId, onChanged }: { vault: MachineVaultDetail; itemId: string | null; onChanged: () => void }) {
  const load = useCallback(() => api.machineAccess(vault.id, itemId ?? undefined), [vault.id, itemId]);
  const { access, error } = useAccess(load);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  return (
    <>
      <CanUse access={access} error={error} canRevoke={(entry) => entry.kind === 'agent'} busy={busy} onRevoke={() => setConfirming(true)} />
      {revokeError && <ErrorNotice message={revokeError} />}
      {confirming && (
        <ConfirmDataLoss
          title={`Revoke ${vault.agent.name}?`}
          body={`${vault.agent.name} loses access now. Its tokens and its key end. Every item needs a new value before it can use one again.`}
          action="Revoke"
          onCancel={() => setConfirming(false)}
          onConfirm={async () => {
            setConfirming(false);
            setBusy(vault.agent.address);
            setRevokeError(null);
            try {
              await api.revokeAgent(vault.id);
              toast(`Revoked ${vault.agent.name}; key version ${vault.key_version + 1}`);
              onChanged();
            } catch (caught) {
              setRevokeError(errorMessage(caught));
            } finally {
              setBusy(null);
            }
          }}
        />
      )}
    </>
  );
}
