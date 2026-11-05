import { describe, expect, it, vi } from 'vitest';

import bootstrap from '../appearance.js?raw';

describe('public appearance bootstrap', () => {
  it('applies before mount, persists all choices, syncs tabs and survives blocked storage', () => {
    const key = 'meet.appearance.mode';
    localStorage.setItem(key, 'invalid');
    document.body.innerHTML = '<select data-site-appearance><option value="auto">System</option><option value="light">Light</option><option value="dark">Dark</option></select>';
    new Function('window', 'document', 'HTMLSelectElement', bootstrap)(window, document, HTMLSelectElement);
    expect(document.documentElement.dataset.theme).toBe('dark');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    const select = document.querySelector('select')!;
    expect(select.value).toBe('dark');
    for (const preference of ['light', 'dark', 'auto']) {
      select.value = preference;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      expect(document.documentElement.dataset.theme).toBe(preference);
      expect(localStorage.getItem(key)).toBe(preference);
    }
    localStorage.setItem(key, 'light');
    window.dispatchEvent(new StorageEvent('storage', { key }));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(select.value).toBe('light');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage blocked'); });
    select.value = 'dark';
    expect(() => select.dispatchEvent(new Event('change', { bubbles: true }))).not.toThrow();
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});
