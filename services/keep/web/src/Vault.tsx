import { useCallback, useEffect, useId, useState } from 'react';
import type { AccessEntry, AuditEvent, DirectoryEntry, ItemBody, ItemKind, ItemSummary, VaultDetail } from '@keep/contracts';
import { itemKinds } from '@keep/contracts';
import { generateVaultKey, importVaultKey, openItem, sealItem, uuid, wrapKeyToPublicKey } from '@keep/crypto';
import { EllipsisIcon, PlusIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/ui/dropdown-menu';
import { Input } from '@/ui/input';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { Separator } from '@/ui/separator';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table';
import { Textarea } from '@/ui/textarea';
import { api, type Me } from './api';
import { CanUse, useAccess, useEndRelease } from './CanUse';
import { FormRow } from './form-row';
import { Import } from './Import';
import * as session from './session';
import { ConfirmDataLoss, ErrorNotice, Fine, PageHeader, Panel, copy, errorMessage, navigate, toast, when, SecretInput } from './parts';
import { Tip } from './Tip';
import { decodeQR, parseTOTP, qrDecodeSupported, totpCode, totpSecondsRemaining, totpURI, type TOTP } from './totp';

export const KIND_LABEL: Record<ItemKind, string> = {
  login: 'Login',
  api_key: 'API key',
  note: 'Note',
  database: 'Database',
  ssh_key: 'SSH key',
  credit_card: 'Credit card',
  other: 'Other',
};

export const EMPTY_BODY: ItemBody = { username: '', password: '', url: '', notes: '', totp: '' };

type Panel = { kind: 'none' } | { kind: 'new' } | { kind: 'item'; item: ItemSummary } | { kind: 'members' } | { kind: 'activity' } | { kind: 'import' };

export function Vault({ id, me }: { id: string; me: Me }) {
  const [vault, setVault] = useState<VaultDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>({ kind: 'none' });
  const [renaming, setRenaming] = useState(false);

  const load = useCallback(async () => {
    try {
      setVault(await api.vault(id));
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  const close = useCallback(() => setPanel({ kind: 'none' }), []);

  if (error) {
    return (
      <div className="max-w-[1100px]">
        <ErrorNotice message={error} />
      </div>
    );
  }
  if (!vault) {
    return (
      <div className="max-w-[1100px]">
        <Fine>Loading…</Fine>
      </div>
    );
  }

  const coreLink = vault.project_id && me.core_web_origin ? `${me.core_web_origin}/dashboard/projects/${vault.project_id}` : null;

  const meta = (
    <>
      {vault.members.length} {vault.members.length === 1 ? 'member' : 'members'} · key v{vault.key_version}
      {vault.recovery_wrapped ? ' · recoverable' : ' · no recovery copy'}
      {coreLink && (
        <>
          {' · '}
          <a href={coreLink} target="_blank" rel="noreferrer">
            Open in Core
          </a>
        </>
      )}
    </>
  );

  return (
    <div className="max-w-[1100px]">
      <PageHeader
        title={
          renaming ? (
            <RenameForm
              vault={vault}
              onDone={() => {
                setRenaming(false);
                void load();
              }}
              onCancel={() => setRenaming(false)}
            />
          ) : (
            <h1 className="m-0 text-[clamp(24px,2.6vw,30px)]">{vault.name}</h1>
          )
        }
        meta={meta}
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
                <DropdownMenuItem onSelect={() => setPanel({ kind: 'import' })}>Import</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setRenaming(true)}>Rename</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button variant="outline" onClick={() => setPanel({ kind: 'members' })}>
              Can use
            </Button>
            <Button onClick={() => setPanel({ kind: 'new' })}>
              <PlusIcon aria-hidden="true" />
              New item
            </Button>
          </>
        }
      />

      {vault.items.length === 0 ? (
        <p className="py-12 text-center text-muted-foreground">Nothing here yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Kind</TableHead>
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
                <TableCell>{item.name}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{KIND_LABEL[item.kind]}</TableCell>
                <TableCell className="text-xs whitespace-nowrap text-muted-foreground tabular-nums max-[720px]:hidden">{when(item.updated_at)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {panel.kind === 'new' && (
        <ItemEditor
          title="New item"
          item={null}
          onSave={(name, kind, body) => saveItem(vault, null, name, kind, body)}
          onClose={close}
          onSaved={() => {
            close();
            void load();
          }}
        />
      )}
      {panel.kind === 'item' && (
        <ItemPanel
          vault={vault}
          me={me}
          item={panel.item}
          onClose={close}
          onChanged={() => {
            close();
            void load();
          }}
        />
      )}
      {panel.kind === 'members' && (
        <Members
          vault={vault}
          me={me}
          onClose={close}
          onChanged={() => {
            void load();
          }}
        />
      )}
      {panel.kind === 'activity' && <Activity vaultId={vault.id} onClose={close} />}
      {panel.kind === 'import' && (
        <Import
          vault={vault}
          onClose={close}
          onDone={() => {
            close();
            void load();
          }}
        />
      )}
    </div>
  );
}

function RenameForm({ vault, onDone, onCancel }: { vault: VaultDetail; onDone: () => void; onCancel: () => void }) {
  const [name, setName] = useState(vault.name);
  const [projectId, setProjectId] = useState(vault.project_id ?? '');
  const [busy, setBusy] = useState(false);
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        try {
          await api.updateVault(vault.id, { name, project_id: projectId.trim() === '' ? null : projectId.trim() });
          onDone();
        } catch (caught) {
          toast(errorMessage(caught));
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Input className="w-auto flex-[1_1_160px]" aria-label="Name" autoFocus value={name} onChange={(event) => setName(event.target.value)} />
        <Input className="w-auto flex-[1_1_160px]" aria-label="Core project id" value={projectId} onChange={(event) => setProjectId(event.target.value)} placeholder="Core project id" spellCheck={false} />
        <Button type="submit" disabled={busy || name.trim() === ''}>
          Save
        </Button>
        <Button variant="outline" type="button" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/** Reveal: fetch one ciphertext (audited), open it here, show it until closed. */
function ItemPanel({ vault, me, item, onClose, onChanged }: { vault: VaultDetail; me: Me; item: ItemSummary; onClose: () => void; onChanged: () => void }) {
  const [body, setBody] = useState<ItemBody | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const detail = await api.reveal(vault.id, item.id);
        const key = await session.vaultKey(vault.id, vault.key_version, vault.wrapped_key);
        const opened = await openItem(key, vault.id, item.id, detail.key_version, detail.sealed);
        if (!cancelled) setBody(opened);
      } catch (caught) {
        if (!cancelled) setError(errorMessage(caught));
      }
    })();
    return () => {
      cancelled = true;
      // Plaintext leaves component state with the component.
      setBody(null);
    };
  }, [vault, item.id]);

  if (editing && body) {
    return (
      <ItemEditor
        title={`Edit ${item.name}`}
        item={item}
        initial={body}
        onSave={(name, kind, next) => saveItem(vault, item, name, kind, next)}
        onClose={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          onChanged();
        }}
      />
    );
  }

  return (
    <Panel title={item.name} onClose={onClose}>
      <Fine>
        {KIND_LABEL[item.kind]} · added by {item.created_by} · {when(item.created_at)}
      </Fine>
      {error && <ErrorNotice message={error} />}
      {!body && !error && <Fine>Opening…</Fine>}
      {body && (
        <>
          {body.username && <Revealed label="Username" value={body.username} />}
          {body.password && (
            <Revealed
              label={item.kind === 'api_key' ? 'Key' : 'Password'}
              value={body.password}
              masked={!showPassword}
              onToggle={() => setShowPassword((value) => !value)}
            />
          )}
          {body.url && <Revealed label="URL" value={body.url} link />}
          {body.totp && (parseTOTP(body.totp) ? <TOTPField totp={parseTOTP(body.totp)!} /> : <Revealed label="One-time code" value={body.totp} masked />)}
          {body.notes && <Revealed label="Notes" value={body.notes} />}
          <Separator className="my-1" />
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button variant="outline" onClick={() => setConfirming(true)}>
              Delete
            </Button>
          </div>
        </>
      )}
      <Separator className="my-1" />
      <h2 className="m-0 text-[13px] font-semibold">Can use</h2>
      <ItemCanUse vault={vault} me={me} itemId={item.id} onChanged={onChanged} />
      {confirming && (
        <ConfirmDataLoss
          title={`Delete “${item.name}”?`}
          body="Its values are gone. The audit trail keeps its name."
          action="Delete"
          onCancel={() => setConfirming(false)}
          onConfirm={async () => {
            setConfirming(false);
            try {
              await api.deleteItem(vault.id, item.id);
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

/** A revealed value: monospace in a well, with copy beside it. Never in an input. */
function Revealed({ label, value, masked = false, link = false, onToggle }: { label: string; value: string; masked?: boolean; link?: boolean; onToggle?: () => void }) {
  return (
    <div className="grid gap-1">
      <span className="text-[11px] font-semibold tracking-[0.07em] text-muted-foreground uppercase">{label}</span>
      <div className="flex min-h-9 items-center gap-2 rounded-md border bg-muted px-2.5 py-1.5 font-mono text-[13px]">
        {link ? (
          <code className="min-w-0 flex-auto [overflow-wrap:anywhere] whitespace-pre-wrap">
            <a href={value} target="_blank" rel="noreferrer noopener">
              {value}
            </a>
          </code>
        ) : (
          <code className={cn('min-w-0 flex-auto [overflow-wrap:anywhere] whitespace-pre-wrap', masked && 'tracking-[0.15em]')}>{masked ? '•'.repeat(Math.min(value.length, 24)) : value}</code>
        )}
        {onToggle && (
          <Button variant="ghost" size="xs" className="flex-none font-sans text-muted-foreground" onClick={onToggle}>
            {masked ? 'Show' : 'Hide'}
          </Button>
        )}
        <Button variant="ghost" size="xs" className="flex-none font-sans text-muted-foreground" onClick={() => void copy(value, `${label} copied`)}>
          Copy
        </Button>
      </div>
    </div>
  );
}

/** Seal under this vault's key, here, and send the ciphertext and a name. */
async function saveItem(vault: VaultDetail, item: ItemSummary | null, name: string, kind: ItemKind, body: ItemBody): Promise<void> {
  const key = await session.vaultKey(vault.id, vault.key_version, vault.wrapped_key);
  if (item) {
    const sealed = await sealItem(key, vault.id, item.id, vault.key_version, body);
    await api.updateItem(vault.id, item.id, { name, kind, sealed, key_version: vault.key_version });
  } else {
    const id = uuid();
    const sealed = await sealItem(key, vault.id, id, vault.key_version, body);
    await api.createItem(vault.id, { id, name, kind, sealed, key_version: vault.key_version });
  }
}

/**
 * Create or edit. The form checks the one-time code and hands the body to
 * `onSave`, which seals it on this device; the server receives ciphertext
 * and a name. A machine vault's `onSave` seals to the agent instead.
 */
export function ItemEditor({
  title,
  item,
  initial = EMPTY_BODY,
  onSave,
  onClose,
  onSaved,
}: {
  title: string;
  item: ItemSummary | null;
  initial?: ItemBody;
  onSave: (name: string, kind: ItemKind, body: ItemBody) => Promise<void>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(item?.name ?? '');
  const [kind, setKind] = useState<ItemKind>(item?.kind ?? 'login');
  const [body, setBody] = useState<ItemBody>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [qrNotice, setQrNotice] = useState<string | null>(null);
  const ids = { name: useId(), kind: useId(), username: useId(), password: useId(), url: useId(), totp: useId(), notes: useId() };

  function set<K extends keyof ItemBody>(field: K, value: ItemBody[K]): void {
    setBody((current) => ({ ...current, [field]: value }));
  }

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    // Whatever was pasted, store the canonical otpauth URI.
    let toSave = body;
    if (body.totp) {
      const totp = parseTOTP(body.totp);
      if (!totp) {
        setError('The one-time code secret isn’t valid.');
        setBusy(false);
        return;
      }
      toSave = { ...body, totp: totpURI(totp) };
    }
    try {
      await onSave(name, kind, toSave);
      onSaved();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title={title} onClose={onClose}>
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <FormRow id={ids.name} label="Name" className="my-0">
          <Input id={ids.name} autoFocus value={name} onChange={(event) => setName(event.target.value)} />
        </FormRow>
        <FormRow id={ids.kind} label="Kind" className="my-0">
          <NativeSelect id={ids.kind} className="w-full" value={kind} onChange={(event) => setKind(event.target.value as ItemKind)}>
            {itemKinds.map((value) => (
              <NativeSelectOption key={value} value={value}>
                {KIND_LABEL[value]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </FormRow>
        <FormRow id={ids.username} label="Username" className="my-0">
          <Input id={ids.username} value={body.username} autoComplete="off" spellCheck={false} onChange={(event) => set('username', event.target.value)} />
        </FormRow>
        <FormRow id={ids.password} label={kind === 'api_key' ? 'Key' : 'Password'} className="my-0">
          <SecretInput id={ids.password} value={body.password} onChange={(value) => set('password', value)} autoComplete="off" />
        </FormRow>
        <FormRow id={ids.url} label="URL" className="my-0">
          <Input id={ids.url} value={body.url} autoComplete="off" spellCheck={false} onChange={(event) => set('url', event.target.value)} />
        </FormRow>
        <FormRow id={ids.totp} label="One-time code secret or otpauth:// link" className="my-0">
          <SecretInput id={ids.totp} value={body.totp} onChange={(value) => set('totp', value)} autoComplete="off" />
        </FormRow>
        {body.totp && !parseTOTP(body.totp) && <ErrorNotice message="Not a one-time code secret. Paste the otpauth link or the base32 key." />}
        <div className="flex flex-wrap items-center gap-2">
          {qrDecodeSupported() ? (
            <Button asChild variant="outline" size="sm" className="cursor-pointer">
              {/* shadcn: a label so a click opens the hidden file input */}
              <label>
                QR from picture…
                <input
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (!file) return;
                    const text = await decodeQR(file);
                    const totp = text ? parseTOTP(text) : null;
                    if (!totp) return setQrNotice(text ? 'That QR code isn’t a one-time code setup.' : 'No QR code in that picture.');
                    set('totp', totpURI(totp));
                    if (!name.trim() && totp.issuer) setName(totp.issuer);
                    if (!body.username && totp.account) set('username', totp.account);
                    setQrNotice(`One-time code added${totp.issuer ? ` for ${totp.issuer}` : ''}.`);
                  }}
                />
              </label>
            </Button>
          ) : (
            <Fine>This browser can’t read QR pictures. Paste the link or key.</Fine>
          )}
        </div>
        {qrNotice && <Fine>{qrNotice}</Fine>}
        <FormRow id={ids.notes} label="Notes" className="my-0">
          <Textarea id={ids.notes} className="min-h-[84px]" value={body.notes} spellCheck={false} onChange={(event) => set('notes', event.target.value)} />
        </FormRow>
        {error && <ErrorNotice message={error} />}
        <Button className="w-fit" type="submit" disabled={busy || name.trim() === ''}>
          {busy ? 'Sealing…' : 'Save'}
        </Button>
      </form>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Can use — grant wraps; revoke rotates
// ---------------------------------------------------------------------------

/**
 * Removing someone means a new vault key: fetch every item, open it under
 * the old key, seal it under the new one, wrap the new key to everyone who
 * stays and to recovery, and send the lot as one rotation. Only others can
 * be removed: the server requires the caller among the new wraps. The
 * confirm is in useRevokePerson.
 */
async function removeMember(vault: VaultDetail, email: string): Promise<void> {
  const oldKey = await session.vaultKey(vault.id, vault.key_version, vault.wrapped_key);
  const newKeyBytes = generateVaultKey();
  const newKey = await importVaultKey(newKeyBytes);
  const nextVersion = vault.key_version + 1;

  const items: Array<{ id: string; sealed: { iv: string; ciphertext: string } }> = [];
  for (const summary of vault.items) {
    const detail = await api.reveal(vault.id, summary.id);
    const body = await openItem(oldKey, vault.id, summary.id, detail.key_version, detail.sealed);
    items.push({ id: summary.id, sealed: await sealItem(newKey, vault.id, summary.id, nextVersion, body) });
  }

  const directory = (await api.directory()).entries;
  const staying = vault.members.filter((member) => member.email !== email);
  const keys = new Map(directory.map((entry) => [entry.email, entry.public_key]));
  const members = [];
  for (const member of staying) {
    const publicKey = keys.get(member.email);
    if (!publicKey) throw new Error(`${member.email} is no longer enrolled; remove them first.`);
    members.push({ email: member.email, wrapped_key: await wrapKeyToPublicKey(newKeyBytes, publicKey) });
  }
  const recovery = await api.recovery();
  const recoveryWrap = recovery.recovery ? await wrapKeyToPublicKey(newKeyBytes, recovery.recovery.public_key) : null;

  await api.rotate(vault.id, { key_version: nextVersion, members, recovery_wrapped_key: recoveryWrap, items });
  session.forgetVaultKey(vault.id);
  toast(`Removed ${email}; key rotated to v${nextVersion}`);
}

/**
 * Revoke from a "can use" list: the person's removal, the same as everywhere.
 * It asks first (MZ, 2026-10-06): the person loses access at once. `dialog`
 * is the confirm; render it next to the list.
 */
function useRevokePerson(vault: VaultDetail, onChanged: () => void) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<AccessEntry | null>(null);
  async function run(email: string): Promise<void> {
    setBusy(email);
    setError(null);
    try {
      await removeMember(vault, email);
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }
  const dialog = confirming && (
    <ConfirmDataLoss
      title={`Revoke ${confirming.name}?`}
      body={`${confirming.name} loses access to “${vault.name}” now. Keep seals every item under a new key. A member can add them back.`}
      action="Revoke"
      final={false}
      onCancel={() => setConfirming(null)}
      onConfirm={() => {
        setConfirming(null);
        void run(confirming.address);
      }}
    />
  );
  return { busy, error, revoke: setConfirming, dialog };
}

/** One item's "can use": every member of a person's vault can use every item; last use is per item. */
function ItemCanUse({ vault, me, itemId, onChanged }: { vault: VaultDetail; me: Me; itemId: string; onChanged: () => void }) {
  const load = useCallback(() => api.access(vault.id, itemId), [vault.id, itemId]);
  const { access, error, reload } = useAccess(load);
  const { busy, error: revokeError, revoke, dialog: revokeDialog } = useRevokePerson(vault, onChanged);
  const { ending, error: endError, end, dialog: endDialog } = useEndRelease(vault.id, reload);
  return (
    <>
      <CanUse
        access={access}
        error={error}
        canRevoke={(entry) => entry.kind === 'person' && entry.address !== me.email && vault.members.length > 1}
        busy={busy ?? ending}
        onRevoke={revoke}
        onEndRelease={end}
      />
      {(revokeError ?? endError) && <ErrorNotice message={(revokeError ?? endError)!} />}
      {revokeDialog}
      {endDialog}
    </>
  );
}

function Members({ vault, me, onClose, onChanged }: { vault: VaultDetail; me: Me; onClose: () => void; onChanged: () => void }) {
  const [directory, setDirectory] = useState<DirectoryEntry[]>([]);
  const [adding, setAdding] = useState('');
  const [granting, setGranting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const addId = useId();
  const load = useCallback(() => api.access(vault.id), [vault.id]);
  const { access, error: accessError, reload } = useAccess(load);
  const changed = () => {
    onChanged();
    reload();
  };
  const { busy: revoking, error: revokeError, revoke, dialog: revokeDialog } = useRevokePerson(vault, changed);
  const { ending, error: endError, end, dialog: endDialog } = useEndRelease(vault.id, reload);
  const busy = granting || revoking !== null;

  useEffect(() => {
    api.directory().then((result) => setDirectory(result.entries));
  }, []);

  const memberEmails = new Set(vault.members.map((member) => member.email));
  const candidates = directory.filter((entry) => !memberEmails.has(entry.email));

  async function grant(): Promise<void> {
    const entry = directory.find((candidate) => candidate.email === adding);
    if (!entry) return;
    setGranting(true);
    setError(null);
    try {
      const keyBytes = await session.vaultKeyBytes(vault.wrapped_key);
      await api.grant(vault.id, { email: entry.email, wrapped_key: await wrapKeyToPublicKey(keyBytes, entry.public_key) });
      setAdding('');
      changed();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setGranting(false);
    }
  }

  return (
    <Panel title="Can use" onClose={onClose}>
      <CanUse
        access={access}
        error={accessError}
        canRevoke={(entry) => entry.kind === 'person' && entry.address !== me.email && vault.members.length > 1}
        busy={revoking ?? ending}
        onRevoke={revoke}
        onEndRelease={end}
      />
      {(revokeError ?? endError) && <ErrorNotice message={(revokeError ?? endError)!} />}
      {revokeDialog}
      {endDialog}
      <Separator className="my-1" />
      <div className="flex flex-wrap items-center gap-2">
        <NativeSelect id={addId} aria-label="Add a member" className="w-full" value={adding} onChange={(event) => setAdding(event.target.value)}>
          <NativeSelectOption value="">Add a member…</NativeSelectOption>
          {candidates.map((entry) => (
            <NativeSelectOption key={entry.email} value={entry.email}>
              {entry.name} ({entry.email})
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <Button disabled={adding === '' || busy} onClick={() => void grant()}>
          Add
        </Button>
      </div>
      <Fine>Adding wraps the vault key to them. Revoking re-seals everything under a new key.</Fine>
      {error && <ErrorNotice message={error} />}
      <Separator className="my-1" />
      <Button className="w-fit" variant="destructive" disabled={busy} onClick={() => setConfirmingDelete(true)}>
        Delete vault
      </Button>
      {confirmingDelete && (
        <ConfirmDataLoss
          title={`Delete “${vault.name}”?`}
          body={`Its ${vault.items.length} ${vault.items.length === 1 ? 'item is' : 'items are'} gone. The audit trail stays.`}
          action="Delete"
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={async () => {
            setConfirmingDelete(false);
            try {
              await api.deleteVault(vault.id);
              navigate('/');
            } catch (caught) {
              setError(errorMessage(caught));
            }
          }}
        />
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

function Activity({ vaultId, onClose }: { vaultId: string; onClose: () => void }) {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  useEffect(() => {
    api.vaultAudit(vaultId).then((result) => setEvents(result.events));
  }, [vaultId]);
  return (
    <Panel title="Activity" onClose={onClose}>
      {events === null ? <Fine>Loading…</Fine> : <ActivityTable events={events} />}
    </Panel>
  );
}

export function ActivityTable({ events }: { events: AuditEvent[] }) {
  if (events.length === 0) return <Fine>Nothing yet.</Fine>;
  return (
    <Table className="text-[12.5px]">
      <TableBody>
        {events.map((event) => (
          <TableRow key={event.id} className="hover-lift">
            <TableCell className="tabular-nums">{when(event.created_at)}</TableCell>
            <TableCell>{event.actor}</TableCell>
            <TableCell>
              <code className="font-mono">{event.kind}</code>
            </TableCell>
            <TableCell>{event.item_name ?? (event.detail && typeof event.detail.name === 'string' ? event.detail.name : '')}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** The current code, the seconds left, and a copy. Ticks once a second. */
function TOTPField({ totp }: { totp: TOTP }) {
  const [code, setCode] = useState('');
  const [remaining, setRemaining] = useState(totpSecondsRemaining(totp));
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const value = await totpCode(totp);
      if (!cancelled) {
        setCode(value);
        setRemaining(totpSecondsRemaining(totp));
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [totp]);
  const shown = code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
  return (
    <div className="grid gap-1">
      <span className="text-[11px] font-semibold tracking-[0.07em] text-muted-foreground uppercase">One-time code{totp.issuer ? ` · ${totp.issuer}` : ''}</span>
      <div className="flex min-h-9 items-center gap-2 rounded-md border bg-muted px-2.5 py-1.5 font-mono">
        <code className="min-w-0 flex-auto text-[22px] tracking-[0.06em]">{shown || '······'}</code>
        <span
          className={cn(
            'min-w-[26px] rounded-full border px-1.5 py-0.5 text-center font-sans text-[11px] text-muted-foreground tabular-nums',
            remaining <= 5 && 'border-(--error-border) text-(--danger-ink)',
          )}
          aria-label={`${remaining} seconds left`}
        >
          {remaining}
        </span>
        <Button variant="ghost" size="xs" className="flex-none font-sans text-muted-foreground" onClick={() => void copy(code, 'Code copied')} disabled={!code}>
          Copy
        </Button>
      </div>
    </div>
  );
}
