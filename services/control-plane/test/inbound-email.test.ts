// Email forwarded into a subject channel (meet#216).
import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InboxResponse, ThreadMessagesResponse, ThreadSummary } from '@starlings/contracts';
import {
  dkimFailed,
  formatMessage,
  forwardedBlock,
  handleInboundEmail,
  htmlToText,
  INBOUND_EMAIL_MAX_BYTES,
  stripQuoted,
  type InboundEmailMessage,
} from '../src/inbound-email';
import { channelMailbox, idLocalPart, inboundMailbox, localPartOf, slugCandidate, slugLocalPart, subjectOfIdLocalPart, workspaceLocalPartOf } from '../src/inbound-address';
import { recordOwnerSignIn } from '../src/usage';
import { withInboundMailbox } from './inbound-mailbox';

withInboundMailbox();

const rosa = { sub: 'dev:ie-rosa@example.com', email: 'ie-rosa@example.com', name: 'Rosa' };
const projectId = 'c0ffee00-0000-4000-8000-0000000000e1';
const CORE_SECRET = 'core-test-secret-with-at-least-32-characters';

/** The bridge on, and Core answering from a script rather than the network. */
function withCore(answer: (url: string) => Response): () => void {
  const configured = (env as Env).INTERNAL_REQUEST_SECRET;
  (env as Env).INTERNAL_REQUEST_SECRET = CORE_SECRET;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    return answer(url);
  });
  return () => { (env as Env).INTERNAL_REQUEST_SECRET = configured ?? ''; };
}

const subjectAnswer = () => new Response(JSON.stringify({
  ok: true,
  subject: { id: projectId, kind: 'project', title: 'Acme rollout', subtitle: 'Acme' },
}), { headers: { 'content-type': 'application/json' } });

const notFound = () => new Response(JSON.stringify({ ok: true, subject: null, subjects: [] }), {
  headers: { 'content-type': 'application/json' },
});

async function member() {
  await recordOwnerSignIn(env as Env, rosa, 'mac');
  const response = await exports.default.fetch(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: rosa.name, email: rosa.email }),
  }));
  const body = await response.json<{ access_token: string }>();
  return { authorization: `Bearer ${body.access_token}`, 'content-type': 'application/json' };
}

async function openChannel(headers: Record<string, string>): Promise<ThreadSummary> {
  const response = await exports.default.fetch(new Request('http://local/api/threads', {
    method: 'POST',
    headers,
    body: JSON.stringify({ kind: 'project', subject_id: projectId }),
  }));
  expect(response.status).toBe(200);
  return (await response.json<{ thread: ThreadSummary }>()).thread;
}

async function messages(headers: Record<string, string>, id: string) {
  const response = await exports.default.fetch(
    new Request(`http://local/api/threads/${id}/messages`, { headers }),
  );
  return (await response.json<ThreadMessagesResponse>()).messages;
}

function rawMail(options: {
  from?: string;
  to?: string;
  subject?: string;
  messageId?: string | null;
  text?: string;
  html?: string;
}): string {
  const lines = [
    `From: ${options.from ?? `Rosa <${rosa.email}>`}`,
    `To: ${options.to ?? 'meet-test.acme-rollout@starlings.example'}`,
    `Subject: ${options.subject ?? 'Fwd: Kickoff date'}`,
    'Date: Thu, 18 Sep 2026 09:00:00 +0200',
    ...(options.messageId === null ? [] : [`Message-ID: <${options.messageId ?? 'abc123@mail.example'}>`]),
    'MIME-Version: 1.0',
  ];
  if (options.html) {
    lines.push('Content-Type: text/html; charset=utf-8', '', options.html);
  } else {
    lines.push('Content-Type: text/plain; charset=utf-8', '', options.text ?? 'Hello');
  }
  return lines.join('\r\n');
}

/** The generated Env spells the domain as a literal; tests flip it off and on. */
type MutableEnv = Omit<Env, 'INBOUND_EMAIL'> & { INBOUND_EMAIL: string };

