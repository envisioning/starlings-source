import { describe, expect, it } from 'vitest';
import { SETTINGS_CLIENTS, SETTINGS_GROUPS, SETTINGS_PAGES, SETTINGS_PAGES_EVERYWHERE, settingsPages } from '@starlings/contracts/settings-pages';
import { SEARCH_SETTINGS_PAGES } from '@starlings/contracts/search-values';
import fixture from '../../../fixtures/settings-pages.json';

describe('settings pages', () => {
  it('equals fixtures/settings-pages.json, the table the Swift registry is pinned to', () => {
    expect(fixture.pages).toEqual(SETTINGS_PAGES);
    expect(fixture.everywhere).toEqual(SETTINGS_PAGES_EVERYWHERE);
  });

  it('opens a Settings door only on a page every client lists (meet#582, meet#589)', () => {
    expect([...SEARCH_SETTINGS_PAGES]).toEqual(SETTINGS_PAGES.filter((page) => SETTINGS_CLIENTS.every((client) => (page.clients as readonly string[]).includes(client))).map((page) => page.id));
    for (const client of SETTINGS_CLIENTS) {
      const listed = settingsPages(client).map((page) => page.id as string);
      for (const page of SEARCH_SETTINGS_PAGES) expect(listed).toContain(page);
    }
  });

  it('lists each page once, in a known group, for known clients', () => {
    const ids = SETTINGS_PAGES.map((page) => page.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const page of SETTINGS_PAGES) {
      expect(SETTINGS_GROUPS).toContain(page.group);
      for (const client of page.clients) expect(SETTINGS_CLIENTS).toContain(client);
    }
  });

  it('gives every client Account first and About among its pages', () => {
    for (const client of SETTINGS_CLIENTS) {
      const ids = settingsPages(client).map((page) => page.id);
      expect(ids[0]).toBe('account');
      expect(ids).toContain('about');
    }
  });

  it('keeps the web to the pages it has', () => {
    expect(settingsPages('web').map((page) => page.id)).toEqual(['account', 'home', 'work', 'calendar', 'appearance', 'about']);
  });
});
