import { z } from 'zod';
import { LANGUAGES } from './language-values';

export * from './language-values';

export const languageSchema = z.enum(LANGUAGES);

/** `PUT /api/profile/language` body. `null` clears the choice. */
export const languagePreferenceUpdateSchema = z.object({
  language: languageSchema.nullable(),
});

/** `GET` and `PUT /api/profile/language` response. */
export const languagePreferenceResponseSchema = z.object({
  language: languageSchema.nullable(),
  /** Nil until the person has saved once. */
  updated_at: z.number().int().nullable(),
});
export type LanguagePreferenceResponse = z.infer<typeof languagePreferenceResponseSchema>;