function envelope(raw: string, overrides: Partial<Omit<InboundEmailMessage, 'raw'>> = {}): InboundEmailMessage {
  const bytes = new TextEncoder().encode(raw);
  return {
    from: rosa.email,
    to: 'meet-test.acme-rollout@starlings.example',
    headers: new Headers(),
    raw: new Response(bytes).body!,
    rawSize: bytes.byteLength,
    ...overrides,
  };
}

const GMAIL_FORWARD = [
  'FYI, this is the client.',
  '',
  '---------- Forwarded message ---------',
  'From: Ana Lima <ana@acme.example>',
  'Date: Wed, 17 Sep 2026 at 16:02',
  'Subject: Kickoff date',
  'To: Rosa <rosa@example.com>',
  '',
  'Can we start on the 29th?',
  '',
  'Ana',
  '',
  'On Tue, 16 Sep 2026 at 10:00, Rosa <rosa@example.com> wrote:',
  '> Which week works for you?',
].join('\n');

afterEach(async () => {
  vi.unstubAllGlobals();
  await env.USAGE.prepare('DELETE FROM thread_members').run();
  await env.USAGE.prepare('DELETE FROM threads').run();
  await env.USAGE.prepare("DELETE FROM people WHERE email LIKE 'ie-%'").run();
});

