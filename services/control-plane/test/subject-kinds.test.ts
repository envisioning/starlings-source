import { describe, expect, it } from 'vitest';
import {
  SLACK_SUBJECT_KINDS,
  SUBJECT_CAPABILITIES,
  SUBJECT_KINDS,
  SUBJECT_KIND_CAPABILITIES,
  calendarEventSubjectSchema,
  docsKindFor,
  granolaProposalSchema,
  slackMappingSchema,
  subjectKindsWith,
  taskFieldFor,
} from '@starlings/contracts';
import fixture from '../../../fixtures/subject-kinds.json';

describe('subject kinds registry', () => {
  it('equals fixtures/subject-kinds.json, the table the native and web mirrors pin', () => {
    expect(fixture.kinds).toEqual(SUBJECT_KIND_CAPABILITIES);
    expect(Object.keys(fixture.kinds)).toEqual([...SUBJECT_KINDS]);
    expect(Object.keys(fixture.with)).toEqual([...SUBJECT_CAPABILITIES]);
    for (const capability of SUBJECT_CAPABILITIES) {
      expect(fixture.with[capability]).toEqual(subjectKindsWith(capability));
    }
  });

  it('keeps existing behaviour and widens only for partner', () => {
    expect(subjectKindsWith('issues')).toEqual(['project']);
    expect(subjectKindsWith('documents')).toEqual(['project', 'lead', 'organization']);
    expect(subjectKindsWith('hostedMeetings')).toEqual(['project', 'lead', 'organization']);
    expect(taskFieldFor('organization')).toBe('organization_id');
    expect(docsKindFor('organization')).toBe('organization');
    expect(docsKindFor('event')).toBeNull();
  });

  it('agrees with the server schemas that restrict by kind', () => {
    const calendar = calendarEventSubjectSchema.shape.kind.out.options;
    expect([...calendar]).toEqual(subjectKindsWith('calendarEvents'));
    expect(SLACK_SUBJECT_KINDS.filter((kind) => kind !== 'team')).toEqual(subjectKindsWith('slack'));
    const granola = granolaProposalSchema.shape.existing.unwrap().shape.kind.out.options;
    expect([...granola].sort()).toEqual([...subjectKindsWith('granola')].sort());
  });

  it('maps a Slack channel to a partner, and only with an id', () => {
    const id = '3f6c1f52-0a1b-4c2d-8e3f-0a1b2c3d4e5f';
    expect(slackMappingSchema.safeParse({ subject_kind: 'partner', subject_id: id }).success).toBe(true);
    expect(slackMappingSchema.safeParse({ subject_kind: 'partner', subject_id: null }).success).toBe(false);
    expect(slackMappingSchema.safeParse({ subject_kind: 'event', subject_id: id }).success).toBe(false);
  });
});
