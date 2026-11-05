/**
 * The inbound email address a subject channel answers to:
 * `<slug>.<local>@<suffix>` (ADR 0004 decision 13). One Email Routing
 * catch-all on the the workspace domain apex takes every workspace's mail;
 * Cloudflare offers a catch-all only on an apex, so the workspace is the
 * prefix of the local part, not a subdomain. The slug comes from the
 * workspace's own origin (`workspace-origins.ts`); nothing is set per
 * workspace but the `INBOUND_EMAIL` switch.
 *
 * Two spellings of the local part resolve, and the channel header shows the
 * readable one:
 *
 * - a slug minted once from the subject's title (`acme-rollout`), stored on
 *   the channel's index row (`threads.inbound_local`);
 * - `p-<id>`, `l-<id>`, `pt-<id>`, `e-<id>` — the subject's kind and Core id, which
 *   need no row and cannot collide.
 *
 * The reserved `calendar@` and public `contact@` addresses have their own
 * flows. `calendar@` also lives on the workspace's own host,
 * `calendar@<slug>.<suffix>`: a literal Email Routing rule
 * on that subdomain sends it straight to this Worker. Nothing here talks to Core or to the Durable Object;
 * `inbound-email.ts` does that once the local part has named a subject.
 */

import { WORKSPACE_HOST_SUFFIX } from '@starlings/contracts/workspace-slug';
import { isWorkspaceFixedAddress, workspaceMailHost } from '@starlings/contracts/inbound-mail';
import { workspaceSlug, type WorkspaceOrigins } from './workspace-origins';

export type SubjectKind = 'project' | 'lead' | 'organization' | 'event';

const KIND_PREFIX: Record<SubjectKind, string> = { project: 'p', lead: 'l', organization: 'pt', event: 'e' };
const PREFIX_KIND: Record<string, SubjectKind> = { p: 'project', l: 'lead', pt: 'organization', e: 'event' };

const LOCAL_MAX_CHARS = 40;
const LOCAL_MIN_CHARS = 3;

/**
 * `calendar@` proposes events instead of naming a subject. No
 * subject slug may take it, and the same for the spellings a person might
 * try next, so a title "Calendar" gets its id spelling and the address stays
 * one thing.
 */
export const CALENDAR_LOCAL = 'calendar';
/** The public contact mailbox delivered into this workspace's Inbox. */
export const SUPPORT_LOCAL = 'contact';
export const SUPPORT_LOCALS = new Set([SUPPORT_LOCAL, 'support']);
const RESERVED_LOCALS = new Set([CALENDAR_LOCAL, ...SUPPORT_LOCALS, 'cal', 'events', 'postmaster', 'abuse', 'noreply', 'no-reply']);

/** Where this workspace takes mail: its slug, the shared domain, and whether channel mail reaches it. */
export interface InboundMailbox {
  slug: string;
  domain: string;
  /**
   * True when the apex catch-all reaches this Worker (`INBOUND_EMAIL` `on`),
   * so subject channels have addresses. False for `fixed`: only the fixed
   * addresses on the workspace's own host, `calendar@<slug>.<suffix>`
   *, whose literal rules reach every workspace's own Worker.
   */
  channels: boolean;
}

/**
 * This workspace's mailbox, or null while its mail is off: `INBOUND_EMAIL`
 * is neither `on` nor `fixed`, or no origin of the workspace is a
 * the workspace domain host.
 */
export function inboundMailbox(env: { INBOUND_EMAIL?: string | undefined } & WorkspaceOrigins): InboundMailbox | null {
  const mode = env.INBOUND_EMAIL?.trim().toLowerCase();
  if (mode !== 'on' && mode !== 'fixed') return null;
  const slug = workspaceSlug(env);
  return slug ? { slug, domain: WORKSPACE_HOST_SUFFIX, channels: mode === 'on' } : null;
}

/** The mailbox when subject channels have addresses (`INBOUND_EMAIL` `on`), else null. */
export function channelMailbox(env: { INBOUND_EMAIL?: string | undefined } & WorkspaceOrigins): InboundMailbox | null {
  const mailbox = inboundMailbox(env);
  return mailbox?.channels ? mailbox : null;
}

