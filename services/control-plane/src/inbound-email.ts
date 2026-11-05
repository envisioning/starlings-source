/**
 * Email forwarded into a subject channel, or to `calendar@` for
 * the events it describes.
 *
 * Two doors reach `email()` below. The public one: `contact@` and `support@`
 * on `SUPPORT_EMAIL_DOMAIN`, open to anyone, into the sender's
 * private intake thread. Every other address is this workspace's own mail:
 * Cloudflare Email Routing hands every message on the workspace domain here, and
 * this workspace keeps the ones addressed `<slug>.<local>@`. The local part names a subject (`inbound-address.ts`), the
 * envelope sender must be a workspace member, and the result is one ordinary
 * `text` message from that member — headers of the original mail on top, its
 * body underneath, the raw `.eml` attached — written through the same
 * `appendInboundMessage` the webhook and the agents use, so it badges and
 * reorders like anything a person says.
 *
 * Every refusal is silent: no bounce, no reject, one log line with a reason.
 * One exception: a member's mail to `calendar@` gets a short answer, events
 * found or none (`replyToForwarder`).
 * A bounce would confirm an address to whoever probed it, and a member whose
 * mail did not land sees that in the channel, which is where they are looking.
 *
 * DKIM: Email Routing's `Authentication-Results` header is read when present
 * and refused when it says the sender's domain failed. Until a real delivery
 * has shown the header's exact shape, an absent result passes — the gate is
 * membership, and this only tightens it (open point 2).
 */
import PostalMime, { type Address, type Email } from 'postal-mime';
import { MESSAGE_TEXT_MAX_CHARS } from '@starlings/contracts/limits';
import { extractCalendarEvents } from './calendar-extract';
import { randomToken, sha256 } from './crypto';
import { CALENDAR_LOCAL, SUPPORT_LOCALS, inboundMailbox, localPartOf, subjectOfIdLocalPart, workspaceLocalPartOf } from './inbound-address';
import { domainOf } from './identity';
import { sendMail, withSenderName } from './mail';
import { hasPendingSource, storePendingEvents } from './pending-calendar-events';
import { recordInboundSupportEmail } from './support-intake';
import {
  appendInboundMessage,
  attachmentKey,
  inboundMessageId,
  memberByEmail,
  resolveSubjectThread,
  subjectOfInboundLocal,
  threadStub,
} from './threads';

/** The stored `.eml` — a client stays under this without knowing (5 MB). */
export const INBOUND_EMAIL_MAX_BYTES = 5 * 1_048_576;

export type InboundEmailDrop =
  | 'no_domain'
  | 'no_attachments'
  | 'bad_address'
  | 'other_workspace'
  | 'not_member'
  | 'dkim_failed'
  | 'rate_limited'
  | 'too_large'
  | 'unknown_subject'
  | 'unparseable'
  | 'no_extractor'
  | 'no_events';

export type InboundEmailOutcome =
  | { accepted: true; threadId: string; messageId: string; duplicate: boolean }
  /** `calendar@`: how many rows now wait on Home, or none because the same mail already did. */
  | { accepted: true; calendar: true; proposed: number; duplicate: boolean }
  | { accepted: false; reason: InboundEmailDrop };

/** What `email()` needs of a `ForwardableEmailMessage`; a test hands it a plain object. */
export interface InboundEmailMessage {
  from: string;
  to: string;
  headers: Headers;
  raw: ReadableStream<Uint8Array>;
  rawSize: number;
}

export async function handleInboundEmail(message: InboundEmailMessage, env: Env): Promise<InboundEmailOutcome> {
  const outcome = await accept(message, env);
  // Reason and size only — never the sender, the subject line or the body.
  console.log(JSON.stringify({
    level: 'info',
    message: outcome.accepted ? 'inbound-email.accepted' : 'inbound-email.dropped',
    ...(outcome.accepted ? { duplicate: outcome.duplicate } : { reason: outcome.reason }),
    ...(outcome.accepted && 'calendar' in outcome ? { calendar: true, proposed: outcome.proposed } : {}),
    bytes: message.rawSize,
  }));
  return outcome;
}

