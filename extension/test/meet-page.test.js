import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { inCallUI, pageTitle, readRoster } from '../src/meet-page.js';

function page(body, title = 'Google Meet - Planejamento') {
  const dom = new JSDOM(`<title>${title}</title>${body}`);
  return dom.window.document;
}

describe('Google Meet observations', () => {
  it.each([
    ['Leave call', 'Participants', 'Ana is speaking', 'Bo is not speaking'],
    ['Sair da chamada', 'Participantes', 'Ana está falando', 'Bo não está falando'],
  ])('reads call, roster and speaking state with %s', (leave, participants, speaking, silent) => {
    const document = page(`
      <button aria-label="${leave}"></button>
      <div data-participant-id="a" data-self-name="Ana"><span aria-label="${speaking}"></span></div>
      <div data-participant-id="b" data-self-name="Bo"><span aria-label="${silent}"></span></div>
      <aside aria-label="${participants}"><div role="listitem"><span data-self-name="Carla"></span></div></aside>
    `);
    expect(inCallUI(document)).toBe(true);
    expect(readRoster(document)).toEqual([
      { name: 'Ana', speaking: true }, { name: 'Bo', speaking: false }, { name: 'Carla', speaking: false },
    ]);
    expect(pageTitle(document)).toBe('Planejamento');
    document.querySelector('button').remove();
    expect(inCallUI(document)).toBe(false);
  });

  it('uses structural signals even when labels are in another language', () => {
    const document = page(`
      <button aria-label="Auflegen"><i class="google-material-icons">call_end</i></button>
      <div data-participant-id="a" data-self-name="Ana" data-is-speaking="true"></div>
      <div data-participant-id="b" data-self-name="Bo" data-speaking="false"><span aria-label="speaking"></span></div>
    `);
    expect(inCallUI(document)).toBe(true);
    expect(readRoster(document)).toEqual([{ name: 'Ana', speaking: true }, { name: 'Bo', speaking: false }]);
    document.body.dataset.callEnded = 'true';
    expect(inCallUI(document)).toBe(false);
  });

  it('returns unknown after selectors disappear and ignores unrelated text', () => {
    const document = page('<p>Participants speaking Leave call</p><input value="Private message">');
    expect(inCallUI(document)).toBe(false);
    expect(readRoster(document)).toBeNull();
  });

  it('reads structural roster rows without a translated panel name and deduplicates tiles', () => {
    const document = page(`
      <div data-participant-id="a" data-self-name="Ana" data-speaking="true"></div>
      <div role="list"><div role="listitem"><span data-self-name="Ana"></span></div></div>
    `);
    expect(readRoster(document)).toEqual([{ name: 'Ana', speaking: true }]);
  });

  it.each(['Meet', 'Google Meet', 'Meet - ', 'Google Meet — '])('omits the generic title %s', (title) => {
    expect(pageTitle(page('', title))).toBeNull();
  });
});
