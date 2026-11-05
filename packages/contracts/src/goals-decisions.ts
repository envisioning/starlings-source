import { z } from 'zod';
import { crmSubjectKindSchema } from './crm';
import { civilDay } from './upcoming';
import { civilDayOfDate } from './work-items';
import type { Decision } from '@starlings/subject-spec/schema';

/**
 * Goals and decisions, two lightweight primitives stored in Core
 * (#262).
 *
 * A goal sits on one project and gives tasks and agents direction. A
 * decision belongs to one subject of any kind and lives in that subject's
 * history. A decision may cite the goal it serves. Core validates and
 * stores both; Meet reads and writes them through the Worker the way it
 * does tasks. The rules below — which goals are live, which are late — are
 * pinned by `fixtures/goals-decisions.json`; the Swift port reads the same
 * file.
 */

/** The same four kinds as `crmSubjectKindSchema`; spelled here because `./index` re-exports this file. */
const subjectKindSchema = crmSubjectKindSchema;

export const GOAL_STATUSES = ['open', 'met', 'dropped'] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];
export const goalStatusSchema = z.enum(GOAL_STATUSES);

export const DECISION_SOURCES = ['message', 'meeting', 'manual', 'agent'] as const;
export type DecisionSource = (typeof DECISION_SOURCES)[number];
export const decisionSourceSchema = z.enum(DECISION_SOURCES);

export const GOAL_TITLE_MAX_CHARS = 200;
export const DECISION_BODY_MAX_CHARS = 2_000;

/**
 * GET /api/crm/goals?project_id=. A zod schema, not an interface: the Mac
 * and iPhone decode the Swift the generator writes from it (`wire.ts`).
 */
export const crmGoalSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  title: z.string(),
  status: goalStatusSchema,
  /** `YYYY-MM-DD`, or null when the goal has no by-when. */
  target_date: z.string().nullable(),
  /** A member id from `/api/crm/team`, or null when nobody is accountable. Core resolves the name and email. */
  owner: z.string().nullable(),
  owner_name: z.string().nullable(),
  owner_email: z.string().nullable(),
  created_by: z.string().nullable(),
  created_by_email: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string().nullable(),
  /** The project's title, on the cross-subject list only (search). */
  project_title: z.string().nullable().optional(),
});
export type CrmGoal = z.infer<typeof crmGoalSchema>;

export const crmGoalsResponseSchema = z.object({ goals: z.array(crmGoalSchema) });
export type CrmGoalsResponse = z.infer<typeof crmGoalsResponseSchema>;
export const crmGoalResponseSchema = z.object({ goal: crmGoalSchema });
export type CrmGoalResponse = z.infer<typeof crmGoalResponseSchema>;

/** GET /api/crm/decisions?subject_kind=&subject_id= */
export const crmDecisionSchema = z.object({
  id: z.string(),
  subject_kind: subjectKindSchema,
  subject_id: z.string(),
  body: z.string(),
  source: decisionSourceSchema,
  /** The thread message id, the meeting id, or the agent principal, by `source`. Null for `manual`. */
  source_ref: z.string().nullable(),
  goal_id: z.string().nullable(),
  decided_by: z.string().nullable(),
  decided_by_name: z.string().nullable(),
  decided_by_email: z.string().nullable(),
  decided_at: z.string(),
  /** The subject's title, on the cross-subject list only (search). */
  subject_title: z.string().nullable().optional(),
});
export type CrmDecision = z.infer<typeof crmDecisionSchema>;
/** Starlings' decision carries every field of the open standard's, with the same type (ADR 0005). This line stops compiling when they drift. */
export const crmDecisionConformsToStandard: (decision: CrmDecision) => Decision = (decision) => decision;

export const crmDecisionsResponseSchema = z.object({ decisions: z.array(crmDecisionSchema) });
export type CrmDecisionsResponse = z.infer<typeof crmDecisionsResponseSchema>;
export const crmDecisionResponseSchema = z.object({ decision: crmDecisionSchema });
export type CrmDecisionResponse = z.infer<typeof crmDecisionResponseSchema>;

const goalTitleSchema = z.string().trim().min(1).max(GOAL_TITLE_MAX_CHARS);
/** A plain civil day; no time and no zone, the same shape as a CMS event date. */
const civilDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'YYYY-MM-DD');

export const crmGoalCreateSchema = z.object({
  project_id: z.string().uuid(),
  title: goalTitleSchema,
  status: goalStatusSchema.optional(),
  target_date: civilDateSchema.nullable().optional(),
  owner: z.string().uuid().nullable().optional(),
}).strict();
export type CrmGoalCreateInput = z.infer<typeof crmGoalCreateSchema>;

export const crmGoalUpdateSchema = z.object({
  title: goalTitleSchema.optional(),
  status: goalStatusSchema.optional(),
  target_date: civilDateSchema.nullable().optional(),
  owner: z.string().uuid().nullable().optional(),
}).strict();
export type CrmGoalUpdateInput = z.infer<typeof crmGoalUpdateSchema>;

/**
 * A decision is written once. `source` and `source_ref` say where it came
 * from; the MCP `record_decision` tool sends `agent` with the client's name.
 */
export const crmDecisionCreateSchema = z.object({
  subject_kind: subjectKindSchema,
  subject_id: z.string().uuid(),
  body: z.string().trim().min(1).max(DECISION_BODY_MAX_CHARS),
  source: decisionSourceSchema.default('manual'),
  source_ref: z.string().trim().min(1).max(200).nullable().optional(),
  goal_id: z.string().uuid().nullable().optional(),
}).strict();
export type CrmDecisionCreateInput = z.infer<typeof crmDecisionCreateSchema>;

/** The goals a task picker offers and the Overview lists first: open ones. */
export function isLiveGoal(goal: Pick<CrmGoal, 'status'>): boolean {
  return goal.status === 'open';
}

/**
 * Late is the task rule (docs/BOARD.md card face): a live goal whose target
 * day is before today, compared as civil days. A met or dropped goal is
 * never late, whatever its date.
 */
export function isLateGoal(goal: Pick<CrmGoal, 'status' | 'target_date'>, todayMs: number, timeZone?: string): boolean {
  if (!isLiveGoal(goal)) return false;
  const day = civilDayOfDate(goal.target_date);
  if (day === null) return false;
  return day < civilDay(todayMs, timeZone);
}

/**
 * Overview order: live goals first, late before on-time, soonest target
 * first and undated last; then met, then dropped, newest change first.
 */
export function sortGoals(goals: CrmGoal[], todayMs: number, timeZone?: string): CrmGoal[] {
  const rank: Record<GoalStatus, number> = { open: 0, met: 1, dropped: 2 };
  return [...goals].sort((a, b) => {
    const status = rank[a.status] - rank[b.status];
    if (status !== 0) return status;
    if (a.status === 'open') {
      const late = Number(isLateGoal(b, todayMs, timeZone)) - Number(isLateGoal(a, todayMs, timeZone));
      if (late !== 0) return late;
      const da = civilDayOfDate(a.target_date);
      const db = civilDayOfDate(b.target_date);
      if (da !== db) {
        if (da === null) return 1;
        if (db === null) return -1;
        return da - db;
      }
      return a.title.localeCompare(b.title);
    }
    return (b.updated_at ?? b.created_at).localeCompare(a.updated_at ?? a.created_at);
  });
}
