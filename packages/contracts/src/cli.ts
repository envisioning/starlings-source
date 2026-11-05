import { z } from 'zod';

/** The same-user Unix socket protocol shared by Starlings.app and starlings. */
export const meetCLIRequestSchema = z.object({
  version: z.number().int(),
  id: z.string(),
  command: z.string(),
  arguments: z.record(z.string(), z.string()),
}).strict();
export type StarlingsCLIRequest = z.infer<typeof meetCLIRequestSchema>;

export const meetCLIErrorPayloadSchema = z.object({
  code: z.string(),
  message: z.string(),
}).strict();
export type StarlingsCLIErrorPayload = z.infer<typeof meetCLIErrorPayloadSchema>;

export const meetCLIIdentityStateSchema = z.object({
  name: z.string(),
  email: z.string(),
}).strict();
export type StarlingsCLIIdentityState = z.infer<typeof meetCLIIdentityStateSchema>;

export const meetCLIDeviceStateSchema = z.object({
  id: z.string(),
  name: z.string(),
  selected: z.boolean(),
}).strict();
export type StarlingsCLIDeviceState = z.infer<typeof meetCLIDeviceStateSchema>;

export const meetCLIWaitingGuestStateSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
}).strict();
export type StarlingsCLIWaitingGuestState = z.infer<typeof meetCLIWaitingGuestStateSchema>;

export const meetCLIHostApplianceStateSchema = z.object({
  wake_assertion_active: z.boolean(),
  lease_healthy: z.boolean(),
  detail: z.string(),
}).strict();
export type StarlingsCLIHostApplianceState = z.infer<typeof meetCLIHostApplianceStateSchema>;

export const meetCLIMediaStateSchema = z.object({
  microphone_enabled: z.boolean(),
  camera_enabled: z.boolean(),
  screen_share_enabled: z.boolean(),
  background_blur_enabled: z.boolean(),
  selected_camera_id: z.string().nullable().optional(),
  selected_microphone_id: z.string().nullable().optional(),
  selected_speaker_id: z.string().nullable().optional(),
}).strict();
export type StarlingsCLIMediaState = z.infer<typeof meetCLIMediaStateSchema>;

export const meetCLIStateSchema = z.object({
  phase: z.string(),
  role: z.string(),
  room: z.string(),
  meeting_id: z.string().nullable().optional(),
  status: z.string(),
  identity: meetCLIIdentityStateSchema,
  authenticated_owner_email: z.string().nullable().optional(),
  participant_count: z.number().int(),
  camera_permission: z.string(),
  microphone_permission: z.string(),
  media: meetCLIMediaStateSchema,
  cameras: z.array(meetCLIDeviceStateSchema),
  microphones: z.array(meetCLIDeviceStateSchema),
  speakers: z.array(meetCLIDeviceStateSchema),
  waiting_guest: meetCLIWaitingGuestStateSchema.nullable().optional(),
  waiting_guests: z.array(meetCLIWaitingGuestStateSchema),
  host_appliance: meetCLIHostApplianceStateSchema.nullable().optional(),
}).strict();
export type StarlingsCLIState = z.infer<typeof meetCLIStateSchema>;

export const meetCLIOutputSchema = z.object({
  transcript: z.string().nullable().optional(),
  waiting_guests: z.array(meetCLIWaitingGuestStateSchema).nullable().optional(),
}).strict();
export type StarlingsCLIOutput = z.infer<typeof meetCLIOutputSchema>;

export const meetCLIResponseSchema = z.object({
  version: z.number().int(),
  id: z.string(),
  ok: z.boolean(),
  message: z.string(),
  state: meetCLIStateSchema.nullable().optional(),
  output: meetCLIOutputSchema.nullable().optional(),
  error: meetCLIErrorPayloadSchema.nullable().optional(),
}).strict();
export type StarlingsCLIResponse = z.infer<typeof meetCLIResponseSchema>;
