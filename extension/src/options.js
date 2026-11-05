document.documentElement.lang = chrome.i18n.getUILanguage().replaceAll('_', '-');
for (const element of document.querySelectorAll('[data-i18n]')) {
  element.textContent = chrome.i18n.getMessage(element.dataset.i18n);
}
for (const element of document.querySelectorAll('[data-i18n-placeholder]')) {
  element.placeholder = chrome.i18n.getMessage(element.dataset.i18nPlaceholder);
}

const field = document.getElementById('token');
const status = document.getElementById('status');
chrome.storage.local.get(['token', 'lastResult']).then(({ token, lastResult }) => {
  field.value = token || '';
  if (lastResult) {
    status.textContent = lastResult.ok
      ? chrome.i18n.getMessage('lastBatchReached', [String(lastResult.code ?? '')])
      : chrome.i18n.getMessage('lastBatchUnavailable');
    status.className = lastResult.ok ? 'ok' : 'bad';
  }
});
field.addEventListener('change', () => chrome.storage.local.set({ token: field.value.trim() }));
