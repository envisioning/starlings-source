import { useCallback, useEffect, useId, useState } from 'react';
import type { AgentSummary, DirectoryEntry, MachineVaultSummary, VaultSummary } from '@keep/contracts';
import { generateVaultKey, wrapKeyToPublicKey } from '@keep/crypto';
import { BotIcon, PlusIcon } from 'lucide-react';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { FieldLegend, FieldSet } from '@/ui/field';
import { Input } from '@/ui/input';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { api, type Me } from './api';
import { CheckRow, FormRow } from './form-row';
import { ErrorNotice, Fine, Link, PageHeader, Panel, Warning, errorMessage, navigate, when } from './parts';

export function Home({ me }: { me: Me }) {
  const [vaults, setVaults] = useState<VaultSummary[] | null>(null);
  const [machines, setMachines] = useState<MachineVaultSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState<'person' | 'agent' | null>(null);

  const load = useCallback(() => {
    api
      .vaults()
      .then((result) => setVaults(result.vaults))
      .catch((caught) => setError(errorMessage(caught)));
    api
      .machineVaults()
      .then((result) => setMachines(result.vaults))
      .catch((caught) => setError(errorMessage(caught)));
  }, []);
  useEffect(load, [load]);

  return (
    <div className="max-w-[1200px]">
      <PageHeader
        title="Vaults"
        actions={
          <>
            <Button variant="outline" onClick={() => setCreating('agent')}>
              <BotIcon aria-hidden="true" />
              New agent vault
            </Button>
            <Button onClick={() => setCreating('person')}>
              <PlusIcon aria-hidden="true" />
              New vault
            </Button>
          </>
        }
      />
      {error && <ErrorNotice message={error} />}
      {vaults === null ? (
        <Fine>Loading…</Fine>
      ) : vaults.length === 0 ? (
        <p className="py-12 text-center text-muted-foreground">No vaults yet.</p>
      ) : (
        <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3 p-0">
          {vaults.map((vault) => (
            <li key={vault.id}>
              <Link
                to={`/vaults/${vault.id}`}
                className="block h-full rounded-xl border bg-card p-4 text-foreground no-underline hover-lift hover-edge"
              >
                <h3 className="m-0 text-[15px] font-semibold">{vault.name}</h3>
                <p className="mt-2 mb-0 text-[13px] text-muted-foreground">
                  {vault.item_count} {vault.item_count === 1 ? 'item' : 'items'} · {vault.member_count}{' '}
                  {vault.member_count === 1 ? 'member' : 'members'}
                </p>
                <p className="mt-2.5 mb-0 text-[11.5px] text-muted-foreground">Updated {when(vault.updated_at)}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {machines.length > 0 && (
        <>
          <h2 className="mt-8 mb-3 text-[15px] font-semibold">Agents’ vaults</h2>
          <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3 p-0">
            {machines.map((vault) => (
              <li key={vault.id}>
                <Link
                  to={`/machine-vaults/${vault.id}`}
                  className="block h-full rounded-xl border bg-card p-4 text-foreground no-underline hover-lift hover-edge"
                >
                  <h3 className="m-0 flex items-center gap-1.5 text-[15px] font-semibold">
                    <BotIcon aria-hidden="true" className="size-4 text-muted-foreground" />
                    {vault.name}
                  </h3>
                  <p className="mt-2 mb-0 text-[13px] text-muted-foreground">
                    {vault.agent.name}’s · {vault.item_count} {vault.item_count === 1 ? 'item' : 'items'}
                    {!vault.agent_member && ' · no access'}
                  </p>
                  <p className="mt-2.5 mb-0 text-[11.5px] text-muted-foreground">Updated {when(vault.updated_at)}</p>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
      {creating === 'person' && (
        <NewVault
          me={me}
          onClose={() => setCreating(null)}
          onCreated={(id) => {
            setCreating(null);
            navigate(`/vaults/${id}`);
          }}
        />
      )}
      {creating === 'agent' && (
        <NewAgentVault
          onClose={() => setCreating(null)}
          onCreated={(id) => {
            setCreating(null);
            navigate(`/machine-vaults/${id}`);
          }}
        />
      )}
    </div>
  );
}

/**
 * Create: a fresh vault key, wrapped to me and to each chosen colleague and
 * to the recovery key if one exists. The key bytes never leave this
 * function; the server sees only the wraps.
 */
function NewVault({ me, onClose, onCreated }: { me: Me; onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState('');
  const [projectId, setProjectId] = useState('');
  const [directory, setDirectory] = useState<DirectoryEntry[]>([]);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [recoveryPublicKey, setRecoveryPublicKey] = useState<string | null | 'loading'>('loading');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  const projectFieldId = useId();
  const memberId = useId();

  useEffect(() => {
    api.directory().then((result) => setDirectory(result.entries.filter((entry) => entry.email !== me.email)));
    api.recovery().then((result) => setRecoveryPublicKey(result.recovery?.public_key ?? null));
  }, [me.email]);

  async function create(): Promise<void> {
    if (!me.key) return;
    setBusy(true);
    setError(null);
    try {
      const key = generateVaultKey();
      const members = [{ email: me.email, wrapped_key: await wrapKeyToPublicKey(key, me.key.public_key) }];
      for (const entry of directory) {
        if (chosen.has(entry.email)) members.push({ email: entry.email, wrapped_key: await wrapKeyToPublicKey(key, entry.public_key) });
      }
      const recovery = typeof recoveryPublicKey === 'string' ? await wrapKeyToPublicKey(key, recoveryPublicKey) : null;
      const vault = await api.createVault({
        name,
        project_id: projectId.trim() === '' ? null : projectId.trim(),
        members,
        recovery_wrapped_key: recovery,
      });
      onCreated(vault.id);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="New vault" onClose={onClose}>
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <FormRow id={nameId} label="Name" className="my-0">
          <Input id={nameId} autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Client name" />
        </FormRow>
        <FormRow id={projectFieldId} label="Core project id (optional)" className="my-0">
          <Input id={projectFieldId} value={projectId} onChange={(event) => setProjectId(event.target.value)} spellCheck={false} />
        </FormRow>
        <FieldSet className="gap-0">
          <FieldLegend variant="label" className="text-xs font-normal text-muted-foreground">Members</FieldLegend>
          {directory.length === 0 ? (
            <Fine>Nobody else is enrolled yet.</Fine>
          ) : (
            directory.map((entry) => (
              <CheckRow key={entry.email} id={`${memberId}-${entry.email}`} label={<>{entry.name} <span className="text-muted-foreground">({entry.email})</span></>} className="my-1">
                <Checkbox
                  id={`${memberId}-${entry.email}`}
                  checked={chosen.has(entry.email)}
                  onCheckedChange={(checked) => {
                    const next = new Set(chosen);
                    if (checked === true) next.add(entry.email);
                    else next.delete(entry.email);
                    setChosen(next);
                  }}
                />
              </CheckRow>
            ))
          )}
        </FieldSet>
        {recoveryPublicKey === null && (
          <Warning>No recovery key is set. If every member loses their key, this vault is gone. Set one in Settings.</Warning>
        )}
        {error && <ErrorNotice message={error} />}
        <Button className="w-fit" type="submit" disabled={busy || name.trim() === '' || recoveryPublicKey === 'loading'}>
          {busy ? 'Creating…' : 'Create vault'}
        </Button>
      </form>
    </Panel>
  );
}

/**
 * An agent's vault: a fresh vault key, wrapped to the agent's public key
 * and to nobody else. Not to me, not to recovery: a machine vault has one
 * member, its agent. The key bytes never leave this function.
 */
function NewAgentVault({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [address, setAddress] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const agentId = useId();
  const nameId = useId();

  useEffect(() => {
    api
      .agents()
      .then((result) => setAgents(result.agents.filter((agent) => agent.public_key && !agent.vault_id)))
      .catch((caught) => setError(errorMessage(caught)));
  }, []);

  const agent = agents?.find((entry) => entry.address === address) ?? null;

  async function create(): Promise<void> {
    if (!agent?.public_key) return;
    setBusy(true);
    setError(null);
    try {
      const key = generateVaultKey();
      const vault = await api.createMachineVault({ name, agent: agent.address, wrapped_key: await wrapKeyToPublicKey(key, agent.public_key) });
      key.fill(0);
      onCreated(vault.id);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="New agent vault" onClose={onClose}>
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        {agents !== null && agents.length === 0 ? (
          <Fine>No agent is ready. An agent is ready when the broker has registered its key and it has no vault yet.</Fine>
        ) : (
          <FormRow id={agentId} label="Agent" className="my-0">
            <NativeSelect
              id={agentId}
              className="w-full"
              value={address}
              onChange={(event) => {
                const next = agents?.find((entry) => entry.address === event.target.value);
                setAddress(event.target.value);
                if (next && name.trim() === '') setName(`${next.name} keys`);
              }}
            >
              <NativeSelectOption value="">Choose an agent…</NativeSelectOption>
              {(agents ?? []).map((entry) => (
                <NativeSelectOption key={entry.address} value={entry.address}>
                  {entry.name} ({entry.address})
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </FormRow>
        )}
        <FormRow id={nameId} label="Name" className="my-0">
          <Input id={nameId} value={name} onChange={(event) => setName(event.target.value)} />
        </FormRow>
        <Fine>Only the agent can use what goes in here. You can add and replace items, and never read them.</Fine>
        {error && <ErrorNotice message={error} />}
        <Button className="w-fit" type="submit" disabled={busy || !agent || name.trim() === ''}>
          {busy ? 'Creating…' : 'Create vault'}
        </Button>
      </form>
    </Panel>
  );
}
