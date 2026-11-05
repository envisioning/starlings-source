// The Granola bridge: the inbound door's locks, and the mapping that makes a
// Granola note indistinguishable from a Meet session on a CRM timeline.
// See docs/GRANOLA_BRIDGE.md.
import { coreInteraction } from './core-rows';
import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { purgeAllCoreCache } from '../src/core-cache';
import { buildGranolaLogPayload, connectorsStatus, fileGranolaNote, granolaNotesPage, granolaProposals, ingestGranolaNote, startGranolaBackfill } from '../src/granola';
import { isConsumerDomain, registrableDomain } from '../src/identity';

const SECRET = 'whsec_Z3Jhbm9sYS10ZXN0LXNpZ25pbmcta2V5LWJ5dGVz';

function keyBytes(secret: string): Uint8Array {
  const binary = atob(secret.slice('whsec_'.length));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** The Standard Webhooks envelope Granola signs its deliveries with. */
async function sign(secret: string, id: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes(secret) as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
  let binary = '';
  for (const byte of new Uint8Array(signature)) binary += String.fromCharCode(byte);
  return `v1,${btoa(binary)}`;
}

async function deliver(body: unknown, options: {
  signature?: string;
  timestamp?: string;
  headers?: Record<string, string>;
} = {}) {
  const raw = JSON.stringify(body);
  const id = 'msg_test_1';
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature = options.signature ?? await sign(SECRET, id, timestamp, raw);
  return exports.default.fetch(new Request('http://local/api/internal/granola-webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': timestamp,
      'webhook-signature': signature,
      ...options.headers,
    },
    body: raw,
  }));
}

const generated = { type: 'note.generated', data: { note_id: 'not_abc123def456' } };

describe('granola webhook door', () => {
  it('accepts a correctly signed delivery', async () => {
    const response = await deliver(generated);
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; queued: boolean };
    expect(body.ok).toBe(true);
    // No API key in tests, so the bridge is off and nothing is enqueued — the
    // delivery is still acknowledged, which is what stops Granola retrying for
    // four days against a deployment that is deliberately not configured.
    expect(body.queued).toBe(false);
  });

  it('refuses a delivery signed with the wrong secret', async () => {
    const raw = JSON.stringify(generated);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const wrong = await sign('whsec_d3Jvbmctc2lnbmluZy1rZXktYnl0ZXMtaGVyZQ==', 'msg_test_1', timestamp, raw);
    const response = await deliver(generated, { signature: wrong, timestamp });
    expect(response.status).toBe(403);
  });

  it('refuses a delivery whose body was changed after signing', async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await sign(SECRET, 'msg_test_1', timestamp, JSON.stringify(generated));
    const response = await deliver(
      { type: 'note.generated', data: { note_id: 'not_somebodyelses' } },
      { signature, timestamp },
    );
    expect(response.status).toBe(403);
  });

  it('refuses a stale timestamp, so a captured delivery cannot be replayed', async () => {
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    const response = await deliver(generated, { timestamp: old });
    expect(response.status).toBe(403);
  });

  it('refuses a delivery that carries a session token', async () => {
    const response = await deliver(generated, { headers: { authorization: 'Bearer anything' } });
    expect(response.status).toBe(403);
  });

  it('ignores note.access_granted — a shared note is not ours to import', async () => {
    const response = await deliver({ type: 'note.access_granted', data: { note_id: 'not_abc123def456' } });
    expect(response.status).toBe(200);
    expect((await response.json() as { queued: boolean }).queued).toBe(false);
  });
});

