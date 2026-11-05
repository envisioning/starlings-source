import { describe, expect, it } from 'vitest';
import { SLACK_SUBJECT_KINDS as WIRE_SLACK_KINDS, calendarEventSubjectSchema } from '@starlings/contracts';
import { SUBJECT_KINDS, subjectHas, subjectKindsWith } from '@starlings/contracts/subject-kinds';
import {
  CALENDAR_SUBJECT_KINDS,
  DOCUMENT_SUBJECT_KINDS,
  GRANOLA_SUBJECT_KINDS,
  HOSTED_MEETING_KINDS,
  MEETING_FILING_KINDS,
  SLACK_SUBJECT_KINDS,
  TASK_SUBJECT_KINDS,
} from './subject-pickers';

describe('subject pickers follow the registry', () => {
  it('offers the registry kinds', () => {
    expect(CALENDAR_SUBJECT_KINDS).toEqual(subjectKindsWith('calendarEvents'));
    expect(SLACK_SUBJECT_KINDS).toEqual(subjectKindsWith('slack'));
    expect(GRANOLA_SUBJECT_KINDS).toEqual(subjectKindsWith('granola'));
    expect(DOCUMENT_SUBJECT_KINDS).toEqual(subjectKindsWith('documents'));
    expect(MEETING_FILING_KINDS).toEqual(subjectKindsWith('meetings'));
    expect(TASK_SUBJECT_KINDS).toEqual(subjectKindsWith('tasks'));
    expect(HOSTED_MEETING_KINDS).toEqual(SUBJECT_KINDS.filter((kind) => subjectHas(kind, 'hostedMeetings')));
  });

  it('matches what the wire accepts', () => {
    expect([...CALENDAR_SUBJECT_KINDS].sort()).toEqual([...calendarEventSubjectSchema.shape.kind.out.options].sort());
    expect([...SLACK_SUBJECT_KINDS, 'team'].sort()).toEqual([...WIRE_SLACK_KINDS].sort());
  });

  it('includes partners where the registry does', () => {
    for (const kinds of [CALENDAR_SUBJECT_KINDS, SLACK_SUBJECT_KINDS, GRANOLA_SUBJECT_KINDS, DOCUMENT_SUBJECT_KINDS, MEETING_FILING_KINDS]) {
      expect(kinds).toContain('organization');
    }
  });
});
