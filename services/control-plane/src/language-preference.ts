// The language the interface is drawn in, per person (step 1).
// One column on `people`; `null` is "follow the device". Reads resolve
// through the contract so a value this Worker never knew — a language a
// newer build added, or a row somebody edited by hand — reads as the
// device's choice rather than as a blank.

import { resolveLanguage, type Language, type LanguagePreferenceResponse } from '@starlings/contracts/language';
import { workspaceDefaults } from './workspace-defaults';
import { ControlError } from './errors';

interface Row {
  language: string | null;
  language_updated_at: number | null;
}

export async function readLanguagePreference(env: Env, sub: string): Promise<LanguagePreferenceResponse> {
  const row = await env.USAGE.prepare('SELECT language, language_updated_at FROM people WHERE sub = ?1')
    .bind(sub)
    .first<Row>();
  return {
    language: resolveLanguage(row?.language),
    updated_at: row?.language_updated_at ?? null,
  };
}

export async function writeLanguagePreference(
  env: Env,
  sub: string,
  language: Language | null,
): Promise<LanguagePreferenceResponse> {
  if (language && !(await workspaceDefaults(env)).languages_offered.includes(language)) {
    throw new ControlError('That language is not offered in this workspace.', 400, 'invalid_request');
  }
  const now = Date.now();
  await env.USAGE.prepare('UPDATE people SET language = ?2, language_updated_at = ?3 WHERE sub = ?1')
    .bind(sub, language, now)
    .run();
  return { language, updated_at: now };
}