async function accept(message: InboundEmailMessage, env: Env): Promise<InboundEmailOutcome> {
  // The public contact address lives on a domain of its own
  // (`SUPPORT_EMAIL_DOMAIN`, e.g. the product site): plain `contact@`
  // and `support@`, no workspace prefix, open whether or not `INBOUND_EMAIL` is.
  // It is read before the mailbox, whose `<slug>.` prefix check would
  // otherwise drop it as `other_workspace`.
  const plainLocal = localPartOf(message.to);
  const supportDomain = env.SUPPORT_EMAIL_DOMAIN?.trim().toLowerCase();
  const toPublicSupport = !!plainLocal && !!supportDomain && SUPPORT_LOCALS.has(plainLocal)
    && domainOf(message.to.trim().toLowerCase()) === supportDomain;

  let local: string;
  if (toPublicSupport && plainLocal) {
    local = plainLocal;
  } else {
    // Everything else is this workspace's own mail: `<slug>.<local>@<suffix>`.
    const mailbox = inboundMailbox(env);
    if (!mailbox) return { accepted: false, reason: 'no_domain' };
    const recipient = workspaceLocalPartOf(message.to, mailbox);
    if (!recipient.ok) return { accepted: false, reason: recipient.reason };
    local = recipient.local;
  }
  const toCalendar = local === CALENDAR_LOCAL;
  const toSupport = SUPPORT_LOCALS.has(local);
  if (!toCalendar && !toSupport && !env.ATTACHMENTS) return { accepted: false, reason: 'no_attachments' };

  // Contact is the public support door. Every other address is member-only.
  // Use the envelope sender, not the `From:` header: the header is whatever
  // the client wrote, the envelope is what the sending server answered for.
  const senderAddress = message.from.trim().toLowerCase();
  if (toSupport) return acceptSupportEmail(message, env, senderAddress);
  const member = await memberByEmail(env, senderAddress);
  if (!member) return { accepted: false, reason: 'not_member' };
  if (dkimFailed(message.headers, domainOf(senderAddress))) return { accepted: false, reason: 'dkim_failed' };

  if (env.AGENT_LIMIT) {
    const { success } = await env.AGENT_LIMIT.limit({ key: `inbound-email:${member.sub}` });
    if (!success) return { accepted: false, reason: 'rate_limited' };
  }
  if (message.rawSize > INBOUND_EMAIL_MAX_BYTES) return { accepted: false, reason: 'too_large' };

  // The subject is resolved before the bytes are read: an address that names
  // nothing costs no parse. `calendar@` names no subject and skips this.
  let threadId: string | null = null;
  if (!toCalendar) {
    const subject = subjectOfIdLocalPart(local) ?? await subjectOfInboundLocal(env, local);
    if (!subject) return { accepted: false, reason: 'unknown_subject' };
    try {
      threadId = (await resolveSubjectThread(env, subject)).id;
    } catch {
      // Core does not have it, or the bridge is off: either way nothing lands.
      return { accepted: false, reason: 'unknown_subject' };
    }
  }

  const rawBuffer = await new Response(message.raw).arrayBuffer();
  const raw = new Uint8Array(rawBuffer);
  if (raw.byteLength > INBOUND_EMAIL_MAX_BYTES) return { accepted: false, reason: 'too_large' };
  let parsed: Email;
  try {
    parsed = await PostalMime.parse(raw, { forceRfc822Attachments: true, attachmentEncoding: 'arraybuffer' });
  } catch {
    return { accepted: false, reason: 'unparseable' };
  }
  const original = await originalOf(parsed);
  if (toCalendar || threadId === null) {
    const outcome = await proposeEvents(env, member.sub, parsed, original);
    await replyToForwarder(env, message.headers, member.email, parsed.subject, outcome);
    return outcome;
  }
  const text = formatMessage(original);

  // One message per Message-ID: a client that forwards twice writes once.
  // Without one (some clients strip it on forward) the raw bytes stand in.
  const key = parsed.messageId?.trim() || `sha:${await digestOf(rawBuffer)}`;
  const messageId = await inboundMessageId(threadId, `email:${key}`);

  const sender = { sub: member.sub, email: member.email, name: displayName(parsed.from, member.email) };
  const attachmentId = `att_${randomToken(16)}`;
  const thread = threadStub(env, threadId);
  await thread.stageAttachment(sender.sub, {
    id: attachmentId,
    name: emlFilename(original.subject),
    contentType: 'message/rfc822',
    bytes: raw.byteLength,
  }, Date.now());
  await env.ATTACHMENTS.put(attachmentKey(threadId, attachmentId), raw, {
    httpMetadata: { contentType: 'message/rfc822' },
  });

  const result = await appendInboundMessage(env, {
    threadId,
    messageId,
    sender,
    text,
    type: 'text',
    refs: [],
    attachmentIds: [attachmentId],
  });
  // A duplicate bound no attachment; the object it would have shown is dropped.
  if (result.duplicate) await env.ATTACHMENTS.delete(attachmentKey(threadId, attachmentId));
  return { accepted: true, threadId, messageId: result.messageId, duplicate: result.duplicate };
}

