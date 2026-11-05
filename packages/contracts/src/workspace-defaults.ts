import { z } from 'zod';
import { SCHEDULE_TIME_ZONES } from './calendar-values';
import { CONTACT_EMAIL, PRIVACY_CONTACT_EMAIL } from './deployment';
import { LANGUAGES } from './language-values';

const zoneIds = SCHEDULE_TIME_ZONES.map((zone) => zone.id);
const unique = (values: readonly string[]) => new Set(values).size === values.length;

/** Admin › People; one JSON row, workspace_settings.defaults (#866). Null uses the workspace's existing fallback. */
const defaultsFieldsSchema = z.object({
  time_zones: z.array(z.enum(zoneIds)).min(1).max(zoneIds.length).refine(unique).default(zoneIds),
  default_language: z.enum(LANGUAGES).nullable().default(null),
  languages_offered: z.array(z.enum(LANGUAGES)).min(1).max(LANGUAGES.length).refine(unique).default([...LANGUAGES]),
  contact_email: z.string().trim().email().max(254).default(CONTACT_EMAIL),
  privacy_email: z.string().trim().email().max(254).default(PRIVACY_CONTACT_EMAIL),
  ai_filing_persona: z.string().trim().min(1).max(2000).nullable().default(null),
  project_group_name: z.string().trim().min(1).max(60).nullable().default(null),
  /** Public JSON with the existing public-events projection, fetched without credentials. */
  public_events_feed: z.string().url().max(2048).nullable().default(null),
  /** Workspace fallback only: a member's saved booking settings still win. */
  booking_slot_minutes: z.number().int().min(5).max(240).nullable().default(null),
}).strict();
const defaultIsOffered = (value: z.infer<typeof defaultsFieldsSchema>) => value.default_language === null || value.languages_offered.includes(value.default_language);
const offeredMessage = {
  message: 'The default language must be offered.', path: ['default_language'],
};
export const workspaceDefaultsSchema = defaultsFieldsSchema.refine(defaultIsOffered, offeredMessage);
// Separate schema identity keeps an input's optional fields out of the generated response type.
export const workspaceDefaultsUpdateSchema = z.object(defaultsFieldsSchema.shape).strict().refine(defaultIsOffered, offeredMessage);
export type WorkspaceDefaults = z.infer<typeof workspaceDefaultsSchema>;

/** Only the presentation defaults are published in the public descriptor and page head. */
export const workspaceClientDefaultsSchema = defaultsFieldsSchema.pick({
  time_zones: true, default_language: true, languages_offered: true, project_group_name: true,
});
export type WorkspaceClientDefaults = z.infer<typeof workspaceClientDefaultsSchema>;

export const workspaceDefaultsAdminResponseSchema = z.object({
  defaults: workspaceDefaultsSchema,
  source: z.enum(['settings', 'default']),
  updated_at: z.number().int().nullable(),
});
export type WorkspaceDefaultsAdminResponse = z.infer<typeof workspaceDefaultsAdminResponseSchema>;

/** External feeds keep Core's existing projection; clients validate the event rows they can read. */
export const publicEventsFeedSchema = z.object({ events: z.array(z.unknown()).max(1000) }).passthrough();
