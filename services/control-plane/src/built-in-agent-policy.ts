// The built-in meeting policy is separate from the roster agent's general MCP
// reader. In particular, an exact automatic product grant does not change
// agent-boundary.ts or pretend that a human addressed an agent (#1082).
import { meetingAgentDecision, type MeetingAgentPolicyFacts } from '@starlings/contracts/built-in-agent';
import { ControlError } from './errors';

/** Call before dispatch and before accepting a result, with freshly loaded server facts. */
export function requireBuiltInMeetingAgentOperation(facts: MeetingAgentPolicyFacts): void {
  const decision = meetingAgentDecision(facts);
  if (!decision.allowed) {
    throw new ControlError(`Meeting assistance refused: ${decision.reason}.`, 403, 'capability_denied');
  }
}