describe('granola note mapping', () => {
  const note = {
    id: 'not_abc123def456',
    title: 'Envisioning x BFF — debrief',
    created_at: '2026-09-09T14:20:00.000Z',
    web_url: 'https://notes.granola.ai/d/not_abc123def456',
    owner: { name: 'Rosa Ortiz', email: 'ROSA@example.com' },
    summary_markdown: '## Decisions\n\n- Ship it.',
    attendees: [
      { name: 'Rosa Ortiz', email: 'rosa@example.com' },
      { name: 'Felix Andrade', email: 'felix@example.org' },
      { name: 'Jordan Wells', email: 'jordan.wells@harborbank.com' },
      { name: 'Someone on speakerphone' },
    ],
    calendar_event: {
      event_title: 'BFF debrief',
      organiser: 'rosa@example.com',
      scheduled_start_time: '2026-09-09T14:30:00.000Z',
      scheduled_end_time: '2026-09-09T15:15:00.000Z',
      invitees: [{ email: 'jordan.wells@harborbank.com' }, { email: 'casey.bell@harborbank.com' }],
    },
  };

  it('maps a note into the shape a finished Meet session sends', () => {
    const payload = buildGranolaLogPayload(env as Env, note, []);
    expect(payload.source).toBe('granola');
    expect(payload.phase).toBe('ended');
    expect(payload.meeting_id).toBe('not_abc123def456');
    // No Meet room was involved and the bridge must not invent one.
    expect(payload.room_slug).toBeNull();
    expect(payload.permalink).toBe('https://notes.granola.ai/d/not_abc123def456');
    expect(payload.started_at).toBe('2026-09-09T14:30:00.000Z');
    expect(payload.ended_at).toBe('2026-09-09T15:15:00.000Z');
    expect(payload.summary_markdown).toContain('Ship it.');
    // Filing is a human act; nothing is inferred from an email domain.
    expect(payload.meeting_kind).toBe('uncategorized');
    expect(payload.lead_id).toBeNull();
    expect(payload.project_id).toBeNull();
  });

  it('marks Envisioning addresses internal so Core never creates a contact for a colleague', () => {
    const payload = buildGranolaLogPayload(env as Env, note, []);
    const roles = Object.fromEntries(payload.participants.map((p) => [p.email ?? p.name, p.role]));
    expect(roles['rosa@example.com']).toBe('owner');
    expect(roles['felix@example.org']).toBe('owner');
    expect(roles['jordan.wells@harborbank.com']).toBe('guest');
    expect(roles['casey.bell@harborbank.com']).toBe('guest');
  });

  it('keeps a name-only attendee without inventing an address', () => {
    const payload = buildGranolaLogPayload(env as Env, note, []);
    const anonymous = payload.participants.find((p) => p.name === 'Someone on speakerphone');
    expect(anonymous).toBeDefined();
    expect(anonymous?.email).toBeNull();
  });

  it('unions attendees and invitees without duplicating a shared address', () => {
    const payload = buildGranolaLogPayload(env as Env, note, []);
    const john = payload.participants.filter((p) => p.email === 'jordan.wells@harborbank.com');
    expect(john).toHaveLength(1);
    // The name from `attendees` survives the address-only invitee entry.
    expect(john[0]?.name).toBe('Jordan Wells');
  });

  it('rebases ISO transcript timestamps into offsets from the first segment', () => {
    const payload = buildGranolaLogPayload(env as Env, note, [
      { speaker: { name: 'Rosa' }, text: 'Opening.', start_timestamp: '2026-09-09T14:30:00.000Z', end_timestamp: '2026-09-09T14:30:04.000Z' },
      { speaker: { name: 'John' }, text: 'Reply.', start_timestamp: '2026-09-09T14:30:10.000Z', end_timestamp: '2026-09-09T14:30:14.000Z' },
    ]);
    expect(payload.transcript[0]?.starts_at_ms).toBe(0);
    expect(payload.transcript[1]?.starts_at_ms).toBe(10_000);
    expect(payload.transcript[1]?.speaker_name).toBe('John');
  });

  it('passes millisecond offsets through unchanged', () => {
    const payload = buildGranolaLogPayload(env as Env, note, [
      { speaker: { name: 'Rosa' }, text: 'One.', start_timestamp: 0, end_timestamp: 4_000 },
      { speaker: { name: 'John' }, text: 'Two.', start_timestamp: 72_000, end_timestamp: 78_500 },
    ]);
    expect(payload.transcript[1]?.starts_at_ms).toBe(72_000);
    expect(payload.transcript[1]?.ends_at_ms).toBe(78_500);
  });

  it('drops empty segments rather than writing blank transcript lines', () => {
    const payload = buildGranolaLogPayload(env as Env, note, [
      { speaker: { name: 'Rosa' }, text: '   ', start_timestamp: 0 },
      { speaker: { name: 'John' }, text: 'Real.', start_timestamp: 1_000 },
    ]);
    expect(payload.transcript).toHaveLength(1);
    expect(payload.transcript[0]?.text).toBe('Real.');
  });

  it('refuses a note with no owner address rather than guessing one', () => {
    expect(() => buildGranolaLogPayload(env as Env, { id: 'not_x', title: 'Orphan' }, [])).toThrow();
  });
});

