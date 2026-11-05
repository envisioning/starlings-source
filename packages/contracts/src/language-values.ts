/**
 * The language the interface is drawn in, per person — one answer for Mac,
 * iOS and web (step 1).
 *
 * `null` is "follow the device": the Worker stores nothing and each client
 * uses whatever its platform says. A stored value wins over the device on
 * every client the person signs in to, which is the whole reason it lives
 * behind `/api/profile/language` rather than in UserDefaults or localStorage.
 *
 * Only the interface. Which languages a meeting is transcribed in is a
 * different setting (`TranscriptionLanguages`) and stays one.
 */
export const LANGUAGES = ['en', 'pt-BR'] as const;
export type Language = (typeof LANGUAGES)[number];

/**
 * A stored value an older Worker or a newer client never knew is the
 * device's choice, not an error and not a blank. Every read passes here.
 */
export function resolveLanguage(stored: unknown): Language | null {
  return (LANGUAGES as readonly string[]).includes(stored as string) ? (stored as Language) : null;
}
