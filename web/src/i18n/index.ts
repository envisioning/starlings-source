import { resolveLanguage, type Language } from '@starlings/contracts/language-values';
import { workspaceLanguage } from '../workspace-defaults';
import { readStored, StorageKeys, writeStored } from '../storage';

/**
 * The strings the web draws, in the language the person chose
 * (step 3). Keys are the English source; a table per
 * language maps them to that language's sentence, and a key the table lacks
 * renders as itself, in English, never blank. `pt-BR.json` is the one table;
 * `scripts/sync-web-strings.mjs` keeps its key set in step with the code.
 *
 * The language is decided once, when this module loads — from the synced
 * choice cached by `../language.ts`, then the browser — and every module
 * that builds a table of labels at import time reads the same answer. A
 * change made in Settings, or arriving from another device, reloads the
 * page: the same contract as the native apps, which apply a change on the
 * next launch.
 *
 * The table is not imported here: an English page must not carry the
 * Portuguese sentences in its entry chunk (scripts/check-web-entry-budget).
 * `main.tsx` loads the page's table with `loadStrings()` before it imports
 * `App`, so every module that calls `t()` at import time finds it in place.
 *
 * Zero dependencies on purpose. Interpolation is `{name}`; plurals go
 * through `Intl.PluralRules`.
 */

/** A sentence, or null: the key stays English on purpose. */
let table: Record<string, string | null> = {};

/** Fetch the page's table, once, before anything draws. English needs none. */
export async function loadStrings(): Promise<void> {
  if (uiLanguage === 'pt-BR') {
    table = (await import('./pt-BR.json')).default as Record<string, string | null>;
  }
}

/** For tests and the site's prerender: the table `t()` reads. */
export function installStrings(strings: Record<string, string | null>): void {
  table = strings;
}

/** Add a second table over the first: the product site's own sentences. */
export function addStrings(strings: Record<string, string | null>): void {
  table = { ...table, ...strings };
}

function browserLanguage(): Language {
  const tag = typeof navigator === 'undefined' ? '' : navigator.language;
  return tag.toLowerCase().startsWith('pt') ? 'pt-BR' : 'en';
}

function cachedChoice(): Language | null {
  try {
    return resolveLanguage(readStored(StorageKeys.language));
  } catch {
    return null;
  }
}

/**
 * A guest has no account to sync a choice through, so the link carries it:
 * `?lang=pt-BR` on a room or booking page. The browser remembers the last
 * one, so the next visit without the parameter draws the same way. A
 * signed-in person's synced choice still wins over both.
 */
function linkChoice(): Language | null {
  // Same reach as `document` below: the Worker compiles this module under the
  // WebWorker lib, where `window` is not declared.
  const win = (globalThis as { window?: { location: { search: string } } }).window;
  if (!win) return null;
  try {
    const fromLink = resolveLanguage(new URLSearchParams(win.location.search).get('lang'));
    if (fromLink) {
      writeStored(StorageKeys.guestLanguage, fromLink);
      return fromLink;
    }
    return resolveLanguage(readStored(StorageKeys.guestLanguage));
  } catch {
    return null;
  }
}

/**
 * A page whose address fixes its language sets `globalThis.MEET_PAGE_LANGUAGE`
 * before this module loads, and that answer beats every other: the product
 * site, where `/pt-BR/pricing` is Portuguese and `/pricing` is English for
 * every reader, and its prerender, which has no window at all.
 * The browser and a synced choice must not turn a prerendered English page
 * Portuguese on hydrate.
 */
function pageChoice(): Language | null {
  return resolveLanguage((globalThis as { MEET_PAGE_LANGUAGE?: unknown }).MEET_PAGE_LANGUAGE);
}

/** The language this page draws in, fixed for its life. */
export const uiLanguage: Language = pageChoice() ?? workspaceLanguage(cachedChoice() ?? linkChoice(), browserLanguage());

/** BCP 47 for `Intl` and `<html lang>`: what the tables call `pt-BR` is `pt-BR` there too. */
export const uiLocale: string = uiLanguage;

/**
 * The locale every date and time is written in. English is en-GB, as on Mac
 * and iPhone (`StarlingsDateFormatting.locale`): `Intl` reads a bare `en` as en-US,
 * which put the month first on the web and nowhere else.
 */
export const dateLocale: string = uiLanguage === 'en' ? 'en-GB' : uiLocale;

/** What the page would draw in after a reload, for the given synced choice. */
export function languageFor(choice: Language | null): Language {
  return pageChoice() ?? workspaceLanguage(choice ?? linkChoice(), browserLanguage());
}

export type Vars = Record<string, string | number>;

function interpolate(sentence: string, vars: Vars): string {
  return sentence.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}

/** The sentence for `key` in the page's language. `{name}` fills from `vars`. */
export function t(key: string, vars?: Vars): string {
  const sentence = table[key] || key;
  return vars ? interpolate(sentence, vars) : sentence;
}

const rules = new Intl.PluralRules(uiLocale);

/**
 * One key per plural category the language uses; English and Portuguese
 * both use `one` and `other`. `{count}` is filled in.
 */
export function plural(count: number, forms: { one: string; other: string }): string {
  const category = rules.select(count);
  const key = category === 'one' ? forms.one : forms.other;
  return t(key, { count });
}

/** Set once at startup so the browser, screen readers and fonts know the language. */
export function applyDocumentLanguage(): void {
  // Read off globalThis, not the bare name: the Worker's tests import web
  // modules under the WebWorker lib, where `document` is not declared.
  const doc = (globalThis as { document?: { documentElement: { lang: string } } }).document;
  if (doc) doc.documentElement.lang = uiLocale;
}