describe('granola ingest and import list', () => {
  const bridgeEnv = {
    ...env,
    GRANOLA_API_KEY: 'grn_test',
    INTERNAL_REQUEST_SECRET: 'meet-core-shared-secret-at-least-32-chars',
    // Docs is off here: the transcript document is Docs' own test.
    DOCS_INTERNAL_SECRET: '',
  } as Env;
  const note = {
    id: 'not_abc123def456',
    title: 'BFF debrief',
    created_at: '2026-09-09T14:20:00.000Z',
    owner: { email: 'rosa@example.com' },
    summary_markdown: 'Ship it.',
    attendees: [{ name: 'Jordan Wells', email: 'jordan.wells@harborbank.com' }],
    transcript: [],
  };

  /** Granola and Core behind one fetch; what Core is told is what the test reads. */
  function stub(ledger: Array<Record<string, unknown>>) {
    const posted: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === 'public-api.granola.ai') {
        if (url.pathname === '/v1/notes') return Response.json({ notes: [note], hasMore: false });
        if (url.pathname === `/v1/notes/${note.id}`) return Response.json(note);
        return new Response('', { status: 404 });
      }
      if (url.pathname === '/api/public/meet-crm-interactions') return Response.json({ ok: true, interactions: ledger.map((row) => coreInteraction(row)) });
      if (url.pathname === '/api/public/meet-meeting-logs') {
        posted.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ ok: true, interaction_id: 'int-1', merged: false });
      }
      return new Response('', { status: 404 });
    });
    return posted;
  }
  // The ledger is cached a minute; each case starts cold.
  afterEach(async () => {
    vi.unstubAllGlobals();
    await purgeAllCoreCache();
  });

  it('counts a run the way the card draws it: ingested notes, not listed ones', async () => {
    const posted = stub([]);
    // A page walk that has listed the note but not yet ingested it: the index
    // row exists, and progress must still read zero.
    await granolaNotesPage(bridgeEnv);
    await startGranolaBackfill(bridgeEnv, 36);
    const walking = (await connectorsStatus(bridgeEnv)).connectors[0]!;
    expect(walking.run).toMatchObject({ done: 0, total: 1 });

    await ingestGranolaNote(bridgeEnv, note.id);
    expect(posted).toHaveLength(1);
    const ingested = (await connectorsStatus(bridgeEnv)).connectors[0]!;
    expect(ingested.run).toMatchObject({ done: 1, total: 1 });
    expect(ingested.run?.last_note_at).toBeGreaterThan(0);
  });

  it('proposes one lead per company, never one per meeting', async () => {
    // Two meetings with the same company, imported and unfiled, whose kind
    // the model is sure of and whose subject it could not name.
    stub([{ id: 'int-1', granola_note_id: note.id, meeting_kind: 'uncategorized', lead_id: null, project_id: null, subject_title: null, transcript_document_id: null, contacts: [], organization_id: null }]);
    await granolaNotesPage(bridgeEnv);
    await bridgeEnv.USAGE.prepare(
      `INSERT OR REPLACE INTO granola_suggestions (note_id, model, meeting_kind, kind_probability, subject_kind, subject_id, subject_title, subject_probability, options, scoped, suggested_at)
       VALUES (?1, 'test', 'lead', 0.95, 'lead', NULL, NULL, NULL, 10, 0, ?2)`,
    ).bind(note.id, Date.now()).run();

    // One meeting is not a relationship: nothing is proposed for it.
    const { proposals } = await granolaProposals(bridgeEnv);
    expect(proposals.find((row) => row.domain === 'harborbank.com')).toBeUndefined();
  });

  it('reads a company out of any host under it, and never out of a mailbox host', async () => {
    expect(registrableDomain('emeal.nttdata.com')).toBe('nttdata.com');
    expect(registrableDomain('mail.acme.com.br')).toBe('acme.com.br');
    expect(registrableDomain('acme.io')).toBe('acme.io');
    // The first run proposed a lead called "Hotmail" from hotmail.nl: the
    // list matched whole domains, so every country variant slipped through.
    expect(isConsumerDomain('hotmail.nl')).toBe(true);
    expect(isConsumerDomain('gmail.co.uk')).toBe(true);
    expect(isConsumerDomain('nttdata.com')).toBe(false);
  });

  it('sends no kind on a plain read, so Core keeps a person’s filing', async () => {
    const posted = stub([]);
    await ingestGranolaNote(bridgeEnv, note.id);
    expect(posted).toHaveLength(1);
    expect('meeting_kind' in posted[0]!).toBe(false);
    expect(posted[0]!.source).toBe('granola');
  });

  it('sends the kind and subject when filing', async () => {
    const posted = stub([]);
    const filed = await fileGranolaNote(bridgeEnv, note.id, {
      meetingKind: 'internal',
      leadId: null,
      projectId: null,
      eventId: null,
      partnerOrganizationId: null,
      categorizedBy: 'rosa@example.com',
    });
    expect(posted[0]!.meeting_kind).toBe('internal');
    expect(posted[0]!.categorized_by).toBe('rosa@example.com');
    expect(filed.meeting_kind).toBe('internal');
  });

  it('lists Granola’s notes with Core’s answer beside each', async () => {
    stub([{
      id: 'int-1',
      granola_note_id: note.id,
      meeting_kind: 'project',
      lead_id: null,
      project_id: '55555555-5555-4555-8555-555555555555',
      subject_title: 'BFF',
      transcript_document_id: null,
    }]);
    const page = await granolaNotesPage(bridgeEnv);
    expect(page.imported_count).toBe(1);
    expect(page.notes).toHaveLength(1);
    expect(page.notes[0]!.title).toBe('BFF debrief');
    // The index keeps a name and a domain, never the address.
    expect(page.notes[0]!.attendees).toEqual([{ name: 'Jordan Wells', email: null }]);
    expect(page.notes[0]!.imported).toMatchObject({ meeting_kind: 'project', subject_title: 'BFF', has_transcript: false });
  });

  it('keeps no guest address in D1, only the domain', async () => {
    stub([]);
    await granolaNotesPage(bridgeEnv);
    await ingestGranolaNote(bridgeEnv, note.id);
    const row = await bridgeEnv.USAGE.prepare('SELECT attendees FROM granola_notes WHERE note_id = ?1').bind(note.id).first<{ attendees: string }>();
    expect(row!.attendees).not.toContain('@');
    expect(JSON.parse(row!.attendees)).toContainEqual({ name: 'Jordan Wells', domain: 'harborbank.com' });
    // A guest Granola knows only by address keeps no name at all.
    note.attendees.push({ name: 'guest@acme.com', email: 'guest@acme.com' });
    await ingestGranolaNote(bridgeEnv, note.id);
    note.attendees.pop();
    const again = await bridgeEnv.USAGE.prepare('SELECT attendees FROM granola_notes WHERE note_id = ?1').bind(note.id).first<{ attendees: string }>();
    expect(again!.attendees).not.toContain('@');
    expect(JSON.parse(again!.attendees)).toContainEqual({ name: '', domain: 'acme.com' });
  });

  it('files a personal note with no content, then never reads it again', async () => {
    const posted = stub([{ id: 'int-1', granola_note_id: note.id, meeting_kind: 'uncategorized', lead_id: null, project_id: null, subject_title: null, transcript_document_id: null }]);
    await granolaNotesPage(bridgeEnv);
    await fileGranolaNote(bridgeEnv, note.id, {
      meetingKind: 'personal',
      leadId: null,
      projectId: null,
      eventId: null,
      partnerOrganizationId: null,
      categorizedBy: 'rosa@example.com',
    });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ meeting_kind: 'personal', summary_markdown: null, transcript: [], participants: [], transcript_url: null });

    // A later edit in Granola, a backfill, an import: nothing reaches Core.
    expect(await ingestGranolaNote(bridgeEnv, note.id)).toBe(true);
    expect(posted).toHaveLength(1);

    // And the note is no longer the company's to list.
    await purgeAllCoreCache();
    const page = await granolaNotesPage(bridgeEnv);
    expect(page.notes.find((row) => row.id === note.id)).toBeUndefined();
    await bridgeEnv.USAGE.prepare('UPDATE granola_notes SET personal_at = NULL, personal_by = NULL').run();
  });

  it('shows a note Core has not seen as not imported', async () => {
    stub([]);
    const page = await granolaNotesPage(bridgeEnv);
    expect(page.notes[0]!.imported).toBeNull();
  });
});
