import { describe, expect, it } from 'vitest';
import {
  LEAD_QUALIFICATION_KEYS,
  leadQualification,
  leadQualificationCount,
  mergeLeadQualification,
} from '@starlings/contracts/lead-qualification';
import fixture from '../../../fixtures/lead-qualification.json';

describe('lead qualification checks', () => {
  it('equals fixtures/lead-qualification.json, the table the Swift mirror pins', () => {
    expect(fixture.keys).toEqual([...LEAD_QUALIFICATION_KEYS]);
  });

  it('reads absent as false and counts what is set', () => {
    expect(leadQualificationCount(null)).toEqual({ done: 0, total: 5 });
    expect(leadQualificationCount({ project_fit: true, event_timeline: false, other: true })).toEqual({ done: 1, total: 5 });
    expect(leadQualification({ budget_availability: true }).stakeholder_buy_in).toBe(false);
  });

  it('merges the named checks and keeps every other characteristic', () => {
    expect(mergeLeadQualification({ custom: true, project_fit: true }, { project_fit: false, budget_availability: true, custom: false }))
      .toEqual({ custom: true, project_fit: false, budget_availability: true });
  });
});
