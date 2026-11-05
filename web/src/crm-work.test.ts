import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dayValue, isPartnerTask, organizationRelationshipsLine, taskSubjectQuery, taskWhere, workSubjectOf } from './crm-work';
import { subjectHref, subjectTaskHref } from './work-hrefs';

/*
 * #220: the date input must show the local day the native editors show, so
 * an edit to the title alone writes the same day back.
 */
describe('dayValue', () => {
  beforeEach(() => { vi.stubEnv('TZ', 'Europe/Amsterdam'); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('is the local day of the stored timestamp', () => {
    // 22:00Z on the 19th is 00:00 on the 20th in Amsterdam (CEST).
    expect(dayValue('2026-09-19T22:00:00Z')).toBe('2026-09-20');
    expect(dayValue(null)).toBe('');
    expect(dayValue('not a date')).toBe('');
  });
});

describe('partner tasks', () => {
  const org = '11111111-1111-1111-1111-111111111111';

  it('is a partner task only when the organization is the whole filing', () => {
    expect(isPartnerTask({ organization_id: org })).toBe(true);
    expect(isPartnerTask({ organization_id: org, project_id: null, lead_id: null, event_id: null, meeting_id: null })).toBe(true);
    // Core echoes the organization on a project's, lead's or event's task.
    expect(isPartnerTask({ organization_id: org, project_id: 'p1' })).toBe(false);
    expect(isPartnerTask({ organization_id: org, lead_id: 'l1' })).toBe(false);
    expect(isPartnerTask({ organization_id: org, event_id: 'e1' })).toBe(false);
    expect(isPartnerTask({ organization_id: org, meeting_id: 'm1' })).toBe(false);
    expect(isPartnerTask({ organization_id: null })).toBe(false);
    expect(isPartnerTask({})).toBe(false);
  });

  it('resolves the subject a task is filed on', () => {
    expect(workSubjectOf({ organization_id: org })).toEqual({ kind: 'organization', id: org });
    expect(workSubjectOf({ organization_id: org, project_id: 'p1' })).toEqual({ kind: 'project', id: 'p1' });
    expect(workSubjectOf({ organization_id: org, meeting_id: 'm1' })).toBeNull();
    expect(workSubjectOf({})).toBeNull();
  });

  it('names a partner by its organization in a task query and links to its Tasks pane', () => {
    expect(taskSubjectQuery({ kind: 'organization', id: org })).toEqual({ organization_id: org });
    expect(subjectHref({ kind: 'organization', id: org }, { pane: 'tasks' })).toBe(`/work/organization/${org}?pane=tasks`);
    expect(subjectTaskHref('t1', { kind: 'organization', id: org })).toBe(`/work/organization/${org}?pane=tasks&task=t1&edit=task`);
  });
});

describe('taskWhere', () => {
  it('names the kind and the subject', () => {
    expect(taskWhere({ organization_id: 'o1' }, 'Echos')).toEqual({ label: 'Partner · Echos', subject: { kind: 'organization', id: 'o1' } });
    expect(taskWhere({ project_id: 'p1', organization_id: 'o1' }, 'X').label).toBe('Project · X');
    expect(taskWhere({ lead_id: 'l1' }, 'Y').label).toBe('Lead · Y');
    expect(taskWhere({ event_id: 'e1' }, 'Z').label).toBe('Event · Z');
  });
  it('falls back to the kind without a name', () => {
    expect(taskWhere({ lead_id: 'l1' }).label).toBe('Lead');
    expect(taskWhere({ lead_id: 'l1' }, '  ').label).toBe('Lead');
  });
  it('reads Meeting or No subject when nothing is filed', () => {
    expect(taskWhere({ meeting_id: 'm1', organization_id: 'o1' })).toEqual({ label: 'Meeting', subject: null });
    expect(taskWhere({})).toEqual({ label: 'No subject', subject: null });
  });
});

describe('organizationRelationshipsLine', () => {
  it('joins the relationships the Worker sends, in its order', () => {
    expect(organizationRelationshipsLine(['client', 'partner'])).toBe('Client · Partner');
    expect(organizationRelationshipsLine(['prospect'])).toBe('Prospect');
  });

  it('is empty when none hold or the Worker sent none', () => {
    expect(organizationRelationshipsLine([])).toBe('');
    expect(organizationRelationshipsLine(undefined)).toBe('');
  });
});