describe('the address', () => {
  it('spells a subject by kind and id, and reads it back', () => {
    expect(idLocalPart('project', projectId)).toBe(`p-${projectId}`);
    expect(subjectOfIdLocalPart(`P-${projectId.toUpperCase()}`)).toEqual({ kind: 'project', id: projectId });
    expect(subjectOfIdLocalPart(`pt-${projectId}`)).toEqual({ kind: 'organization', id: projectId });
    expect(subjectOfIdLocalPart('acme-rollout')).toBeNull();
  });

  it('makes a slug from a title, and refuses one that would read as an id', () => {
    expect(slugLocalPart('Acme rollout')).toBe('acme-rollout');
    expect(slugLocalPart('  Café — Été 2026!  ')).toBe('cafe-ete-2026');
    expect(slugLocalPart('a')).toBeNull();
    expect(slugLocalPart('!!!')).toBeNull();
    expect(slugLocalPart(`p-${projectId}`)).toBeNull();
    expect(slugLocalPart('contact')).toBeNull();
    expect(slugLocalPart('support')).toBeNull();
    expect(slugLocalPart('x'.repeat(60))).toHaveLength(40);
    expect(slugCandidate('acme-rollout', 1)).toBe('acme-rollout');
    expect(slugCandidate('acme-rollout', 3)).toBe('acme-rollout-3');
    expect(slugCandidate('x'.repeat(40), 12)).toHaveLength(40);
  });

  it('reads the local part of an envelope address, ignoring plus tags', () => {
    expect(localPartOf('Acme-Rollout@in.meet.test')).toBe('acme-rollout');
    expect(localPartOf('acme-rollout+anything@in.meet.test')).toBe('acme-rollout');
    expect(localPartOf('no-at-sign')).toBeNull();
    expect(localPartOf('"quoted local"@in.meet.test')).toBeNull();
  });

  it('derives the mailbox from the workspace slug, and keeps only its own prefix (meet#1056)', () => {
    const origins = { WEB_ORIGIN: 'https://envisioning.starlings.example', WORKSPACE_ORIGIN_ALIASES: '' };
    expect(inboundMailbox({ ...origins, INBOUND_EMAIL: 'off' })).toBeNull();
    expect(inboundMailbox({ WEB_ORIGIN: 'http://127.0.0.1:5173', INBOUND_EMAIL: 'on' })).toBeNull();
    const mailbox = inboundMailbox({ ...origins, INBOUND_EMAIL: 'on' })!;
    expect(mailbox).toEqual({ slug: 'envisioning', domain: 'starlings.example', channels: true });

    expect(workspaceLocalPartOf('Envisioning.Calendar@Starlings.Example', mailbox)).toEqual({ ok: true, local: 'calendar' });
    expect(workspaceLocalPartOf('envisioning.acme-rollout+fwd@starlings.example', mailbox)).toEqual({ ok: true, local: 'acme-rollout' });
    // Another workspace's mail reaches this Worker through the shared catch-all and is dropped.
    expect(workspaceLocalPartOf('hq.calendar@starlings.example', mailbox)).toEqual({ ok: false, reason: 'other_workspace' });
    expect(workspaceLocalPartOf('envisioning.calendar@example.net', mailbox)).toEqual({ ok: false, reason: 'other_workspace' });
    expect(workspaceLocalPartOf('envisioning.@starlings.example', mailbox)).toEqual({ ok: false, reason: 'bad_address' });
  });

  it('takes a fixed address on the workspace\'s own host, and with INBOUND_EMAIL fixed only those (meet#1184)', () => {
    const origins = { WEB_ORIGIN: 'https://envisioning.starlings.example', WORKSPACE_ORIGIN_ALIASES: '' };
    const all = inboundMailbox({ ...origins, INBOUND_EMAIL: 'on' })!;
    expect(workspaceLocalPartOf('Calendar@Envisioning.Starlings.Example', all)).toEqual({ ok: true, local: 'calendar' });
    // A subdomain takes literal rules only; a channel address there is not this Worker's.
    expect(workspaceLocalPartOf('acme-rollout@envisioning.starlings.example', all)).toEqual({ ok: false, reason: 'other_workspace' });
    expect(workspaceLocalPartOf('calendar@hq.starlings.example', all)).toEqual({ ok: false, reason: 'other_workspace' });

    const fixed = inboundMailbox({ ...origins, INBOUND_EMAIL: 'fixed' })!;
    expect(fixed).toEqual({ slug: 'envisioning', domain: 'starlings.example', channels: false });
    expect(channelMailbox({ ...origins, INBOUND_EMAIL: 'fixed' })).toBeNull();
    expect(channelMailbox({ ...origins, INBOUND_EMAIL: 'on' })).toEqual(all);
    expect(workspaceLocalPartOf('calendar@envisioning.starlings.example', fixed)).toEqual({ ok: true, local: 'calendar' });
    expect(workspaceLocalPartOf('envisioning.calendar@starlings.example', fixed)).toEqual({ ok: true, local: 'calendar' });
    expect(workspaceLocalPartOf('envisioning.acme-rollout@starlings.example', fixed)).toEqual({ ok: false, reason: 'other_workspace' });
  });

  it('is minted when a member opens the channel, and shows on the summary', async () => {
    const restore = withCore(subjectAnswer);
    try {
      const headers = await member();
      const thread = await openChannel(headers);
      expect(thread.inbound_address).toBe('meet-test.acme-rollout@starlings.example');
      // Opening again keeps it: the address is on people's clipboards.
      const again = await openChannel(headers);
      expect(again.inbound_address).toBe('meet-test.acme-rollout@starlings.example');
    } finally {
      restore();
    }
  });

  it('is absent on a DM and while the deployment has no email domain', async () => {
    const restore = withCore(subjectAnswer);
    const inbound = (env as MutableEnv).INBOUND_EMAIL;
    try {
      const headers = await member();
      await recordOwnerSignIn(env as Env, { sub: 'dev:ie-ada@example.com', email: 'ie-ada@example.com', name: 'Ada' }, 'mac');
      const dm = await exports.default.fetch(new Request('http://local/api/threads', {
        method: 'POST',
        headers,
        body: JSON.stringify({ peer_email: 'ie-ada@example.com' }),
      }));
      expect(dm.status).toBe(200);
      expect((await dm.json<{ thread: ThreadSummary }>()).thread.inbound_address).toBeUndefined();

      (env as MutableEnv).INBOUND_EMAIL = 'off';
      const thread = await openChannel(headers);
      expect(thread.inbound_address).toBeUndefined();
      // `fixed` takes calendar@ on the workspace's host only; channels have no address (meet#1184).
      (env as MutableEnv).INBOUND_EMAIL = 'fixed';
      expect((await openChannel(headers)).inbound_address).toBeUndefined();
    } finally {
      (env as MutableEnv).INBOUND_EMAIL = inbound;
      restore();
    }
  });
});