/** Public messages to contact@ land in the sender's private support thread. */
async function acceptSupportEmail(
  message: InboundEmailMessage,
  env: Env,
  senderAddress: string,
): Promise<InboundEmailOutcome> {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(senderAddress)) return { accepted: false, reason: 'unparseable' };
  if (dkimFailed(message.headers, domainOf(senderAddress))) return { accepted: false, reason: 'dkim_failed' };
  if (env.AGENT_LIMIT) {
    const { success } = await env.AGENT_LIMIT.limit({ key: `public-support:${(await sha256(senderAddress)).slice(0, 32)}` });
    if (!success) return { accepted: false, reason: 'rate_limited' };
  }
  if (message.rawSize > INBOUND_EMAIL_MAX_BYTES) return { accepted: false, reason: 'too_large' };
  const rawBuffer = await new Response(message.raw).arrayBuffer();
  if (rawBuffer.byteLength > INBOUND_EMAIL_MAX_BYTES) return { accepted: false, reason: 'too_large' };
  let parsed: Email;
  try {
    parsed = await PostalMime.parse(rawBuffer, { forceRfc822Attachments: true, attachmentEncoding: 'arraybuffer' });
  } catch {
    return { accepted: false, reason: 'unparseable' };
  }
  const original = await originalOf(parsed);
  const text = formatMessage(original);
  const key = parsed.messageId?.trim() || `sha:${await digestOf(rawBuffer)}`;
  const result = await recordInboundSupportEmail(env, {
    email: senderAddress,
    name: displayName(parsed.from, senderAddress),
    message: text,
    messageId: key,
  });
  return { accepted: true, ...result };
}

/**
 * `calendar@`: the forwarded mail goes to the extractor once, and
 * what it found waits on Home. The `.eml` is not attached, the text is not
 * kept. The digest is of the original's headers and text, not the raw bytes:
 * the same mail forwarded from two clients is one mail.
 */
async function proposeEvents(env: Env, ownerSub: string, parsed: Email, original: OriginalMail): Promise<InboundEmailOutcome> {
  if (!env.ANTHROPIC_API_KEY?.trim()) return { accepted: false, reason: 'no_extractor' };
  const hash = await digestOf(new TextEncoder().encode(formatMessage(original)).buffer as ArrayBuffer);
  if (await hasPendingSource(env, ownerSub, hash)) return { accepted: true, calendar: true, proposed: 0, duplicate: true };

  // A mail written to the address directly is its own body, not a note on one.
  const note = forwarderNote(parsed);
  const events = await extractCalendarEvents(env, {
    from: original.from,
    subject: original.subject,
    date: original.date,
    body: original.body,
    instructions: note && note !== original.body ? note : null,
    forwardedAt: parsed.date ?? null,
  });
  if (!events || events.length === 0) return { accepted: false, reason: 'no_events' };
  const ids = await storePendingEvents(env, ownerSub, { hash, subject: original.subject, from: original.from }, events);
  return { accepted: true, calendar: true, proposed: ids.length, duplicate: false };
}

/**
 * `calendar@` answers the member who wrote, so a forward never vanishes:
 * the events wait in Inbox, or the mail held none. Only after the member
 * gate, so a stranger learns nothing. Never to a mail that is itself
 * automatic, and the answer says it is automatic, so two robots cannot
 * write to each other forever. A failed send is logged, never fatal.
 */
async function replyToForwarder(
  env: Env,
  headers: Headers,
  to: string,
  subject: string | undefined,
  outcome: InboundEmailOutcome,
): Promise<void> {
  const text = forwarderReply(outcome, env.WEB_ORIGIN);
  if (!text || isAutomatic(headers)) return;
  try {
    await sendMail(env, {
      to,
      from: withSenderName(env.MAIL_FROM, 'Starlings'),
      subject: `Re: ${subject?.trim() || 'your email'}`,
      text,
      headers: { 'Auto-Submitted': 'auto-replied' },
    });
  } catch (error) {
    console.warn(JSON.stringify({ level: 'warn', message: 'inbound-email.reply_failed', error: String(error) }));
  }
}

