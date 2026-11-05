# Keep

`keep.org.example`. Where Envisioning keeps client credentials — the
staging database password, the CMS login, the vendor API key a person types
in by hand. It replaces the shared 1Password vaults for that job.

One property decides everything else in this repo:

> **The server cannot read a secret.** Not the Worker, not the database, not
> a person with every Cloudflare secret and a dump of D1. Every value is
> sealed on the client — browser or Meet app — under keys that only the
> vault's members hold.

That is the property 1Password has and a server-side vault does not. Keep
exists so that leaving 1Password is not a downgrade.

## What it is not

- **Not a password manager for personal accounts.** Your Google login stays
  in your own manager. Keep holds what a client or a project owns.
- **Not autofill.** There is no browser extension. You open Keep (web, or
  Work → Keep in the Meet app on Mac and iOS), reveal, copy. This is the
  cost of leaving 1Password, accepted on purpose: an extension is a second
  trusted computing base.
- **Not a person's secret for an agent.** A person's vault never gains an
  agent member. An agent's own service keys go in its **machine vault**
  (ADR 0007 in envisioning/meet): one per agent, the agent its only member.
  People add and replace those keys and never read them. Only the broker
  Worker uses them, with the agent's private key, which it holds.
  keep-api never does.
- **No personal access tokens, no CLI, no MCP.** The API accepts a session
  cookie from a Google sign-in, or a device token from Meet's exchange: a
  person's after Meet's Google sign-in, or an agent's (scope `agent`) for an
  address on Meet's roster. An agent token reaches two routes about itself.
  None of them opens anything.

## How it works

```
person ──Google sign-in──▶ Worker: who is asking          (cookie session)
person ──passkey / passphrase──▶ browser: unwrap private key   (never leaves the tab)
browser ──private key──▶ unwrap vault key                    (one per vault)
browser ──vault key──▶ open item                             (one reveal, one audit row)
```

| Thing | Where it lives | Who can open it |
| --- | --- | --- |
| Staff private key | D1, sealed under a key from the person's passkey (PRF) or passphrase (PBKDF2) | the person, on their own device |
| Vault key | D1, one copy per member, each wrapped to that member's public key | each member |
| Vault key, recovery copy | D1, wrapped to the org recovery public key | the two recovery holders, together |
| Item | D1, sealed under the vault key with `vault:item:version` as AAD | members |
| Item name and kind | D1, plaintext | anyone who can list the vault |
| Audit trail | D1, plaintext, no foreign keys | every staff user |

**Sharing** is wrapping the vault key to one more public key.
**Revoking** is a rotation: the remaining members' browser re-seals every item
under a fresh key and wraps it to everyone who stays. The server applies it
atomically and refuses a rotation that misses an item.
**Recovery** is a keypair whose private half is XOR-split into two shares
held by two named people, outside Keep. Both shares, or nothing.

The suite: ECDH P-256 for people, ECIES (ephemeral P-256 → HKDF-SHA256 →
AES-256-GCM) for wrapping, AES-256-GCM everywhere else, PBKDF2-SHA256 at
600 000 rounds for passphrases. All WebCrypto; no crypto dependency. The
code is `crypto/src/index.ts` and is short enough to read in one
sitting — do.

## Threat model

What a full compromise yields, by what was compromised:

| Compromised | Attacker gets |
| --- | --- |
| D1 dump | wrapped keys, ciphertext, names, audit trail. No plaintext. |
| D1 dump + every Worker secret | the same. There is no key on the server. |
| One person's session cookie | the vault list, item names, and every ciphertext that person can reach — still sealed. Reveals are audited under their name. |
| One person's device, unlocked | everything that person can open. Rotate their vaults; replace their key. |
| The deployment (someone ships malicious JS) | every vault the next person unlocks. **This is the ceiling**, the same one 1Password's web app and Bitwarden have. |
| An agent token | the agent's name and its vault's item count. No ciphertext, no wrap. |
| The broker | every machine vault value. **The property does not hold for machine vaults**, by design (ADR 0007 decision 4). It holds for every person's vault, which is why the two never mix. |

