import { describe, expect, it } from 'vitest';
import {
  crmDecisionCreateSchema,
  crmGoalCreateSchema,
  isLateGoal,
  isLiveGoal,
  sortGoals,
  type CrmGoal,
} from '@starlings/contracts/goals-decisions';
import fixture from '../../../fixtures/goals-decisions.json';

// Goals and decisions (meet#261, #262). The shared rules — live, late,
// order — run against fixtures/goals-decisions.json, which the Swift port
// reads too.

interface LateCase { name: string; goal: Pick<CrmGoal, 'status' | 'target_date'>; expect: boolean }
interface LiveCase { name: string; goal: Pick<CrmGoal, 'status'>; expect: boolean }
interface OrderCase { name: string; goals: Partial<CrmGoal>[]; expect: string[] }

const today = Date.parse(fixture.today);
const zone = fixture.time_zone;

function goal(partial: Partial<CrmGoal>): CrmGoal {
  return {
    id: 'g', project_id: 'p', title: '', status: 'open', target_date: null,
    owner: null, owner_name: null, owner_email: null,
    created_by: null, created_by_email: 'rosa@example.com', created_at: '2026-09-01T00:00:00Z', updated_at: null,
    ...partial,
  };
}

describe('goals-decisions fixture', () => {
  it('late', () => {
    for (const c of fixture.late as LateCase[]) {
      expect(isLateGoal(c.goal, today, zone), c.name).toBe(c.expect);
    }
  });

  it('live', () => {
    for (const c of fixture.live as LiveCase[]) {
      expect(isLiveGoal(c.goal), c.name).toBe(c.expect);
    }
  });

  it('order', () => {
    for (const c of fixture.order as OrderCase[]) {
      expect(sortGoals(c.goals.map(goal), today, zone).map((g) => g.id), c.name).toEqual(c.expect);
    }
  });
});

describe('goals-decisions schemas', () => {
  it('a goal needs a project and a title; the date is a civil day', () => {
    const id = 'c0ffee00-0000-4000-8000-000000000001';
    expect(crmGoalCreateSchema.safeParse({ project_id: id, title: ' Ship it ' }).success).toBe(true);
    expect(crmGoalCreateSchema.safeParse({ project_id: id, title: '' }).success).toBe(false);
    expect(crmGoalCreateSchema.safeParse({ project_id: id, title: 'x', target_date: '2026-09-21T00:00:00Z' }).success).toBe(false);
    expect(crmGoalCreateSchema.safeParse({ project_id: id, title: 'x', target_date: '2026-09-21' }).success).toBe(true);
  });

  it('a decision defaults to manual', () => {
    const id = 'c0ffee00-0000-4000-8000-000000000001';
    const parsed = crmDecisionCreateSchema.parse({ subject_kind: 'lead', subject_id: id, body: 'We go with Convex.' });
    expect(parsed.source).toBe('manual');
    expect(crmDecisionCreateSchema.safeParse({ subject_kind: 'org', subject_id: id, body: 'x' }).success).toBe(false);
  });
});
