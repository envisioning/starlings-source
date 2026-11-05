import { describe, expect, it } from 'vitest';
import { meetingAgentDecision, type MeetingAgentPolicyFacts } from '@starlings/contracts/built-in-agent';
import { requireBuiltInMeetingAgentOperation } from '../src/built-in-agent-policy';
import fixture from '../../../fixtures/built-in-meeting-agent.json';

function patched(base: unknown, patch: unknown): unknown {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return structuredClone(patch);
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) result[key] = patched(result[key], value);
  return result;
}

describe('built-in meeting agent authority fixture', () => {
  for (const testCase of fixture.cases) {
    it(testCase.name, () => {
      const facts = patched(fixture.base, testCase.patch) as MeetingAgentPolicyFacts;
      const decision = meetingAgentDecision(facts);
      expect(decision).toEqual({ allowed: testCase.reason === 'allowed', reason: testCase.reason });
      if (decision.allowed) expect(() => requireBuiltInMeetingAgentOperation(facts)).not.toThrow();
      else expect(() => requireBuiltInMeetingAgentOperation(facts)).toThrowError(expect.objectContaining({ status: 403, code: 'capability_denied' }));
    });
  }

  it('rechecks live state when a dispatch is followed by a result commit', () => {
    const facts = structuredClone(fixture.base) as MeetingAgentPolicyFacts;
    requireBuiltInMeetingAgentOperation(facts);
    facts.grant = { ...fixture.base.grant, revoked_at: 1000 };
    expect(() => requireBuiltInMeetingAgentOperation(facts)).toThrow(/grant_inactive/u);
  });

  it('does not interpret malformed authority as unlimited access', () => {
    for (const value of [null, {}, { ...fixture.base.grant, operations: [] }, { ...fixture.base.grant, extra_permission: true }]) {
      expect(meetingAgentDecision({ ...fixture.base, grant: value } as MeetingAgentPolicyFacts).allowed).toBe(false);
    }
  });
});
