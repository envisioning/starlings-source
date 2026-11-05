import { describe, expect, it, vi } from 'vitest';

/**
 * The string layer decides its language once, when the module loads, so
 * each case loads it fresh with the browser and the cached choice set up
 * first, then installs a small table of its own: what `pt-BR.json` holds is
 * step 6's business, not this test's.
 */
async function load(options: { navigator?: string; cached?: string | null; link?: string; remembered?: string; table?: Record<string, string> }) {
  vi.resetModules();
  Object.defineProperty(window.navigator, 'language', { value: options.navigator ?? 'en-US', configurable: true });
  localStorage.clear();
  window.history.replaceState({}, '', options.link ? `/room/rosa?lang=${options.link}` : '/room/rosa');
  if (options.cached) localStorage.setItem('meet-language', options.cached);
  if (options.remembered) localStorage.setItem('meet-guest-language', options.remembered);
  const module = await import('./index');
  if (options.table) module.installStrings(options.table);
  return module;
}

describe('i18n', () => {
  it('follows the browser when nothing is chosen, and the choice when there is one', async () => {
    expect((await load({ navigator: 'pt-BR' })).uiLanguage).toBe('pt-BR');
    expect((await load({ navigator: 'pt' })).uiLanguage).toBe('pt-BR');
    expect((await load({ navigator: 'en-GB' })).uiLanguage).toBe('en');
    expect((await load({ navigator: 'pt-BR', cached: 'en' })).uiLanguage).toBe('en');
    expect((await load({ navigator: 'en-US', cached: 'pt-BR' })).uiLanguage).toBe('pt-BR');
    expect((await load({ navigator: 'en-US', cached: 'xx' })).uiLanguage).toBe('en');
  });

  it('a guest link carries the language, and the browser remembers it', async () => {
    expect((await load({ navigator: 'en-US', link: 'pt-BR' })).uiLanguage).toBe('pt-BR');
    expect(localStorage.getItem('meet-guest-language')).toBe('pt-BR');
    expect((await load({ navigator: 'en-US', remembered: 'pt-BR' })).uiLanguage).toBe('pt-BR');
    expect((await load({ navigator: 'pt-BR', link: 'en' })).uiLanguage).toBe('en');
    expect((await load({ navigator: 'en-US', link: 'xx' })).uiLanguage).toBe('en');
    // A signed-in person's synced choice wins over the link.
    expect((await load({ navigator: 'en-US', link: 'pt-BR', cached: 'en' })).uiLanguage).toBe('en');
  });

  it('draws the key itself when the table has no sentence for it', async () => {
    const { t } = await load({ navigator: 'pt-BR', table: { Cancel: 'Cancelar', Untouched: '' } });
    expect(t('Cancel')).toBe('Cancelar');
    expect(t('Untouched')).toBe('Untouched');
    expect(t('Never seen')).toBe('Never seen');
  });

  it('keeps error copy in English on a Portuguese page', async () => {
    const module = await load({ navigator: 'pt-BR' });
    await module.loadStrings();
    expect(module.t('Couldn’t load your work.')).toBe('Couldn’t load your work.');
    expect(module.t('Home')).toBe('Início');
  });

  it('fills placeholders and leaves unknown ones visible', async () => {
    const { t } = await load({ navigator: 'en-US' });
    expect(t('Waiting for {name}', { name: 'Ana' })).toBe('Waiting for Ana');
    expect(t('{count} people', { count: 3 })).toBe('3 people');
    expect(t('{missing} here', {})).toBe('{missing} here');
  });

  it('picks the plural form by the language’s rules', async () => {
    const en = await load({ navigator: 'en-US' });
    expect(en.plural(1, { one: '{count} line', other: '{count} lines' })).toBe('1 line');
    expect(en.plural(2, { one: '{count} line', other: '{count} lines' })).toBe('2 lines');
    const pt = await load({ navigator: 'pt-BR', table: { '{count} line': '{count} linha', '{count} lines': '{count} linhas' } });
    expect(pt.plural(1, { one: '{count} line', other: '{count} lines' })).toBe('1 linha');
    expect(pt.plural(2, { one: '{count} line', other: '{count} lines' })).toBe('2 linhas');
    // CLDR: Portuguese counts 0 as one. That is the reason plural() asks Intl and never the code.
    expect(pt.plural(0, { one: '{count} line', other: '{count} lines' })).toBe('0 linha');
  });

  it('languageFor says what a reload would draw', async () => {
    const { languageFor } = await load({ navigator: 'pt-BR' });
    expect(languageFor(null)).toBe('pt-BR');
    expect(languageFor('en')).toBe('en');
  });
});
