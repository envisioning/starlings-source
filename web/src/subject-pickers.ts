import { subjectKindsWith, type SubjectKind } from '@starlings/contracts/subject-kinds';

/**
 * The kinds each subject picker offers, read from the shared registry
 * (`@starlings/contracts/subject-kinds`) so a new capability lands here once.
 * subject-pickers.test.ts pins them.
 */
export const CALENDAR_SUBJECT_KINDS: SubjectKind[] = subjectKindsWith('calendarEvents');
export const SLACK_SUBJECT_KINDS: SubjectKind[] = subjectKindsWith('slack');
export const GRANOLA_SUBJECT_KINDS: SubjectKind[] = subjectKindsWith('granola');
export const DOCUMENT_SUBJECT_KINDS: SubjectKind[] = subjectKindsWith('documents');
/** Where Move to… can send a task. */
export const TASK_SUBJECT_KINDS: SubjectKind[] = subjectKindsWith('tasks');
export const MEETING_FILING_KINDS: SubjectKind[] = subjectKindsWith('meetings');
/** Meetings that are hosted in Meet, which is when a filed meeting takes decisions. */
export const HOSTED_MEETING_KINDS: SubjectKind[] = subjectKindsWith('hostedMeetings');