describe('the body', () => {
  it('lifts the original out of a Gmail forwarding block and drops the reply chain', () => {
    const original = forwardedBlock(GMAIL_FORWARD);
    expect(original).toEqual({
      from: 'Ana Lima <ana@acme.example>',
      subject: 'Kickoff date',
      date: 'Wed, 17 Sep 2026 at 16:02',
      body: 'Can we start on the 29th?\n\nAna',
    });
    expect(formatMessage(original!)).toBe(
      'From: Ana Lima <ana@acme.example>\nSubject: Kickoff date\nDate: Wed, 17 Sep 2026 at 16:02\n\nCan we start on the 29th?\n\nAna',
    );
  });

  it('reads an Apple Mail block, whose header names are bold', () => {
    const text = 'Begin forwarded message:\n\n*From:* Ana <ana@acme.example>\n*Subject:* Hi\n*Date:* 1 Jan\n\nBody here';
    expect(forwardedBlock(text)).toMatchObject({ from: 'Ana <ana@acme.example>', subject: 'Hi', body: 'Body here' });
  });

  it('is the mail itself when nothing was forwarded', () => {
    expect(forwardedBlock('Just a note to the channel.')).toBeNull();
    expect(stripQuoted('Line\n> quoted\nMore\n\nOn 1 Jan, X wrote:\n> old')).toBe('Line\nMore');
  });

  it('reads HTML when there is no text part', () => {
    expect(htmlToText('<div>Hello&nbsp;<b>world</b></div><p>Second &amp; last</p><style>p{}</style>'))
      .toBe('Hello world\nSecond & last');
  });

  it('cuts a long body at the message limit', () => {
    const text = formatMessage({ from: null, subject: null, date: null, body: 'x'.repeat(10_000) });
    expect(text).toHaveLength(4000);
    expect(text.endsWith('…')).toBe(true);
  });
});

describe('DKIM', () => {
  const results = (value: string) => new Headers({ 'authentication-results': value });

  it('refuses only an explicit failure for the sender’s own domain', () => {
    expect(dkimFailed(results('mx.cloudflare.net; dkim=pass header.d=org.example'), 'org.example')).toBe(false);
    expect(dkimFailed(results('mx.cloudflare.net; dkim=fail header.d=org.example'), 'org.example')).toBe(true);
    expect(dkimFailed(results('mx.cloudflare.net; dkim=none'), 'org.example')).toBe(true);
    // A list re-signing for its own domain says nothing about the sender's.
    expect(dkimFailed(results('mx; dkim=fail header.d=lists.example'), 'org.example')).toBe(false);
    expect(dkimFailed(new Headers(), 'org.example')).toBe(false);
    expect(dkimFailed(results('mx; spf=pass'), 'org.example')).toBe(false);
  });
});

