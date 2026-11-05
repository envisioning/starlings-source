import { z } from 'zod';
import { builtInAgentInstallationSchema } from './built-in-agent';

export const managedAgentStageSchema = z.enum(['reserved', 'runtime', 'verifying', 'awaiting_admin', 'ready', 'failed', 'removed']);
export const managedAgentReadinessSchema = z.object({
  installation: builtInAgentInstallationSchema,
  stage: managedAgentStageSchema,
  accountable_sub: z.string().nullable(),
  runtime_project_id: z.string().nullable(),
  runtime_version: z.string().nullable(),
  verified_at: z.number().int().nullable(),
  failed_step: z.string().nullable(),
  retryable: z.boolean(),
}).strict();
export type ManagedAgentReadiness = z.infer<typeof managedAgentReadinessSchema>;

/** Operator bootstrap only. A model/agent key cannot call this door. */
export const managedAgentProvisionRequestSchema = z.object({
  action: z.enum(['begin', 'status', 'bind', 'verify', 'failed', 'offboard', 'erased']),
  accountable_email: z.string().email().max(320).optional(),
  installation_id: z.string().min(1).max(200).optional(),
  project_id: z.string().regex(/^prj_[A-Za-z0-9]+$/).optional(),
  runtime_origin: z.string().url().max(2048).optional(),
  runtime_version: z.string().regex(/^[a-f0-9]{7,40}$/).optional(),
  failed_step: z.enum(['runtime_create', 'runtime_configure', 'runtime_deploy', 'runtime_verify', 'runtime_erasure']).optional(),
  /**
   * `bind` only: pin a new Bots commit. Allowed only while the installation
   * is unverified and failed at configure or deploy, so a cancelled first
   * build recovers on a rerun. A verified runtime upgrades explicitly.
   */
  repin: z.literal(true).optional(),
}).strict();
/** The failed steps after which `bind` may re-pin the runtime commit. */
export const MANAGED_AGENT_REPIN_STEPS: readonly string[] = ['runtime_configure', 'runtime_deploy'];
export type ManagedAgentProvisionRequest = z.infer<typeof managedAgentProvisionRequestSchema>;
export const managedAgentBootstrapResponseSchema = z.object({
  readiness: managedAgentReadinessSchema,
  webhook_key: z.string().nullable(), inbound_key: z.string().nullable(),
}).strict();
export type ManagedAgentBootstrapResponse = z.infer<typeof managedAgentBootstrapResponseSchema>;

/** Shared server copy: every Team inspector reads the same manifest description. */
export function managedAgentDescription(state: ManagedAgentReadiness): string {
  const purpose = 'Your workspace assistant for meeting notes and proposed tasks.';
  const stage = state.installation.state === 'removed' ? 'removed' : state.installation.state === 'frozen' ? 'frozen' : state.installation.state === 'paused' ? 'paused' : state.stage;
  const descriptions: Record<string, string> = {
    reserved: 'Setup is in progress.', runtime: 'Checking the meeting runtime.', verifying: 'Verifying the meeting runtime.',
    awaiting_admin: 'Waiting for the workspace admin to sign in.', ready: 'Meeting runtime verified. Processes eligible finalized meetings and proposes tasks.',
    failed: 'Setup needs a retry from the workspace operator.', removed: 'Removed from this workspace.', frozen: 'Frozen by an admin.', paused: 'Automatic processing is paused.',
  };
  return `${purpose} ${descriptions[stage]}`;
}
