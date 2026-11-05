import { useId, useState } from 'react';
import { generateStaffKeypair, wrapPrivateKeyWithPRF, wrapPrivateKeyWithPassphrase } from '@keep/crypto';
import { Button } from '@/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/ui/tabs';
import { api, type Me } from './api';
import { FormRow } from './form-row';
import { enrolPasskey, passkeysSupported } from './passkey';
import * as session from './session';
import { ErrorNotice, Fine, Gate, errorMessage, SecretInput } from './parts';

const MIN_PASSPHRASE = 12;

/**
 * Enrolment: make a keypair in this browser, wrap the private half, send
 * the public half and the wrapped blob. The server learns nothing it could
 * use to open anything.
 *
 * `replace` is the re-enrol path from Settings: same ceremony, and every
 * vault membership is dropped server-side because the old wraps are dead.
 */
export function Enrol({ me, onEnrolled, replace = false }: { me: Me; onEnrolled: () => void; replace?: boolean }) {
  const [method, setMethod] = useState<'prf' | 'passphrase'>(passkeysSupported() ? 'prf' : 'passphrase');
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const passphraseId = useId();
  const confirmId = useId();

  // Called straight from the button's click, with nothing awaited before
  // it starts: WebAuthn needs the click's user activation, and Safari drops
  // it across an awaited fetch (deployment.ts).
  async function run(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const pair = await generateStaffKeypair();
      const sessionKey = pair.privateKey;

      if (method === 'prf') {
        const passkey = await enrolPasskey(me.email, me.name);
        if (!passkey) {
          setError('This passkey doesn’t support PRF. Use a passphrase, or another authenticator.');
          setMethod('passphrase');
          return;
        }
        const { wrapped, wrap } = await wrapPrivateKeyWithPRF(pair.privateKey, passkey.prf, passkey.credentialId);
        await api.enrol({ suite: 'keep-v1', public_key: pair.publicKey, wrapped_private_key: wrapped, wrap }, replace);
      } else {
        if (passphrase.length < MIN_PASSPHRASE) {
          setError(`Use at least ${MIN_PASSPHRASE} characters.`);
          return;
        }
        if (passphrase !== confirm) {
          setError('The two passphrases differ.');
          return;
        }
        const { wrapped, wrap } = await wrapPrivateKeyWithPassphrase(pair.privateKey, passphrase);
        await api.enrol({ suite: 'keep-v1', public_key: pair.publicKey, wrapped_private_key: wrapped, wrap }, replace);
      }
      await session.unlockWithFreshKey(sessionKey, pair.publicKey);
      onEnrolled();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Gate title={replace ? 'Replace your key' : 'Set up Keep'} inShell={replace}>
      <Fine>
        Keep makes a key on this device. The server stores a locked copy it can’t open. {replace && 'Replacing it removes you from every vault until a member adds you back.'}
      </Fine>
      {passkeysSupported() && (
        <Tabs value={method} onValueChange={(value) => setMethod(value === 'passphrase' ? 'passphrase' : 'prf')}>
          <TabsList>
            <TabsTrigger value="prf">Passkey</TabsTrigger>
            <TabsTrigger value="passphrase">Passphrase</TabsTrigger>
          </TabsList>
        </Tabs>
      )}
      {method === 'prf' ? (
        <Fine>Touch ID, Face ID or a security key unlocks Keep.</Fine>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run();
          }}
        >
          <FormRow id={passphraseId} label="Passphrase">
            <SecretInput id={passphraseId} value={passphrase} onChange={setPassphrase} />
          </FormRow>
          <FormRow id={confirmId} label="Again">
            <SecretInput id={confirmId} value={confirm} onChange={setConfirm} />
          </FormRow>
          <Fine>There is no reset. Forgetting it means the recovery key holders.</Fine>
        </form>
      )}
      {error && <ErrorNotice message={error} />}
      <Button className="w-fit" disabled={busy} onClick={() => void run()}>
        {busy ? 'Working…' : method === 'prf' ? 'Create passkey' : 'Set passphrase'}
      </Button>
    </Gate>
  );
}