The last row is why the SPA is a separate deployment from Core and from
Starlings, why the CSP allows no inline and no remote script, why there are no
source maps in production, and why the bundle has no dependency that can
push an update into it. Whoever can deploy this SPA can read every vault
the next person unlocks.

Keep's source sits in the Starlings repository, so anyone who can land there
can change it. A landing does not deploy it: Keep is outside the automatic
fleet, and a person deploys it by hand from a commit they chose. Anyone can read
the code that runs here. Reading it does not reduce what the table says.

What it does not protect against, said plainly: someone who has already
copied the plaintext. Rotation at the vendor is the only answer, and the
audit log is how you know who to ask.

## Clients

Three, one enrolment, one set of vaults:

| Client | Where | Has |
| --- | --- | --- |
| Web SPA | `keep.workers.org.example` | everything, plus the recovery-key ceremony and 1Password import |
| Meet for iOS | Work → Keep… | enrol, unlock, vaults, items, members, activity |
| Meet for Mac | Work → Keep… | the same, in its own window |

The apps carry their own implementation of the crypto (`KeepKit` in
`envisioning/core-kit`), held to this one by `crypto/src/vectors.json`.

## Unlock

- **Passkey (default).** WebAuthn with the PRF extension. Touch ID, Face ID
  or a security key returns 32 stable bytes; HKDF turns them into the
  wrapping key. Safari 18+, Chrome 116+. Not every authenticator implements
  PRF; enrolment detects that and offers the passphrase path.
- **Passphrase.** PBKDF2-SHA256, 600 000 rounds, 12 characters minimum. No
  reset exists. Forgetting it means the recovery holders.

A passkey is bound to the origin it was made on. Moving Keep to a new host
re-enrols everyone. The host is decided before the first person enrols.

The unlocked private key is a non-extractable `CryptoKey` in tab memory.
Fifteen idle minutes lock. A tab hidden for two minutes locks. A reload
locks. Nothing is written to any browser storage.

## One-time codes

An item's `totp` field holds an `otpauth://` URI (or the bare base32 key
you pasted; it is stored as the URI). Every client computes the current
six digits on the device (RFC 6238) with a countdown and a copy; the
server never sees the secret or a code. Getting the secret in: paste it,
or the QR — the phone scans it with the camera, the Mac reads it from a
picture or a screenshot on the clipboard, the web reads a picture where
the browser can (`BarcodeDetector`). 1Password's export carries the URI,
so an imported login keeps its second factor.

## Import from 1Password

Per vault, in the Keep UI: **Import**, paste the output of

```
op item list --vault "Client A" --format json | op item get - --format json
```

The JSON is parsed and sealed in the browser. Then delete the items in
1Password. A half-migrated store is the state where people go back to
Slack DMs; track the import per client and finish each one.

What stays in 1Password: the recovery shares (in their holders' personal
vaults), the Cloudflare and Google secrets for this deployment, and
everyone's personal accounts.

## Meet and Core

Meet has a native Keep client (`KeepKit` + `KeepUI` in
`envisioning/core-kit`), reached from Work → Keep on Mac and iOS. It is a
second implementation of `crypto` in CryptoKit, and the two are
held to producing the same bytes: `crypto/src/vectors.json` is
generated here and checked by the Swift tests. The Meet Worker brokers a
device token the way it does for Docs; the app then talks to Keep
directly, unlocks with the same passkey (shared PRF over the associated
domain) or passphrase, and holds the private key in memory only.

Core's project page links out; a vault may carry a Core `project_id`,
which Keep renders as a link and never resolves.

## Layout

| Path | Owns |
| --- | --- |
| `contracts/` | Wire contract: zod schemas, types, the suite constants |
| `crypto/` | The client-side crypto. Runs in the browser and in Node. Never in the Worker. |
| `api/` | Cloudflare Worker, D1 schema, Google OAuth, audit |
| `web/` | Vite + React SPA |

How the pieces fit — key hierarchy, flows, routes, clients — is in
`docs/ARCHITECTURE.md`. Operational detail — commands, invariants, traps —
is in `AGENTS.md`.
