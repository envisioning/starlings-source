// Generate cross-implementation vectors. The Swift client (core-kit/KeepKit)
// must open every blob here with the keys given. Run:
//
//   node --experimental-strip-types scripts/vectors.ts > src/vectors.json
//
// Regenerate only when the suite changes; the Swift tests read the file
// checked in here by path, so a new file is a new commit on both sides.

import {
  exportPrivateKey,
  generateStaffKeypair,
  generateVaultKey,
  importVaultKey,
  randomBytes,
  sealItem,
  toBase64URL,
  wrapKeyToPublicKey,
  wrapPrivateKeyWithPassphrase,
  wrapPrivateKeyWithPRF,
} from '../src/index.ts';

const staff = await generateStaffKeypair();
const recipient = await generateStaffKeypair();
const vaultKeyBytes = generateVaultKey();
const vaultKey = await importVaultKey(vaultKeyBytes);
const vaultId = '11111111-2222-4333-8444-555555555555';
const itemId = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const body = { username: 'ops@client.example', password: 'correct horse battery staple', url: 'https://db.client.example', notes: 'line one\nline two — ünïcödé', totp: '' };
const passphrase = 'a passphrase for the vectors';
const prf = randomBytes(32);

const vectors = {
  suite: 'keep-v1',
  staff: {
    public_key: staff.publicKey,
    private_key_pkcs8: toBase64URL(await exportPrivateKey(staff.privateKey)),
  },
  recipient: {
    public_key: recipient.publicKey,
    private_key_pkcs8: toBase64URL(await exportPrivateKey(recipient.privateKey)),
  },
  vault: {
    id: vaultId,
    key: toBase64URL(vaultKeyBytes),
    key_version: 3,
    wrapped_to_recipient: await wrapKeyToPublicKey(vaultKeyBytes, recipient.publicKey),
  },
  item: {
    id: itemId,
    body,
    sealed: await sealItem(vaultKey, vaultId, itemId, 3, body),
  },
  passphrase: {
    value: passphrase,
    ...(await wrapPrivateKeyWithPassphrase(staff.privateKey, passphrase)),
  },
  prf: {
    output: toBase64URL(prf),
    ...(await wrapPrivateKeyWithPRF(staff.privateKey, prf, 'vector-credential')),
  },
};

console.log(JSON.stringify(vectors, null, 2));
