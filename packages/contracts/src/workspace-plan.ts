import { z } from 'zod';
import { WORKSPACE_PLAN_IDS } from './workspace-plans';

/**
 * The workspace's plan on the wire. The rules and the table are
 * `workspace-plans.ts`; this file is only the shapes the routes answer and
 * take.
 */

export const workspacePlanIdSchema = z.enum(WORKSPACE_PLAN_IDS);

/**
 * `GET /api/workspace/plan`, read by every member. `kept_project_id` is the
 * one writable project on Free; null when nothing is frozen.
 * `kept_project_picked` is true once an admin has chosen it, and the choice
 * is final.
 */
export const workspacePlanResponseSchema = z.object({
  plan: workspacePlanIdSchema,
  /** How many projects the plan allows, in any status. Null is no limit. */
  project_limit: z.number().int().nullable(),
  kept_project_id: z.string().nullable(),
  kept_project_picked: z.boolean(),
  /** Null until a root admin has set a plan. */
  updated_at: z.number().int().nullable(),
});
export type WorkspacePlanResponse = z.infer<typeof workspacePlanResponseSchema>;

/** `PUT /api/admin/plan`: a root admin sets the plan, until billing sets it. */
export const workspacePlanUpdateSchema = z.object({
  plan: workspacePlanIdSchema,
}).strict();
export type WorkspacePlanUpdate = z.infer<typeof workspacePlanUpdateSchema>;

/** `PUT /api/admin/plan/kept-project`: an admin picks the one writable project on Free, once. */
export const workspaceKeptProjectUpdateSchema = z.object({
  project_id: z.string().trim().min(1).max(200),
}).strict();
export type WorkspaceKeptProjectUpdate = z.infer<typeof workspaceKeptProjectUpdateSchema>;
