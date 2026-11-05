import { describe, expect, it } from 'vitest';
import { responsibleOf, type ResponsibleSubjectShape, type ResponsibleTaskShape } from '@starlings/contracts/responsible';
import fixture from '../../../fixtures/responsible.json';

// Who answers for a project or lead (docs/OWNERSHIP.md, core#155). The rule
// runs against fixtures/responsible.json, which the Swift port reads too.

interface Case {
  name: string;
  subject: ResponsibleSubjectShape;
  tasks: ResponsibleTaskShape[];
  expect: { email: string; source: 'chosen' | 'suggested' } | null;
}

describe('responsible fixture', () => {
  it('pins chosen, suggested and none', () => {
    expect(fixture.version).toBe(1);
    for (const c of fixture.cases as Case[]) {
      expect(responsibleOf(c.subject, c.tasks), c.name).toEqual(c.expect);
    }
  });
});
