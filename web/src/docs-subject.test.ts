import { describe, expect, it } from 'vitest';
import { docsSubjectOf } from './docs';

describe('docsSubjectOf', () => {
  it('files a partner as its organization, same id', () => {
    expect(docsSubjectOf({ system: 'core', kind: 'organization', subject_id: 'org-1' }))
      .toEqual({ system: 'core', kind: 'organization', subject_id: 'org-1' });
  });

  it('leaves the kinds Docs already takes', () => {
    const lead = { system: 'core', kind: 'lead', subject_id: 'l-1' };
    expect(docsSubjectOf(lead)).toBe(lead);
  });
});
