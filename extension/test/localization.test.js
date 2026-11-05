import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const messages = (locale) => JSON.parse(read(`_locales/${locale}/messages.json`));

function messageReader(locale) {
  const catalog = messages(locale);
  return (key, substitutions = []) => {
    let message = catalog[key].message;
    for (const [name, placeholder] of Object.entries(catalog[key].placeholders || {})) {
      const index = Number(placeholder.content.slice(1)) - 1;
      message = message.replaceAll(`$${name}$`, substitutions[index]);
    }
    return message;
  };
}

describe('Chrome localization', () => {
  it('localizes manifest metadata and keeps both catalogs complete', () => {
    const manifest = JSON.parse(read('manifest.json'));
    expect(manifest.default_locale).toBe('en');
    expect(manifest.name).toBe('__MSG_extensionName__');
    expect(manifest.description).toBe('__MSG_extensionDescription__');
    const english = messages('en');
    const portuguese = messages('pt_BR');
    expect(Object.keys(portuguese).sort()).toEqual(Object.keys(english).sort());
    for (const key of Object.keys(english)) {
      expect(portuguese[key].message.trim(), key).not.toBe('');
      expect(portuguese[key].placeholders || {}).toEqual(english[key].placeholders || {});
    }
    for (const catalog of [english, portuguese]) expect(catalog.extensionDescription.message.length).toBeLessThanOrEqual(132);
  });

  it.each(['en', 'pt_BR'])('draws all options and substituted status in %s', async (locale) => {
    const dom = new JSDOM(read('src/options.html'), { runScripts: 'outside-only' });
    const getMessage = messageReader(locale);
    const set = vi.fn();
    dom.window.chrome = {
      i18n: { getMessage, getUILanguage: () => locale.replace('_', '-') },
      storage: { local: { get: async () => ({ token: 'paired', lastResult: { ok: true, code: 'abc-defg-hij' } }), set } },
    };
    dom.window.eval(read('src/options.js'));
    await Promise.resolve();
    const document = dom.window.document;
    expect(document.documentElement.lang).toBe(locale.replace('_', '-'));
    expect(document.title).toBe(getMessage('pairingTitle'));
    expect(document.querySelector('label').textContent).toBe(getMessage('pairingToken'));
    expect(document.querySelector('input').placeholder).toBe(getMessage('pairingPlaceholder'));
    expect(document.querySelector('[data-i18n="pairingHelp"]').textContent).toBe(getMessage('pairingHelp'));
    expect(document.querySelector('#status').textContent).toBe(getMessage('lastBatchReached', ['abc-defg-hij']));
    document.querySelector('input').value = ' new-token ';
    document.querySelector('input').dispatchEvent(new dom.window.Event('change'));
    expect(set).toHaveBeenCalledWith({ token: 'new-token' });
    dom.window.close();
  });

  it('shows the Portuguese unavailable status', async () => {
    const dom = new JSDOM(read('src/options.html'), { runScripts: 'outside-only' });
    dom.window.chrome = {
      i18n: { getMessage: messageReader('pt_BR'), getUILanguage: () => 'pt-BR' },
      storage: { local: { get: async () => ({ lastResult: { ok: false } }) } },
    };
    dom.window.eval(read('src/options.js'));
    await Promise.resolve();
    expect(dom.window.document.querySelector('#status').textContent).toBe(messages('pt_BR').lastBatchUnavailable.message);
    expect(dom.window.document.querySelector('#status').className).toBe('bad');
    dom.window.close();
  });
});