describe('a member forwarding', () => {
  it('lands one message from them with the .eml attached, once per Message-ID', async () => {
    const restore = withCore(subjectAnswer);
    try {
      const headers = await member();
      const thread = await openChannel(headers);

      const first = await handleInboundEmail(envelope(rawMail({ text: GMAIL_FORWARD })), env as Env);
      expect(first).toMatchObject({ accepted: true, threadId: thread.id, duplicate: false });
      const second = await handleInboundEmail(envelope(rawMail({ text: GMAIL_FORWARD })), env as Env);
      expect(second).toMatchObject({ accepted: true, duplicate: true });

      const rows = await messages(headers, thread.id);
      const landed = rows.filter((row) => row.text.startsWith('From: Ana Lima'));
      expect(landed).toHaveLength(1);
      expect(landed[0]).toMatchObject({
        type: 'text',
        sender_email: rosa.email,
        sender_name: 'Rosa',
        text: 'From: Ana Lima <ana@acme.example>\nSubject: Kickoff date\nDate: Wed, 17 Sep 2026 at 16:02\n\nCan we start on the 29th?\n\nAna',
      });
      expect(landed[0]!.attachments).toEqual([
        expect.objectContaining({ name: 'Kickoff date.eml', content_type: 'message/rfc822' }),
      ]);

      // The .eml is served like any attachment, bytes intact.
      const attachment = landed[0]!.attachments![0]!;
      const served = await exports.default.fetch(
        new Request(`http://local/api/threads/${thread.id}/attachments/${attachment.id}`, { headers }),
      );
      expect(served.status).toBe(200);
      expect(await served.text()).toBe(rawMail({ text: GMAIL_FORWARD }));

      // A member talking: the list badges and reorders.
      const indexed = await env.USAGE.prepare('SELECT last_sender_email FROM threads WHERE id = ?1')
        .bind(thread.id).first<{ last_sender_email: string | null }>();
      expect(indexed?.last_sender_email).toBe(rosa.email);
    } finally {
      restore();
    }
  });

  it('resolves the id spelling of the address too, creating the channel on the way', async () => {
    const restore = withCore(subjectAnswer);
    try {
      await member();
      // The channel's Durable Object outlives the D1 clean-up between tests,
      // so this mail carries its own Message-ID rather than the fixture's.
      const outcome = await handleInboundEmail(
        envelope(
          rawMail({ to: `meet-test.p-${projectId}@starlings.example`, text: 'Direct note', messageId: 'direct-note@mail.example' }),
          { to: `meet-test.p-${projectId}@starlings.example` },
        ),
        env as Env,
      );
      expect(outcome).toMatchObject({ accepted: true, duplicate: false });
      expect((outcome as { threadId: string }).threadId.startsWith('prj_')).toBe(true);
    } finally {
      restore();
    }
  });
});

describe('public contact email', () => {
  it('lands a sender-private guest line in Work Inbox without requiring membership', async () => {
    const recipient = 'contact@support.test';
    const first = await handleInboundEmail(
      envelope(
        rawMail({ from: 'Ana Lima <ana@acme.example>', to: recipient, subject: 'Need a hand', text: 'Please help us get started.', messageId: 'public-contact@mail.example' }),
        { from: 'ana@acme.example', to: recipient },
      ),
      env as Env,
    );
    expect(first).toMatchObject({ accepted: true, duplicate: false });
    const duplicate = await handleInboundEmail(
      envelope(
        rawMail({ from: 'Ana Lima <ana@acme.example>', to: recipient, subject: 'Need a hand', text: 'Please help us get started.', messageId: 'public-contact@mail.example' }),
        { from: 'ana@acme.example', to: recipient },
      ),
      env as Env,
    );
    expect(duplicate).toMatchObject({ accepted: true, duplicate: true });

    const headers = await member();
    const response = await exports.default.fetch(new Request('http://local/api/crm/inbox', { headers }));
    expect(response.status).toBe(200);
    const inbox = await response.json<InboxResponse>();
    expect(inbox.items).toContainEqual(expect.objectContaining({
      source: 'guest',
      subject: expect.objectContaining({ kind: 'organization', id: 'intake', title: 'Contact · Ana Lima' }),
      sender_email: 'ana@acme.example',
      preview: expect.stringContaining('Please help us get started.'),
    }));
  });

  it('is open on the support domain with INBOUND_EMAIL off, and only for contact@ and support@', async () => {
    const inbound = (env as MutableEnv).INBOUND_EMAIL;
    (env as MutableEnv).INBOUND_EMAIL = 'off';
    try {
      const mail = (to: string) => handleInboundEmail(
        envelope(
          rawMail({ from: 'Ben <ben@acme.example>', to, subject: 'Hi', text: 'Hello there.', messageId: `support-domain-${to}@mail.example` }),
          { from: 'ben@acme.example', to },
        ),
        env as Env,
      );
      expect(await mail('contact@support.test')).toMatchObject({ accepted: true });
      expect(await mail('support@support.test')).toMatchObject({ accepted: true });
      expect(await mail('calendar@support.test')).toEqual({ accepted: false, reason: 'no_domain' });
      expect(await mail('contact@elsewhere.test')).toEqual({ accepted: false, reason: 'no_domain' });
    } finally {
      (env as MutableEnv).INBOUND_EMAIL = inbound;
    }
  });

  it('is not dropped by the workspace prefix while INBOUND_EMAIL is on (meet#929 beside meet#1056)', async () => {
    const mail = (to: string) => handleInboundEmail(
      envelope(
        rawMail({ from: 'Cleo <cleo@acme.example>', to, subject: 'Hi', text: 'Hello again.', messageId: `support-prefix-${to}@mail.example` }),
        { from: 'cleo@acme.example', to },
      ),
      env as Env,
    );
    // No `<slug>.` prefix and not starlings.example, yet not `other_workspace`.
    expect(await mail('contact@support.test')).toMatchObject({ accepted: true });
    expect(await mail('support@support.test')).toMatchObject({ accepted: true });
    // Any other local part on the support domain is not this workspace's address.
    expect(await mail('calendar@support.test')).toEqual({ accepted: false, reason: 'other_workspace' });
  });
});

