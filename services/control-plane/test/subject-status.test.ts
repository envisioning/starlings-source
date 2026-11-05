import { describe, expect, it } from 'vitest';
import { crmLeadStatusSchema, crmProjectStatusSchema } from '@starlings/contracts';
import { SUBJECT_STATUS_CHOICES, SUBJECT_STATUS_KINDS, organizationRelationships } from '@starlings/contracts/subject-status';
import fixture from '../../../fixtures/subject-status.json';

describe('subject status choices', () => {
  it('equals fixtures/subject-status.json, the table the Swift mirror pins', () => {
    expect(fixture.kinds).toEqual(SUBJECT_STATUS_CHOICES);
    expect(Object.keys(fixture.kinds)).toEqual([...SUBJECT_STATUS_KINDS]);
  });

  it('lists exactly the statuses Core accepts, in its order', () => {
    expect([...SUBJECT_STATUS_CHOICES.project.statuses]).toEqual([...crmProjectStatusSchema.options]);
    expect([...SUBJECT_STATUS_CHOICES.lead.statuses]).toEqual([...crmLeadStatusSchema.options]);
  });

  it('keeps open, the filter and the defaults inside the statuses', () => {
    for (const kind of SUBJECT_STATUS_KINDS) {
      const choices = SUBJECT_STATUS_CHOICES[kind];
      for (const status of choices.open) expect(choices.statuses).toContain(status);
      expect(choices.statuses).toContain(choices.defaultStatus);
      expect(choices.filter).toContain(choices.defaultFilter);
      // The filter is Core's words plus the two product choices, nothing else.
      for (const option of choices.filter) expect([...choices.statuses, 'open', 'all']).toContain(option);
      expect(choices.filter).toContain('all');
    }
  });

  it('keeps Archived and the closed leads out of open work', () => {
    expect(SUBJECT_STATUS_CHOICES.project.open).not.toContain('Archived');
    expect(SUBJECT_STATUS_CHOICES.lead.open).not.toContain('Closed Won');
    expect(SUBJECT_STATUS_CHOICES.lead.open).not.toContain('Closed Lost');
  });
});

describe('organizationRelationships (ADR 0006, meet#1258)', () => {
  const none = { projects: [], leads: [], activeLicense: false };

  it('reads each relationship from its records, in order', () => {
    expect(organizationRelationships(none)).toEqual([]);
    expect(organizationRelationships({ ...none, projects: [{ status: 'Active' }] })).toEqual(['client']);
    expect(organizationRelationships({ ...none, activeLicense: true })).toEqual(['client']);
    expect(organizationRelationships({ ...none, is_existing_client: true })).toEqual(['client']);
    expect(organizationRelationships({ ...none, is_partner: true })).toEqual(['partner']);
    expect(organizationRelationships({ ...none, leads: [{ status: 'Proposal Out' }] })).toEqual(['prospect']);
    expect(organizationRelationships({ is_partner: true, projects: [{ status: 'Paused' }], leads: [{ status: 'Conversations' }], activeLicense: false }))
      .toEqual(['client', 'partner', 'prospect']);
  });

  it('does not count closed work', () => {
    expect(organizationRelationships({ ...none, projects: [{ status: 'Archived' }], leads: [{ status: 'Closed Lost' }] })).toEqual([]);
  });
});