/** The reply's text, or null when this outcome gets none. */
export function forwarderReply(outcome: InboundEmailOutcome, origin: string): string | null {
  const inbox = `${origin.replace(/\/$/u, '')}/work`;
  if (outcome.accepted && 'calendar' in outcome) {
    if (outcome.duplicate) return `The events in this email are already in your Inbox.\n\n${inbox}`;
    const count = outcome.proposed === 1 ? '1 event' : `${outcome.proposed} events`;
    return `${count} from this email ${outcome.proposed === 1 ? 'is' : 'are'} in your Inbox. Add or discard ${outcome.proposed === 1 ? 'it' : 'them'} there.\n\n${inbox}`;
  }
  if (!outcome.accepted && outcome.reason === 'no_events') return 'Starlings found no event in this email.';
  return null;
}

/** RFC 3834 `Auto-Submitted`, and the older `Precedence` lists and robots still send. */
export function isAutomatic(headers: Headers): boolean {
  const submitted = headers.get('auto-submitted')?.trim().toLowerCase();
  if (submitted && submitted !== 'no') return true;
  const precedence = headers.get('precedence')?.trim().toLowerCase();
  return precedence === 'bulk' || precedence === 'junk' || precedence === 'list' || precedence === 'auto_reply';
}

/**
 * What the member typed above the forwarded mail — instructions to the
 * extractor ("only the outbound leg"). Null when the forward carries the
 * original as an attachment and the outer body is empty, or when nothing
 * stands before the marker.
 */
export function forwarderNote(mail: Email): string | null {
  const text = plainText(mail);
  let end = text.length;
  for (const marker of FORWARD_MARKERS) {
    const match = marker.exec(text);
    if (match && match.index < end) end = match.index;
  }
  const note = stripQuoted(text.slice(0, end)).trim();
  return note ? note.slice(0, 2_000) : null;
}

// MARK: - What the message says

export interface OriginalMail {
  from: string | null;
  subject: string | null;
  date: string | null;
  body: string;
}

/**
 * The mail the member meant: the one they forwarded, when it can be told
 * apart from their own — an attached `message/rfc822` part (Apple Mail
 * "Forward as Attachment", Outlook), or a Gmail / Apple Mail forwarding
 * block inline in the body. Otherwise the message itself, which is what a
 * member writing to the address directly gets.
 */
async function originalOf(mail: Email): Promise<OriginalMail> {
  const attached = mail.attachments.find((part) => part.mimeType === 'message/rfc822' && part.content);
  if (attached) {
    try {
      const inner = await PostalMime.parse(attached.content, { forceRfc822Attachments: true });
      return {
        from: addressLine(inner.from),
        subject: inner.subject?.trim() || null,
        date: inner.date ?? null,
        body: stripQuoted(plainText(inner)),
      };
    } catch {
      // Fall through to the outer message.
    }
  }
  const text = plainText(mail);
  const inline = forwardedBlock(text);
  if (inline) return inline;
  return {
    from: addressLine(mail.from),
    subject: unprefixed(mail.subject),
    date: mail.date ?? null,
    body: stripQuoted(text),
  };
}

const FORWARD_MARKERS = [
  /^-{2,}\s*Forwarded message\s*-{2,}\s*$/imu,
  /^Begin forwarded message:\s*$/imu,
  /^-{2,}\s*Original Message\s*-{2,}\s*$/imu,
];

/** Gmail, Apple Mail and Outlook all write the original's headers as lines after a marker. */
export function forwardedBlock(text: string): OriginalMail | null {
  let start = -1;
  for (const marker of FORWARD_MARKERS) {
    const match = marker.exec(text);
    if (match && (start === -1 || match.index < start)) start = match.index + match[0].length;
  }
  if (start === -1) return null;
  const rest = text.slice(start).replace(/^\s+/u, '');
  const lines = rest.split('\n');
  const headers: Record<string, string> = {};
  let index = 0;
  for (; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (line === '') {
      if (Object.keys(headers).length > 0) break;
      continue;
    }
    const header = /^\*?(From|Date|Subject|To|Cc|Sent|Reply-To)\*?:\s*(.*)$/iu.exec(line);
    if (!header) {
      if (Object.keys(headers).length > 0) break;
      return null;
    }
    headers[header[1]!.toLowerCase()] = header[2]!.replace(/^\*|\*$/gu, '').trim();
  }
  if (!headers.from) return null;
  return {
    from: headers.from,
    subject: headers.subject ?? null,
    date: headers.date ?? headers.sent ?? null,
    body: stripQuoted(lines.slice(index).join('\n')),
  };
}

