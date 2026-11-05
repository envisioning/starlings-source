import { useEffect, useId, useState, type ReactNode } from 'react';
import type { DirectoryEntry, RecoveryKey } from '@keep/contracts';
import { exportPrivateKey, formatShare, generatePassphrase, generateStaffKeypair, splitSecret } from '@keep/crypto';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { Item, ItemContent, ItemDescription, ItemTitle } from '@/ui/item';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { api, type Me } from './api';
import { Enrol } from './Enrol';
import { CheckRow, FormRow } from './form-row';
import { enrolPasskey, passkeysSupported } from './passkey';
import * as session from './session';
import { ErrorNotice, Fine, PageHeader, Panel, Warning, copy, errorMessage, toast, when, SecretInput } from './parts';

export function Settings({ me, onReloadMe }: { me: Me; onReloadMe: () => void }) {
  const [recovery, setRecovery] = useState<RecoveryKey | null | 'loading'>('loading');
  const [directory, setDirectory] = useState<DirectoryEntry[]>([]);
  const [ceremony, setCeremony] = useState(false);
  const [reenrol, setReenrol] = useState(false);

  useEffect(() => {
    api.recovery().then((result) => setRecovery(result.recovery));
    api.directory().then((result) => setDirectory(result.entries));
  }, []);

  if (reenrol) {
    return (
      <Enrol
        me={me}
        replace
        onEnrolled={() => {
          setReenrol(false);
          onReloadMe();
        }}
      />
    );
  }

  return (
    <div className="max-w-[1100px]">
      <PageHeader title="Settings" meta={`Enrolled${me.key ? ` on ${when(me.key.created_at)}` : ''}.`} />

      <Section title="Recovery key">
        {recovery === 'loading' ? (
          <Fine>Loading…</Fine>
        ) : recovery ? (
          <>
            <p className="m-0 text-sm">
              Set by {recovery.created_by} on {when(recovery.created_at)}. Held by {recovery.holders.join(' and ')}.
            </p>
            <Fine>
              Every vault key is also wrapped to this key. If everyone in a vault loses their key, the two holders together can open it.
              Replacing it is a migration; there is no button.
            </Fine>
          </>
        ) : (
          <>
            <Warning>No recovery key. A vault whose members all lose their keys is lost. Set one now, before the first vault matters.</Warning>
            <Button className="w-fit" onClick={() => setCeremony(true)}>
              Create recovery key
            </Button>
          </>
        )}
      </Section>

      <Section title="Your key">
        <UnlockMethods me={me} onReloadMe={onReloadMe} />
        <Fine>
          Replacing your key removes you from every vault until a member adds you back. Do this if the device holding your passkey is
          gone, or the passphrase is known to someone else.
        </Fine>
        <Button className="w-fit" variant="outline" onClick={() => setReenrol(true)}>
          Replace my key
        </Button>
      </Section>

      <Section title="Enrolled">
        <ul className="m-0 grid max-w-[640px] list-none gap-1.5 p-0">
          {directory.map((entry) => (
            <li key={entry.email}>
              <Item variant="outline" size="sm" className="bg-(--surface-raised)">
                <ItemContent className="min-w-0 gap-0">
                  <ItemTitle className="w-full min-w-0">
                    <span className="truncate">
                      {entry.name} <span className="font-normal text-muted-foreground">({entry.email})</span>
                    </span>
                  </ItemTitle>
                  <ItemDescription className="text-[11.5px]">since {when(entry.enrolled_at)}</ItemDescription>
                </ItemContent>
              </Item>
            </li>
          ))}
        </ul>
      </Section>

      {ceremony && (
        <RecoveryCeremony
          directory={directory}
          me={me}
          onClose={() => setCeremony(false)}
          onDone={(key) => {
            setRecovery(key);
          }}
        />
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-8 grid gap-3">
      <h2 className="m-0 text-lg font-semibold tracking-[-0.01em]">{title}</h2>
      {children}
    </section>
  );
}

/**
 * One key, several ways to open it. The key is open in this tab, so it can
 * be sealed again under a passphrase or another passkey; a client that
 * cannot use passkeys (Meet for Mac, today) then unlocks with the
 * passphrase. Same key, same vaults.
 */
function UnlockMethods({ me, onReloadMe }: { me: Me; onReloadMe: () => void }) {
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [generated, setGenerated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const methods = me.key?.wraps.map((entry) => entry.wrap.method) ?? [];
  const hasPassphrase = methods.includes('passphrase');
  const hasPasskey = methods.includes('prf');
  const passphraseId = useId();
  const confirmId = useId();

  async function addPassphrase(): Promise<void> {
    setError(null);
    if (passphrase.length < 12) return setError('Use at least 12 characters.');
    if (passphrase !== confirm) return setError('The two passphrases differ.');
    setBusy(true);
    try {
      const { wrapped, wrap } = await session.rewrapWithPassphrase(passphrase);
      await api.addWrap({ wrapped_private_key: wrapped, wrap });
      setPassphrase('');
      setConfirm('');
      setGenerated(null);
      toast(hasPassphrase ? 'Passphrase changed' : 'Passphrase added');
      onReloadMe();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function addPasskey(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const passkey = await enrolPasskey(me.email, me.name);
      if (!passkey) return setError('This passkey does not support PRF.');
      const { wrapped, wrap } = await session.rewrapWithPRF(passkey.prf, passkey.credentialId);
      await api.addWrap({ wrapped_private_key: wrapped, wrap });
      toast(hasPasskey ? 'Passkey replaced' : 'Passkey added');
      onReloadMe();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid max-w-[440px] gap-3">
      <Fine>
        Unlocks with {hasPasskey && hasPassphrase ? 'a passkey or a passphrase' : hasPasskey ? 'a passkey' : 'a passphrase'}. The Meet app on
        the Mac needs a passphrase.
      </Fine>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void addPassphrase();
        }}
        className="grid gap-3"
      >
        <FormRow id={passphraseId} label={hasPassphrase ? 'New passphrase' : 'Passphrase'} className="my-0">
          <SecretInput id={passphraseId} value={passphrase} onChange={setPassphrase} />
        </FormRow>
        <FormRow id={confirmId} label="Again" className="my-0">
          <SecretInput id={confirmId} value={confirm} onChange={setConfirm} />
        </FormRow>
        {generated && (
          <div className="grid gap-1">
            <span className="text-[11px] font-semibold tracking-[0.07em] text-muted-foreground uppercase">Generated</span>
            <div className="flex min-h-9 items-center gap-2 rounded-md border bg-muted px-2.5 py-1.5 font-mono text-[13px]">
              <code className="min-w-0 flex-auto [overflow-wrap:anywhere]">{generated}</code>
              <Button type="button" variant="ghost" size="xs" className="flex-none font-sans text-muted-foreground" onClick={() => void copy(generated, 'Passphrase copied')}>
                Copy
              </Button>
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            type="button"
            onClick={() => {
              const value = generatePassphrase();
              setGenerated(value);
              setPassphrase(value);
              setConfirm(value);
            }}
          >
            Generate
          </Button>
          <Button type="submit" disabled={busy || passphrase.length === 0}>
            {hasPassphrase ? 'Change passphrase' : 'Add passphrase'}
          </Button>
          {passkeysSupported() && (
            <Button variant="outline" type="button" disabled={busy} onClick={() => void addPasskey()}>
              {hasPasskey ? 'Replace passkey' : 'Add passkey'}
            </Button>
          )}
        </div>
      </form>
      {error && <ErrorNotice message={error} />}
    </div>
  );
}

/**
 * The ceremony: make a keypair, split the private half into two shares,
 * show each once, publish the public half. The shares go to two people's
 * personal password managers and nowhere near this system. The private key
 * is discarded when the drawer closes.
 */
function RecoveryCeremony({ directory, me, onClose, onDone }: { directory: DirectoryEntry[]; me: Me; onClose: () => void; onDone: (key: RecoveryKey) => void }) {
  const [holderA, setHolderA] = useState(me.email);
  const [holderB, setHolderB] = useState('');
  const [shares, setShares] = useState<{ a: string; b: string; publicKey: string } | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = { a: useId(), b: useId(), consent: useId() };

  async function generate(): Promise<void> {
    setError(null);
    try {
      const pair = await generateStaffKeypair();
      const [a, b] = splitSecret(await exportPrivateKey(pair.privateKey));
      setShares({ a: formatShare('A', a), b: formatShare('B', b), publicKey: pair.publicKey });
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function publish(): Promise<void> {
    if (!shares) return;
    setBusy(true);
    setError(null);
    try {
      const key = await api.setRecovery({ suite: 'keep-v1', public_key: shares.publicKey, holders: [holderA, holderB] });
      onDone(key);
      onClose();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Recovery key" onClose={onClose}>
      {!shares ? (
        <>
          <Fine>Two holders. Each gets one share; both are needed. Existing vaults are not covered until a member re-wraps them.</Fine>
          <FormRow id={ids.a} label="Holder A" className="my-0">
            <NativeSelect id={ids.a} className="w-full" value={holderA} onChange={(event) => setHolderA(event.target.value)}>
              {directory.map((entry) => (
                <NativeSelectOption key={entry.email} value={entry.email}>
                  {entry.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </FormRow>
          <FormRow id={ids.b} label="Holder B" className="my-0">
            <NativeSelect id={ids.b} className="w-full" value={holderB} onChange={(event) => setHolderB(event.target.value)}>
              <NativeSelectOption value="">Choose…</NativeSelectOption>
              {directory
                .filter((entry) => entry.email !== holderA)
                .map((entry) => (
                  <NativeSelectOption key={entry.email} value={entry.email}>
                    {entry.name}
                  </NativeSelectOption>
                ))}
            </NativeSelect>
          </FormRow>
          {error && <ErrorNotice message={error} />}
          <Button className="w-fit" disabled={holderB === ''} onClick={() => void generate()}>
            Generate
          </Button>
        </>
      ) : (
        <>
          <Warning>Shown once. Copy each share into its holder’s personal password manager now. Closing this loses them.</Warning>
          <Share label={`Share A · ${holderA}`} value={shares.a} onCopy={() => void copy(shares.a, 'Share A copied')} copyLabel="Copy share A" />
          <Share label={`Share B · ${holderB}`} value={shares.b} onCopy={() => void copy(shares.b, 'Share B copied')} copyLabel="Copy share B" />
          <CheckRow id={ids.consent} label="Both shares are stored outside Keep, by their holders." className="my-3 text-[13px] text-muted-foreground">
            <Checkbox id={ids.consent} checked={acknowledged} onCheckedChange={(checked) => setAcknowledged(checked === true)} />
          </CheckRow>
          {error && <ErrorNotice message={error} />}
          <Button className="w-fit" disabled={!acknowledged || busy} onClick={() => void publish()}>
            {busy ? 'Publishing…' : 'Publish public key'}
          </Button>
        </>
      )}
    </Panel>
  );
}

/**
 * A recovery share, shown once. The box says so by looking like a card you
 * would put in a safe, not like a text field you might edit.
 */
function Share({ label, value, onCopy, copyLabel }: { label: string; value: string; onCopy: () => void; copyLabel: string }) {
  return (
    <div className="grid gap-1">
      <span className="text-[11px] font-semibold tracking-[0.07em] text-muted-foreground uppercase">{label}</span>
      <div className="rounded-md border border-dashed bg-muted px-3.5 py-3 font-mono text-xs [overflow-wrap:anywhere] select-all">{value}</div>
      <Button variant="ghost" size="xs" className="justify-self-start text-muted-foreground" onClick={onCopy}>
        {copyLabel}
      </Button>
    </div>
  );
}
