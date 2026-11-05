import { z } from 'zod';

export const meetEventsLifecycleKindSchema = z.enum(['call-started', 'call-ended', 'heartbeat']);

export const meetEventsBatchPersonSchema = z.object({
  name: z.string(),
  speaking: z.boolean().optional(),
});

export const meetEventsBatchLifecycleSchema = z.object({
  kind: meetEventsLifecycleKindSchema,
  atMs: z.number().int(),
  reason: z.string().optional(),
});

export const meetEventsBatchSchema = z.object({
  schemaVersion: z.number().int(),
  meetingCode: z.string(),
  capturedAtMs: z.number().int(),
  title: z.string().optional(),
  roster: z.array(meetEventsBatchPersonSchema),
  lifecycle: meetEventsBatchLifecycleSchema.optional(),
});

export type StarlingsEventsBatch = z.infer<typeof meetEventsBatchSchema>;
