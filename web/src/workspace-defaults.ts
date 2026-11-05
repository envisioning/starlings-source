import { SCHEDULE_TIME_ZONES } from '@starlings/contracts/calendar-values';
import { CONTACT_EMAIL, PRIVACY_CONTACT_EMAIL } from '@starlings/contracts/deployment';
import { LANGUAGES, resolveLanguage, type Language } from '@starlings/contracts/language-values';
import { workspaceBrand } from './workspace-brand';

// Zod-free: this is also read before the guest entry loads its strings.
function values(): Record<string, unknown> {
  try {
    const doc = (globalThis as { document?: { querySelector(selector: string): { content: string } | null } }).document;
    const raw = doc?.querySelector('meta[name="workspace-defaults"]')?.content;
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

export function workspaceTimeZones() {
  const ids = values().time_zones;
  const zones = Array.isArray(ids) ? SCHEDULE_TIME_ZONES.filter((zone) => ids.includes(zone.id)) : [];
  return zones.length ? zones : SCHEDULE_TIME_ZONES;
}
export function workspaceLanguages(): Language[] {
  const offered = values().languages_offered;
  const languages = Array.isArray(offered) ? LANGUAGES.filter((language) => offered.includes(language)) : [];
  return languages.length ? [...languages] : [...LANGUAGES];
}
export function workspaceLanguage(choice: Language | null, device: Language): Language {
  const offered = workspaceLanguages();
  if (choice && offered.includes(choice)) return choice;
  const preferred = resolveLanguage(values().default_language);
  return preferred && offered.includes(preferred) ? preferred : offered.includes(device) ? device : offered[0]!;
}
export function workspaceProjectGroup(): string {
  const value = values().project_group_name;
  return typeof value === 'string' && value.trim() ? value.trim() : workspaceBrand().name;
}
export function workspaceContact(privacy = false): string {
  const value = values()[privacy ? 'privacy_email' : 'contact_email'];
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)
    ? value : privacy ? PRIVACY_CONTACT_EMAIL : CONTACT_EMAIL;
}
