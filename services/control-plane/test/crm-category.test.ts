import { describe, expect, it, vi } from 'vitest';
import { buildMeetingLogPayload, crmSyncEnabled } from '../src/crm';
import type { MeetingLogMaterial } from '../src/room-coordinator';

vi.mock('../src/crypto', () => ({
  hmacSHA256Hex: vi.fn(async () => 'sig'),
}));

const baseMaterial: MeetingLogMaterial = {
  roomSlug: 'rosa',
  ownerEmail: 'rosa@example.com',
  meetingId: '11111111-1111-4111-8111-111111111111',
  livekitRoom: 'meet-rosa',
  startedAt: Date.parse('2026-08-13T12:00:00.000Z'),
  endedAt: Date.parse('2026-08-13T12:30:00.000Z'),
  title: 'Status',
  summary: 'We talked.',
  transcript: [{
    id: 'seg-1',
    meeting_id: '11111111-1111-4111-8111-111111111111',
    speaker_id: 'host',
    speaker_name: 'ROSA',
    language: 'en',
    starts_at_ms: 0,
    ends_at_ms: 1000,
    text: 'Hello',
    is_final: true,
  }],
  participants: [{
    identity: 'host',
    name: 'ROSA',
    email: 'rosa@example.com',
    role: 'owner',
    kind: 'human',
    bookingToken: null,
  }],
  bookingToken: null,
  meetingKind: 'project',
  leadId: null,
  projectId: '22222222-2222-4222-8222-222222222222',
  partnerOrganizationId: null,
  subjectTitle: 'Acme rollout',
  categorizedBy: 'rosa@example.com',
  categorizedAt: Date.parse('2026-08-13T12:05:00.000Z'),
  transcriptDocumentId: null,
  transcriptDocumentPath: null,
  captureKind: 'hosted',
  revision: 3,
  transcriptRevision: 1,
  summaryRevision: 1,
  actionItems: [],
  decisionCandidates: [],
};

describe('crm category payload', () => {
  it('carries a partner filing as the organization', () => {
    const org = '33333333-3333-4333-8333-333333333333';
    const payload = buildMeetingLogPayload({ ...baseMaterial, meetingKind: 'partner', projectId: null, partnerOrganizationId: org }, 'ended', { publicOrigin: 'https://envisioning.starlings.example' });
    expect(payload.meeting_kind).toBe('partner');
    expect(payload.partner_organization_id).toBe(org);
    expect(payload.project_id).toBeNull();
  });

  it('includes meeting kind and project subject on ended sync', () => {
    const payload = buildMeetingLogPayload(baseMaterial, 'ended', { publicOrigin: 'https://envisioning.starlings.example' });
    expect(payload.meeting_kind).toBe('project');
    expect(payload.project_id).toBe(baseMaterial.projectId);
    expect(payload.lead_id).toBeNull();
    expect(payload.categorized_by).toBe('rosa@example.com');
    expect(payload.summary_markdown).toBe('We talked.');
    expect(payload.transcript).toHaveLength(1);
  });

  it('crmSyncEnabled requires the shared secret', () => {
    expect(crmSyncEnabled({ WORK_STORE: 'core', CRM_SYNC_MODE: 'on' } as Env)).toBe(false);
    expect(crmSyncEnabled({
      WORK_STORE: 'core',
      CRM_SYNC_MODE: 'on',
      INTERNAL_REQUEST_SECRET: 'secret',
    } as Env)).toBe(true);
  });
});
