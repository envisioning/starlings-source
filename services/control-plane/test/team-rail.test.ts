import { describe, expect, it } from 'vitest';
import { TEAM_RAIL_DIRECT_KIND, isStrayConversation, teamRailOrder, type TeamRailDirect } from '@starlings/contracts/team-rail';
import fixture from '../../../fixtures/team-rail.json';

describe('team rail rules', () => {
  it('names the direct conversation kind the fixture does', () => {
    expect(fixture.directKind).toBe(TEAM_RAIL_DIRECT_KIND);
  });

  it('orders the roster as fixtures/team-rail.json says, the table the Swift mirror pins', () => {
    for (const row of fixture.order) {
      expect(teamRailOrder(row.emails, row.directs as TeamRailDirect[]), row.name).toEqual(row.out);
    }
  });

  it('finds the strays the fixture lists', () => {
    for (const row of fixture.stray) {
      expect(isStrayConversation(row.direct as TeamRailDirect, new Set(row.roster), row.selfEmail), row.name).toBe(row.out);
    }
  });
});
