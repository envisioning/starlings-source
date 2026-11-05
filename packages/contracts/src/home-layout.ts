import { z } from 'zod';

export * from './home-layout-values';

// Wire. Unknown ids are accepted and dropped at resolve time rather than
// refused: an older Worker must not 400 a newer client that learned a module.
export const homeModuleSettingSchema = z.object({
  id: z.string().trim().min(1).max(40),
  enabled: z.boolean(),
}).strict();
/** One row as stored and sent: the id is a string on the wire, resolved by every client. */
export type HomeModuleSettingWire = z.infer<typeof homeModuleSettingSchema>;

/** `PUT /api/home/preferences` body. */
export const homePreferencesUpdateSchema = z.object({
  modules: z.array(homeModuleSettingSchema).max(64),
}).strict();
export type HomePreferencesUpdate = z.infer<typeof homePreferencesUpdateSchema>;

/** `GET` and `PUT /api/home/preferences` response: the resolved list. */
export const homePreferencesResponseSchema = z.object({
  modules: z.array(homeModuleSettingSchema),
  /** Null until the person has saved once. */
  updated_at: z.number().int().nullable(),
});
export type HomePreferencesResponse = z.infer<typeof homePreferencesResponseSchema>;
