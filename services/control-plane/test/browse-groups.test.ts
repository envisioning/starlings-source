import { describe, expect, it } from 'vitest';
import { BROWSE_GROUPS, BROWSE_GROUP_ORDER, browseGroupShown } from '@starlings/contracts/browse-groups';
import { SUBJECT_GROUPS } from '@starlings/contracts/subject-state-values';
import { SUBJECT_KINDS } from '@starlings/contracts/subject-kinds';
import fixture from '../../../fixtures/browse-groups.json';

describe('browse groups', () => {
  it('equals fixtures/browse-groups.json, the table the Swift mirror pins', () => {
    expect(fixture.order).toEqual([...BROWSE_GROUP_ORDER]);
    expect(fixture.groups).toEqual(BROWSE_GROUPS);
  });

  it('shows every group, and the Sales one only with Sales on', () => {
    for (const row of fixture.shown) {
      expect(browseGroupShown(row.group as keyof typeof BROWSE_GROUPS, row.salesEnabled), `${row.group} ${row.salesEnabled}`).toBe(row.out);
    }
  });

  it('covers exactly the subject groups, in their order', () => {
    expect(BROWSE_GROUP_ORDER).toEqual([...SUBJECT_GROUPS]);
    expect(Object.keys(BROWSE_GROUPS)).toEqual([...SUBJECT_GROUPS]);
  });

  it('keeps one preference key per group and only real subject kinds', () => {
    const keys = Object.values(BROWSE_GROUPS).map((spec) => spec.preferenceKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const spec of Object.values(BROWSE_GROUPS)) expect(SUBJECT_KINDS).toContain(spec.subjectKind);
  });

  it('gives a status filter only to the kinds that have a status', () => {
    for (const spec of Object.values(BROWSE_GROUPS)) {
      if (spec.list === null) expect(['organization', 'event']).toContain(spec.subjectKind);
      else expect(['project', 'lead']).toContain(spec.subjectKind);
    }
  });
});
