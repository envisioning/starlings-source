import { useEffect, useId, useState } from 'react';
import type { StaffKey } from '@keep/contracts';
import { Button } from '@/ui/button';
import { FormRow } from './form-row';
import * as session from './session';
import { ErrorNotice, Gate, SecretInput, errorMessage } from './parts';

/** The third gate: turn the wrapped private key into a live one, in memory. */
export function Unlock({ staffKey }: { staffKey: StaffKey }) {
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasPasskey = session.wrapFor(staffKey, 'prf') !== null;
  const hasPassphrase = session.wrapFor(staffKey, 'passphrase') !== null;
  const isPasskey = hasPasskey;
  const passphraseId = useId();

  async function withPasskey(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const ok = await session.unlockWithPasskey(staffKey);
      if (!ok) setError('Cancelled.');
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function withPassphrase(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await session.unlockWithPassphrase(staffKey, passphrase);
      setPassphrase('');
    } catch {
      setError('Wrong passphrase.');
    } finally {
      setBusy(false);
    }
  }

  // A passkey unlock is one tap; start it without asking.
  useEffect(() => {
    if (isPasskey) void withPasskey();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A gate is its controls alone (Meet's copy law): the passkey button, the
  // passphrase field, or both.
  return (
    <Gate title="Unlock Keep" inShell>
      {hasPasskey && (
        <Button className="w-fit" disabled={busy} onClick={() => void withPasskey()}>
          {busy ? 'Waiting…' : 'Unlock with passkey'}
        </Button>
      )}
      {hasPassphrase && (
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void withPassphrase();
          }}
        >
          <FormRow id={passphraseId} label="Passphrase" className="my-0">
            <SecretInput id={passphraseId} value={passphrase} onChange={setPassphrase} autoComplete="current-password" autoFocus />
          </FormRow>
          <Button className="w-fit" variant={hasPasskey ? 'outline' : 'default'} disabled={busy || passphrase.length === 0} type="submit">
            {busy ? 'Unlocking…' : 'Unlock'}
          </Button>
        </form>
      )}
      {error && <ErrorNotice message={error} />}
    </Gate>
  );
}
