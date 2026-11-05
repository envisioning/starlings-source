import { env } from 'cloudflare:workers';
import { coreSubjectDetail } from './core-rows';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildMeetingLogPayload,
  crmSyncEnabled,
  CrmSyncError,
  fetchCrmCalendarContacts,
  fetchCrmInteractions,
  fetchCrmSubjectDetail,
  fetchCrmSubjects,
  postMeetingLog,
} from '../src/crm';
import { transcriptMarkdown } from '../src/docs';
import type { MeetingLogMaterial } from '../src/room-coordinator';

const PUBLIC_ORIGIN = 'https://envisioning.starlings.example';
const secretEnv = { ...env, INTERNAL_REQUEST_SECRET: 'meet-core-shared-secret-at-least-32-chars' } as Env;

function material(overrides: Partial<MeetingLogMaterial> = {}): MeetingLogMaterial {
  return {
    roomSlug: 'rosa',
    ownerEmail: 'rosa@example.com',
    meetingId: '0f1a5a2c-1111-4c8f-9a13-8a9d0e2f0001',
    livekitRoom: 'meet-rosa-0f1a5a2c',
    startedAt: 1_760_000_000_000,
    endedAt: 1_760_000_600_000,
    title: 'Acme kickoff',
    summary: '## Summary\n\nWe agreed on scope.',
    transcript: [{
      id: 'seg-1',
      meeting_id: '0f1a5a2c-1111-4c8f-9a13-8a9d0e2f0001',
      speaker_id: 'guest:abc',
      speaker_name: 'Ana',
      language: 'en',
      starts_at_ms: 72_000,
      ends_at_ms: 78_500,
      text: 'Let us start with the scope.',
      is_final: true,
    }],
    participants: [
      { identity: 'rosa@example.com', name: 'Rosa', email: 'rosa@example.com', role: 'owner', kind: 'human', bookingToken: null },
      { identity: 'guest:abc', name: 'Ana', email: 'ana@acme.com', role: 'guest', kind: 'guest', bookingToken: 'crm-token-abc' },
      { identity: 'guest:def', name: 'Nameless', email: '', role: 'guest', kind: 'guest', bookingToken: null },
    ],
    bookingToken: 'crm-token-abc',
    meetingKind: 'uncategorized',
    leadId: null,
    projectId: null,
    partnerOrganizationId: null,
    subjectTitle: null,
    categorizedBy: null,
    categorizedAt: null,
    transcriptDocumentId: null,
    transcriptDocumentPath: null,
    captureKind: 'hosted',
    revision: 3,
    transcriptRevision: 1,
    summaryRevision: 1,
    actionItems: [],
    decisionCandidates: [],
    ...overrides,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('CRM meeting log payload', () => {
  it('withholds text on start and carries summary plus transcript on end', () => {
    const started = buildMeetingLogPayload(material(), 'started', { publicOrigin: PUBLIC_ORIGIN });
    expect(started).toMatchObject({
      phase: 'started',
      meeting_id: '0f1a5a2c-1111-4c8f-9a13-8a9d0e2f0001',
      room_slug: 'rosa',
      host_email: 'rosa@example.com',
      started_at: '2025-10-09T08:53:20.000Z',
      title: null,
      summary_markdown: null,
      booking_token: 'crm-token-abc',
    });
    expect(started.transcript).toEqual([]);

    const ended = buildMeetingLogPayload(material(), 'ended', { publicOrigin: PUBLIC_ORIGIN });
    expect(ended.summary_markdown).toContain('We agreed on scope.');
    expect(ended.title).toBe('Acme kickoff');
    expect(ended.transcript).toHaveLength(1);
    expect(ended.transcript[0]).toMatchObject({ speaker_name: 'Ana', starts_at_ms: 72_000 });
  });

  it('points Core at the transcript document only once ended, and never invents one', () => {
    const filed = material({
      transcriptDocumentId: '44444444-4444-4444-8444-444444444444',
      transcriptDocumentPath: '/work/meetings/acme-kickoff-transcript',
    });
    const url = 'https://docs.invalid/work/meetings/acme-kickoff-transcript';
    const started = buildMeetingLogPayload(filed, 'started', { publicOrigin: PUBLIC_ORIGIN, transcriptURL: url });
    expect(started.transcript_document_id).toBeNull();
    expect(started.transcript_url).toBeNull();

    const ended = buildMeetingLogPayload(filed, 'ended', { publicOrigin: PUBLIC_ORIGIN, transcriptURL: url });
    expect(ended.transcript_document_id).toBe('44444444-4444-4444-8444-444444444444');
    expect(ended.transcript_url).toBe(url);

    const unfiled = buildMeetingLogPayload(material(), 'ended', { publicOrigin: PUBLIC_ORIGIN });
    expect(unfiled.transcript_document_id).toBeNull();
    expect(unfiled.transcript_url).toBeNull();
  });

  it('renders the transcript as one block a segment with offsets from the start', () => {
    const markdown = transcriptMarkdown(material());
    expect(markdown).toContain('## Transcript');
    expect(markdown).toContain('**Ana** (00:01:12): Let us start with the scope.');
    expect(markdown).toContain('Audio and video were not recorded.');
  });

  it('sends the whole roster but never invents an email', () => {
    const payload = buildMeetingLogPayload(material(), 'ended', { publicOrigin: PUBLIC_ORIGIN });
    // Email-less guests are still part of the log.
    expect(payload.participants).toHaveLength(3);
    expect(payload.participants.find((p) => p.identity === 'guest:def')).toMatchObject({
      email: null,
      role: 'guest',
    });
  });

  it('always links the public permalink, never the Worker origin', () => {
    const payload = buildMeetingLogPayload(material(), 'started', { publicOrigin: PUBLIC_ORIGIN });
    expect(payload.permalink).toBe('https://envisioning.starlings.example/room/rosa');
  });

  it('carries no audio, video, or quality fields', () => {
    const wire = JSON.stringify(buildMeetingLogPayload(material(), 'ended', { publicOrigin: PUBLIC_ORIGIN }));
    for (const forbidden of ['livekit', 'lobby_token', 'recording', 'quality', 'excellent_ms']) {
      expect(wire.toLowerCase()).not.toContain(forbidden);
    }
  });
});

describe('CRM sync transport', () => {
  it('stays off until the shared secret is configured', () => {
    expect(crmSyncEnabled({ ...(env as object), INTERNAL_REQUEST_SECRET: '' } as Env)).toBe(false);
    expect(crmSyncEnabled(secretEnv)).toBe(true);
    expect(crmSyncEnabled({ ...secretEnv, CRM_SYNC_MODE: 'off' } as Env)).toBe(false);
  });

  it('signs the body with a timestamped HMAC Core can verify', async () => {
    const seen: { url: string; headers: Headers; body: string }[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: String(init?.body),
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const payload = buildMeetingLogPayload(material(), 'ended', { publicOrigin: PUBLIC_ORIGIN });
    await postMeetingLog(secretEnv, payload);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://core.invalid/api/public/meet-meeting-logs');
    const timestamp = seen[0]!.headers.get('x-internal-timestamp')!;
    const signature = seen[0]!.headers.get('x-internal-signature')!;
    expect(Number(timestamp)).toBeGreaterThan(1_700_000_000_000);
    expect(signature).toMatch(/^[0-9a-f]{64}$/u);

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode('meet-core-shared-secret-at-least-32-chars'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const expected = [...new Uint8Array(await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(`${timestamp}.${seen[0]!.body}`),
    ))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    expect(signature).toBe(expected);
  });

  it('keeps the subject browse within Core’s page-size limit', async () => {
    let requestedURL: URL | undefined;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      requestedURL = new URL(String(input));
      return new Response(JSON.stringify({ ok: true, subjects: [], has_more: false }), { status: 200 });
    });

    await fetchCrmSubjects(secretEnv, 'project', '', 'open');

    expect(requestedURL?.searchParams.get('limit')).toBe('50');
    expect(requestedURL?.searchParams.get('status')).toBe('open');
  });

  it('reads one subject out of Core’s list answer', async () => {
    // Core answers an id query two ways: partner and event carry `subject`
    // beside `subjects`, lead and project carry the list alone. Reading only
    // `subject` 502'd every lead and project, which is Edit details… on both
    // kinds Meet can edit.
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      ok: true,
      subjects: [coreSubjectDetail({ id: '646888f1-dc7e-4b57-b1d2-7cf8ae4633f2', kind: 'project', title: 'Einstein Signals' })],
      has_more: false,
    }), { status: 200 }));

    const subject = await fetchCrmSubjectDetail(
      secretEnv,
      'project',
      '646888f1-dc7e-4b57-b1d2-7cf8ae4633f2',
    );

    expect(subject.title).toBe('Einstein Signals');
  });

  it('still prefers Core’s singular subject when it sends one', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      ok: true,
      subject: coreSubjectDetail({ id: 'partner-1', kind: 'partner', title: 'From subject' }),
      subjects: [coreSubjectDetail({ id: 'partner-1', kind: 'partner', title: 'From list' })],
    }), { status: 200 }));

    const subject = await fetchCrmSubjectDetail(secretEnv, 'organization', 'partner-1');

    expect(subject.title).toBe('From subject');
  });

  it('refuses a list that does not contain the id asked for', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      ok: true,
      subjects: [coreSubjectDetail({ id: 'someone-else', kind: 'project', title: 'Wrong row' })],
      has_more: false,
    }), { status: 200 }));

    await expect(fetchCrmSubjectDetail(secretEnv, 'project', 'asked-for'))
      .rejects.toThrow(CrmSyncError);
  });

  it('resolves calendar invitees through the CRM contact projection', async () => {
    let requestedURL: URL | undefined;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      requestedURL = new URL(String(input));
      return new Response(JSON.stringify({ contacts: [{
        id: 'contact-1',
        name: 'Ana Client',
        email: 'ana@example.net',
      }] }), { status: 200 });
    });

    await expect(fetchCrmCalendarContacts(secretEnv, [' ANA@EXAMPLE.NET ', 'ana@example.net']))
      .resolves.toEqual([{ id: 'contact-1', name: 'Ana Client', email: 'ana@example.net' }]);
    expect(requestedURL?.pathname).toBe('/api/public/meet-calendar-contacts');
    expect(requestedURL?.searchParams.get('emails')).toBe('ana@example.net');
  });

  it('reads one subject interaction list through the signed Core projection', async () => {
    let requestedURL: URL | undefined;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      requestedURL = new URL(String(input));
      return new Response(JSON.stringify({ interactions: [] }), { status: 200 });
    });

    await expect(fetchCrmInteractions(secretEnv, { leadId: 'lead-123' }, 7)).resolves.toEqual([]);

    expect(requestedURL?.pathname).toBe('/api/public/meet-crm-interactions');
    expect(requestedURL?.searchParams.get('project_id')).toBeNull();
    expect(requestedURL?.searchParams.get('lead_id')).toBe('lead-123');
    expect(requestedURL?.searchParams.get('limit')).toBe('7');
  });

  it('throws on a non-2xx so the queue retries instead of dropping the log', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 502 }));
    await expect(postMeetingLog(secretEnv, buildMeetingLogPayload(material(), 'ended', { publicOrigin: PUBLIC_ORIGIN })))
      .rejects.toThrow(CrmSyncError);
  });
});

describe('ambient capture in the meeting log', () => {
  it('says its source and offers no permalink', () => {
    const payload = buildMeetingLogPayload(material({ captureKind: 'ambient', livekitRoom: 'ambient:x' }), 'ended', { publicOrigin: PUBLIC_ORIGIN });
    expect(payload.source).toBe('meet_ambient');
    expect(payload.permalink).toBeNull();
    expect(payload.room_slug).toBe('rosa');
  });

  it('a hosted meeting stays Core’s default source', () => {
    const payload = buildMeetingLogPayload(material(), 'ended', { publicOrigin: PUBLIC_ORIGIN });
    expect(payload.source).toBeUndefined();
    expect(payload.permalink).toContain('envisioning.starlings.example');
  });
});
