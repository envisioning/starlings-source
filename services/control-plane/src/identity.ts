// Who an address is, for every connector (docs/CONNECTORS.md).
//
// Granola, the forwarded-mail door, and the Gmail and Drive imports all ask
// the same question of an address: is this one of us, a company we might
// know, a person on a consumer mailbox, or a machine. One answer lives here.
//
// Core asks the same question for its cc@ capture
// (core-web `src/lib/inbound/email-capture.ts`). Its free-mail list and its
// automated local parts are folded into the sets below, so an address Core
// would refuse to make an organization from is refused here too. Core
// creates contacts; this module never does. It only classifies.
import { isMemberEmail } from './workspace-identity';

/** The domain of an address, lowercased, or null. */
export function domainOf(address: string): string | null {
  const at = address.lastIndexOf('@');
  if (at <= 0 || at === address.length - 1) return null;
  return address.slice(at + 1).trim().toLowerCase();
}

/**
 * Addresses that name a person, not a company, matched on the first label so
 * `gmail.co.uk` and `hotmail.nl` count without listing every country. Core's
 * `FREE_MAIL_DOMAINS` plus the Brazilian providers Granola's guests use.
 */
const CONSUMER_STEMS = new Set([
  'gmail', 'googlemail', 'outlook', 'hotmail', 'live', 'msn', 'yahoo', 'ymail', 'rocketmail',
  'icloud', 'me', 'mac', 'proton', 'protonmail', 'pm', 'aol', 'gmx', 'web', 'mail',
  'fastmail', 'zoho', 'hey', 'yandex', 'qq', '163', '126',
  'uol', 'bol', 'terra', 'ig', 'globo', 'zipmail',
]);

/** Where a registrable domain is two labels deep: `nttdata.com.br`, not `com.br`. */
const TWO_LABEL_SUFFIXES = new Set([
  'com', 'co', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go',
]);

/** Machine senders, as Core's `AUTOMATED_LOCALPARTS`. Never a contact. */
const AUTOMATED_LOCAL_PARTS = [
  /^no-?reply$/u,
  /^do-?not-?reply$/u,
  /^mailer-daemon$/u,
  /^postmaster$/u,
  /^bounces?$/u,
  /^notifications?$/u,
  /^notify$/u,
  /^alerts?$/u,
  /^auto(mated)?$/u,
  /^daemon$/u,
  /^root$/u,
];

/**
 * The company's domain, from any host under it: `emeal.nttdata.com` and
 * `mail.nttdata.com` are one company, and `acme.com.br` keeps three labels
 * because `com.br` names nobody.
 */
export function registrableDomain(host: string): string {
  const labels = host.split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const secondLast = labels[labels.length - 2]!;
  const depth = TWO_LABEL_SUFFIXES.has(secondLast) ? 3 : 2;
  return labels.slice(-depth).join('.');
}

/** A consumer mailbox names a person, never a company. */
export function isConsumerDomain(domain: string): boolean {
  return CONSUMER_STEMS.has(domain.split('.')[0] ?? '');
}

/** A machine sender: `noreply@`, `notifications@`, a bounce. No address at all counts too. */
export function isAutomatedAddress(address: string | null | undefined): boolean {
  const normalized = address?.trim().toLowerCase();
  if (!normalized) return true;
  const local = normalized.slice(0, normalized.lastIndexOf('@'));
  // `bounces+1234@` is a bounce: the tag after `+` does not change who sent it.
  const bare = local.split('+')[0] ?? local;
  return AUTOMATED_LOCAL_PARTS.some((pattern) => pattern.test(bare));
}

/**
 * What an address is to a connector.
 *
 * - `member`: an Envisioning identity. A `people` row, never a contact.
 * - `org`: a company domain. `domain` is the registrable domain; whether it
 *   belongs to a mapped organization is the caller's question, not this one.
 * - `consumer`: a person on a consumer mailbox. Display text only.
 * - `automated`: a machine. Dropped.
 * - `invalid`: not an address.
 */
export type AddressKind = 'member' | 'org' | 'consumer' | 'automated' | 'invalid';

export interface AddressIdentity {
  kind: AddressKind;
  /** The registrable domain for `org` and `consumer`; null otherwise. */
  domain: string | null;
}

export function classifyAddress(env: Pick<Env, 'IDENTITY_DOMAINS'>, address: string | null | undefined): AddressIdentity {
  const normalized = address?.trim().toLowerCase() ?? '';
  const host = normalized ? domainOf(normalized) : null;
  if (!host) return { kind: 'invalid', domain: null };
  if (isMemberEmail(env, normalized)) return { kind: 'member', domain: null };
  if (isAutomatedAddress(normalized)) return { kind: 'automated', domain: null };
  const domain = registrableDomain(host);
  if (isConsumerDomain(domain)) return { kind: 'consumer', domain };
  return { kind: 'org', domain };
}
