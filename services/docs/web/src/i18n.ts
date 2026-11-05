/**
 * Docs' `t()` for the components copied from Meet (scripts/sync-meet-ui.mjs).
 * Meet's dialog, sheet and spinner import `t` from `../i18n`. Docs is in
 * English only, so the key is the sentence.
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  if (!vars) return key;
  return key.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}
