import { z } from 'zod';
import { BACKGROUND_GENERATORS, BACKGROUND_TONES } from './background-gallery-values';
import { WORKSPACE_ACCENT_PATTERN } from './workspace-accent';
import { tonePairVisible } from './background-gallery';

const pairSchema = z.object({
  base: z.string().regex(WORKSPACE_ACCENT_PATTERN),
  modules: z.string().regex(WORKSPACE_ACCENT_PATTERN),
}).refine(tonePairVisible, 'The pattern must be visible against its background.');
export const workspaceBackgroundTonesSchema = z.object({ dark: pairSchema, accent: pairSchema, bright: pairSchema });
export type WorkspaceBackgroundTones = z.infer<typeof workspaceBackgroundTonesSchema>;
export const workspaceBackgroundGeneratedDefaultSchema = z.object({ mode: z.literal('generated'), generator: z.enum(BACKGROUND_GENERATORS.map(g => g.id)), tone: z.enum(BACKGROUND_TONES) });
export const workspaceBackgroundImageDefaultSchema = z.object({ mode: z.literal('image') });
export const workspaceBackgroundDefaultSchema = z.discriminatedUnion('mode', [workspaceBackgroundGeneratedDefaultSchema, workspaceBackgroundImageDefaultSchema]);
export const workspaceBackgroundUpdateSchema = z.object({
  tones: workspaceBackgroundTonesSchema.nullable(),
  default: workspaceBackgroundDefaultSchema.nullable(),
});
export type WorkspaceBackgroundUpdate = z.infer<typeof workspaceBackgroundUpdateSchema>;
export const workspaceBackgroundSettingsSchema = workspaceBackgroundUpdateSchema.extend({
  image: z.object({ key: z.literal('workspace/background'), version: z.string().min(1) }).nullable(),
});
export type WorkspaceBackgroundSettings = z.infer<typeof workspaceBackgroundSettingsSchema>;
export const workspaceBackgroundProfileSchema = z.object({
  tones: workspaceBackgroundTonesSchema,
  image_url: z.string().url().nullable(),
  default: workspaceBackgroundDefaultSchema.nullable(),
});
export type WorkspaceBackgroundProfile = z.infer<typeof workspaceBackgroundProfileSchema>;
export const workspaceBackgroundAdminResponseSchema = z.object({
  settings: workspaceBackgroundSettingsSchema,
  resolved: workspaceBackgroundProfileSchema,
  updated_at: z.number().int().nullable(),
});
export type WorkspaceBackgroundAdminResponse = z.infer<typeof workspaceBackgroundAdminResponseSchema>;

