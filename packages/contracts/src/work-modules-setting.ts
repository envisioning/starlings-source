import { z } from 'zod';
import { WORK_MODULES, WORK_STORES } from './work-modules';

/**
 * Which work modules a workspace has on (docs/WORK_MODEL.md): the
 * workspace's setting, saved in its D1 `workspace_settings` as `work_modules`.
 * The table of what each work module is lives in `work-modules.ts`.
 */

const workModuleSchema = z.enum(WORK_MODULES);

/** `PUT /api/admin/work-modules` body: every work module that is on. */
export const workModulesUpdateSchema = z.object({
  on: z.array(workModuleSchema).max(WORK_MODULES.length),
});
export type WorkModulesUpdate = z.infer<typeof workModulesUpdateSchema>;

/**
 * `GET` and `PUT /api/admin/work-modules`. `on` is what is in force: the
 * saved choice, limited to what this workspace's store can serve. Before an
 * admin saves, a Core workspace (Envisioning) has every work module Core
 * serves on, and a D1 workspace has none.
 */
export const workModulesAdminResponseSchema = z.object({
  store: z.enum(WORK_STORES),
  on: z.array(workModuleSchema),
  /** What this workspace's store can serve, in Admin's order. */
  available: z.array(workModuleSchema),
  /** Null until an admin has saved once. */
  updated_at: z.number().int().nullable(),
});
export type WorkModulesAdminResponse = z.infer<typeof workModulesAdminResponseSchema>;