export function inboundAddress(mailbox: InboundMailbox, local: string): string {
  return `${mailbox.slug}.${local}@${mailbox.domain}`;
}

/**
 * The local part an envelope recipient names for this workspace. Two forms:
 * a fixed address on the workspace's own host (`calendar@<slug>.<suffix>`,
 *), and the prefix form on the apex (`envisioning.acme@<suffix>`),
 * whose prefix is dropped. `other_workspace` for another workspace's address
 * or another domain: the apex catch-all hands this Worker all of it until the
 * dispatch Worker sorts by slug. A channel address while only the fixed
 * addresses are on (`INBOUND_EMAIL` `fixed`) is `other_workspace` too.
 */
export function workspaceLocalPartOf(
  address: string,
  mailbox: InboundMailbox,
): { ok: true; local: string } | { ok: false; reason: 'bad_address' | 'other_workspace' } {
  const at = address.lastIndexOf('@');
  if (at <= 0) return { ok: false, reason: 'bad_address' };
  const domain = address.slice(at + 1).trim().toLowerCase();
  const full = address.slice(0, at).trim().toLowerCase();
  if (domain === workspaceMailHost(mailbox.slug)) {
    const local = localPartOf(address.trim().toLowerCase());
    if (!local) return { ok: false, reason: 'bad_address' };
    return isWorkspaceFixedAddress(local) ? { ok: true, local } : { ok: false, reason: 'other_workspace' };
  }
  const prefix = `${mailbox.slug}.`;
  if (domain !== mailbox.domain || !full.startsWith(prefix)) return { ok: false, reason: 'other_workspace' };
  const local = localPartOf(`${full.slice(prefix.length)}@${domain}`);
  if (!local) return { ok: false, reason: 'bad_address' };
  return mailbox.channels || isWorkspaceFixedAddress(local) ? { ok: true, local } : { ok: false, reason: 'other_workspace' };
}

/** The id spelling: always valid, never stored. */
export function idLocalPart(kind: SubjectKind, subjectId: string): string {
  return `${KIND_PREFIX[kind]}-${subjectId.toLowerCase()}`;
}

const ID_LOCAL = /^(p|l|pt)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u;

/** The subject an id-spelled local part names, or null for any other spelling. */
export function subjectOfIdLocalPart(local: string): { kind: SubjectKind; id: string } | null {
  const match = ID_LOCAL.exec(local.toLowerCase());
  if (!match) return null;
  return { kind: PREFIX_KIND[match[1]!]!, id: match[2]! };
}

/**
 * A title as a local part: ASCII letters, digits and single hyphens, at most
 * 40 characters, never one of the id spellings. Null when nothing readable
 * is left, in which case the id spelling is the address.
 */
export function slugLocalPart(title: string): string | null {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, LOCAL_MAX_CHARS)
    .replace(/-+$/u, '');
  if (slug.length < LOCAL_MIN_CHARS) return null;
  if (ID_LOCAL.test(slug) || RESERVED_LOCALS.has(slug)) return null;
  return slug;
}

/** `slug`, then `slug-2`, `slug-3`, … — the same base with a suffix that still fits. */
export function slugCandidate(base: string, attempt: number): string {
  if (attempt <= 1) return base;
  const suffix = `-${attempt}`;
  return `${base.slice(0, LOCAL_MAX_CHARS - suffix.length).replace(/-+$/u, '')}${suffix}`;
}

/** The local part of an envelope address, lowercased, or null when it is not one. */
export function localPartOf(address: string): string | null {
  const at = address.lastIndexOf('@');
  if (at <= 0) return null;
  const local = address.slice(0, at).trim().toLowerCase();
  // Plus-addressing is not an instruction here: `acme+anything@` is `acme@`.
  const plus = local.indexOf('+');
  const bare = plus > 0 ? local.slice(0, plus) : local;
  return /^[a-z0-9][a-z0-9-]{1,63}$/u.test(bare) ? bare : null;
}
