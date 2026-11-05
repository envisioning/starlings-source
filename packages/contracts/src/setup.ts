import { z } from 'zod';
import { SETUP_UNBLOCKERS } from './setup-steps';

export * from './setup-steps';

/**
 * The setup checklist on the wire (docs/ONBOARDING.md §The setup checklist).
 * The steps themselves, their order and their words are the registry in
 * `setup-steps.ts`; this is what `GET /api/setup` says about one viewer.
 */

/** Why a step cannot be done yet, and who can change that. */
export const setupBlockerSchema = z.object({
  reason: z.string(),
  by: z.enum(SETUP_UNBLOCKERS),
});
export type SetupBlocker = z.infer<typeof setupBlockerSchema>;

/**
 * One step for the viewer. `id` is a string, not the registry's enum: a
 * client drops an id it does not know, so a newer Worker never breaks an
 * older app.
 */
export const setupStepStateSchema = z.object({
  id: z.string(),
  done: z.boolean(),
  required: z.boolean(),
  blocked: setupBlockerSchema.nullable(),
});
export type SetupStepState = z.infer<typeof setupStepStateSchema>;

/**
 * `GET /api/setup`. `steps` are the viewer's, in the registry's order, only
 * those the viewer has the capability for. `next` is the first open step
 * nobody blocks, required ones first. `complete` is true when every required
 * step is done. `on` is false when an admin turned the checklist off for the
 * workspace; the clients then draw nothing. `can_turn_off` is true for an admin.
 */
export const setupResponseSchema = z.object({
  steps: z.array(setupStepStateSchema),
  next: z.string().nullable(),
  complete: z.boolean(),
  on: z.boolean(),
  can_turn_off: z.boolean(),
});
export type SetupResponse = z.infer<typeof setupResponseSchema>;

/** `PUT /api/admin/setup`: turn the checklist off, or back on, for the whole workspace. */
export const setupSettingUpdateSchema = z.object({
  on: z.boolean(),
}).strict();
export type SetupSettingUpdate = z.infer<typeof setupSettingUpdateSchema>;

/**
 * `PUT /api/setup/skip`: the viewer clears one step from their own checklist,
 * or brings it back. Any step, required or not. A skipped step is left out of
 * `GET /api/setup` and counts as done for `complete`. `step` is a string,
 * as `id` above; the Worker refuses an id that is not one of the viewer's.
 */
export const setupSkipUpdateSchema = z.object({
  step: z.string().trim().min(1).max(40),
  skipped: z.boolean(),
}).strict();
export type SetupSkipUpdate = z.infer<typeof setupSkipUpdateSchema>;