function plainText(mail: Email): string {
  const text = mail.text?.trim();
  if (text) return normalizeNewlines(text);
  return htmlToText(mail.html ?? '');
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/gu, '\n');
}

/** Enough of HTML to read a mail that sent no text part: blocks become lines, tags go. */
export function htmlToText(html: string): string {
  const withBreaks = html
    .replace(/<\s*(style|script)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/giu, '')
    .replace(/<\s*(br|\/p|\/div|\/tr|\/li|\/h[1-6])\b[^>]*>/giu, '\n')
    .replace(/<[^>]+>/gu, '');
  return decodeEntities(withBreaks)
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/gu, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (whole, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith('#x')) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith('#')) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
    return named[lower] ?? whole;
  });
}

/**
 * The reply chain is not the message: quoted lines go, and so does everything
 * from the first "On … wrote:" or a second forwarding marker down.
 */
export function stripQuoted(text: string): string {
  const lines = normalizeNewlines(text).split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    if (/^On .{4,200} wrote:\s*$/u.test(line.trim())) break;
    if (FORWARD_MARKERS.some((marker) => marker.test(line))) break;
    if (line.trimStart().startsWith('>')) continue;
    kept.push(line.replace(/\s+$/u, ''));
  }
  return kept.join('\n').replace(/\n{3,}/gu, '\n\n').trim();
}

function addressLine(address: Address | undefined): string | null {
  if (!address) return null;
  if (address.group) return address.name || null;
  const name = address.name?.trim();
  if (name && address.address) return `${name} <${address.address}>`;
  return address.address || name || null;
}

/** The forwarder's own name, as their client sent it; their address otherwise. */
function displayName(from: Address | undefined, fallback: string): string {
  const name = from && !from.group ? from.name?.trim() : '';
  return name || fallback.slice(0, fallback.indexOf('@'));
}

function unprefixed(subject: string | undefined): string | null {
  const bare = (subject ?? '').replace(/^\s*((fwd?|fw|re|aw|wg)\s*:\s*)+/iu, '').trim();
  return bare || null;
}

/**
 * Header block, blank line, body. The block is what a reader needs to place
 * the mail without opening the `.eml`; the body is cut to the message limit
 * so a long thread still lands rather than being refused.
 */
export function formatMessage(original: OriginalMail): string {
  const head = [
    original.from ? `From: ${original.from}` : null,
    original.subject ? `Subject: ${original.subject}` : null,
    original.date ? `Date: ${original.date}` : null,
  ].filter((line): line is string => line !== null);
  const body = original.body || '(no text)';
  const text = head.length > 0 ? `${head.join('\n')}\n\n${body}` : body;
  if (text.length <= MESSAGE_TEXT_MAX_CHARS) return text;
  return `${text.slice(0, MESSAGE_TEXT_MAX_CHARS - 1).trimEnd()}…`;
}

function emlFilename(subject: string | null): string {
  const base = (subject ?? 'email')
    .replace(/[\\/:*?"<>|]/gu, ' ')
    .replace(/[\p{Cc}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 80);
  return `${base || 'email'}.eml`;
}

// MARK: - Gates

/**
 * `Authentication-Results: mx.cloudflare.net; dkim=pass header.d=example.com; …`
 * Refused only on an explicit failure for the sender's own domain. No header,
 * no `dkim=` clause, or a pass for another domain (a mailing list re-signing)
 * all pass through to the membership gate.
 */
export function dkimFailed(headers: Headers, senderDomain: string | null): boolean {
  if (!senderDomain) return false;
  const results = headers.get('authentication-results');
  if (!results) return false;
  const clauses = results.split(';').map((clause) => clause.trim().toLowerCase());
  for (const clause of clauses) {
    const match = /^dkim=(\w+)(.*)$/u.exec(clause);
    if (!match) continue;
    const domain = /header\.(?:d|i)=@?(\S+)/u.exec(match[2]!)?.[1];
    if (domain && domain !== senderDomain && !domain.endsWith(`.${senderDomain}`)) continue;
    return match[1] !== 'pass';
  }
  return false;
}

async function digestOf(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