describe('what is dropped', () => {
  it('a sender who is not a member, with nothing written anywhere', async () => {
    const restore = withCore(subjectAnswer);
    try {
      const headers = await member();
      const thread = await openChannel(headers);
      const outcome = await handleInboundEmail(
        envelope(rawMail({ from: 'ana@acme.example', text: 'I am not a member', messageId: 'stranger@mail.example' }), { from: 'ana@acme.example' }),
        env as Env,
      );
      expect(outcome).toEqual({ accepted: false, reason: 'not_member' });
      const rows = await messages(headers, thread.id);
      expect(rows.some((row) => row.text.includes('I am not a member'))).toBe(false);
    } finally {
      restore();
    }
  });

  it('a sender whose own domain failed DKIM', async () => {
    await member();
    const outcome = await handleInboundEmail(
      envelope(rawMail({}), { headers: new Headers({ 'authentication-results': 'mx; dkim=fail header.d=example.com' }) }),
      env as Env,
    );
    expect(outcome).toEqual({ accepted: false, reason: 'dkim_failed' });
  });

  it('an address that names no subject, and one Core does not have', async () => {
    await member();
    expect(await handleInboundEmail(envelope(rawMail({}), { to: 'meet-test.nobody-here@starlings.example' }), env as Env))
      .toEqual({ accepted: false, reason: 'unknown_subject' });
    const restore = withCore(notFound);
    try {
      expect(await handleInboundEmail(envelope(rawMail({}), { to: `meet-test.p-${projectId}@starlings.example` }), env as Env))
        .toEqual({ accepted: false, reason: 'unknown_subject' });
    } finally {
      restore();
    }
  });

  it('a message over the size cap, before its bytes are read', async () => {
    await member();
    const outcome = await handleInboundEmail(
      envelope(rawMail({}), { rawSize: INBOUND_EMAIL_MAX_BYTES + 1 }),
      env as Env,
    );
    expect(outcome).toEqual({ accepted: false, reason: 'too_large' });
  });

  it('everything, while the deployment has no email domain', async () => {
    const inbound = (env as MutableEnv).INBOUND_EMAIL;
    (env as MutableEnv).INBOUND_EMAIL = 'off';
    try {
      expect(await handleInboundEmail(envelope(rawMail({})), env as Env)).toEqual({ accepted: false, reason: 'no_domain' });
    } finally {
      (env as MutableEnv).INBOUND_EMAIL = inbound;
    }
  });
});
