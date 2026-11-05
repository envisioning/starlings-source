// Google Meet's DOM is not a public API. Prefer structural markers and keep
// localized fallbacks together, independent of Chrome's own UI language.
const UI_TEXT = {
  leaveCall: ['Leave call', 'Sair da chamada', 'Sair da reunião'],
  participants: ['Participants', 'Participantes'],
  speaking: ['speaking', 'falando'],
  notSpeaking: ['not speaking', 'não está falando'],
};

const folded = (value) => (value || '').normalize('NFD').replace(/\p{M}/gu, '').trim().toLowerCase();
const includesText = (value, values) => values.some((text) => folded(value).includes(folded(text)));
const equalsText = (value, values) => values.some((text) => folded(value) === folded(text));

export function inCallUI(document) {
  if (document.querySelector('[data-call-ended="true"]')) return false;
  if (document.querySelector('[data-call-ended="false"]')) return true;
  for (const button of document.querySelectorAll('button, [role="button"]')) {
    if (includesText(button.getAttribute('aria-label'), UI_TEXT.leaveCall)) return true;
    // Material icon names are stable across UI languages; ordinary button
    // text is never used as a signal or copied into a batch.
    for (const icon of button.querySelectorAll('.google-material-icons, .google-symbols, .material-icons, [data-icon]')) {
      if ((icon.getAttribute('data-icon') || icon.textContent).trim() === 'call_end') return true;
    }
  }
  return false;
}

function speaking(tile) {
  for (const attribute of ['data-is-speaking', 'data-speaking']) {
    if (tile.hasAttribute(attribute)) return tile.getAttribute(attribute) === 'true';
  }
  if (tile.querySelector('[data-is-speaking="true"], [data-speaking="true"], .speaking, .is-speaking')) return true;
  for (const element of [tile, ...tile.querySelectorAll('[aria-label]')]) {
    const label = element.getAttribute('aria-label');
    if (!includesText(label, UI_TEXT.notSpeaking) && includesText(label, UI_TEXT.speaking)) return true;
  }
  return false;
}

export function readRoster(document) {
  const names = new Map();
  for (const tile of document.querySelectorAll('[data-participant-id]')) {
    const name = tile.getAttribute('data-self-name') || tile.querySelector('[data-self-name]')?.getAttribute('data-self-name')
      || tile.querySelector('span[jsname]')?.textContent?.trim();
    if (name?.trim()) names.set(name.trim(), { name: name.trim(), speaking: speaking(tile) });
  }
  const items = new Set(document.querySelectorAll('[role="list"] [role="listitem"] [data-self-name]'));
  for (const panel of document.querySelectorAll('[aria-label]')) {
    if (!equalsText(panel.getAttribute('aria-label'), UI_TEXT.participants)) continue;
    for (const item of panel.querySelectorAll('[role="listitem"]')) items.add(item);
  }
  for (const item of items) {
    const name = item.getAttribute('data-self-name') || item.querySelector('[data-self-name]')?.getAttribute('data-self-name')
      || item.textContent?.trim().split('\n')[0];
    if (name?.trim() && !names.has(name.trim())) names.set(name.trim(), { name: name.trim(), speaking: speaking(item) });
  }
  // A call includes the local participant. No readable name means unknown,
  // never a roster update that erases the last successful observation.
  return names.size ? [...names.values()] : null;
}

export function pageTitle(document) {
  const title = document.title.replace(/^(?:Google\s+)?Meet(?:\s*[-–—|]\s*|\s*$)/i, '').trim();
  return title || null;
}
