import { describe, expect, it } from 'vitest';
import { registryMarkdown } from './page-markdown';
import { capabilityById } from '@starlings/contracts/capabilities';
import { PRODUCT_AREAS, CROSS_AREA_FEATURES, PRODUCT_MESSAGE, PRODUCT_AGENT_MESSAGE, productAreaHref, FEATURES, THEMES, feature, surfacesOf } from './features';

/*
 * The feature library's guards (meet#829). A page can only name ids the
 * types allow; these hold what the types cannot: every claim stands on a
 * shipped capability, every feature is told in exactly one theme, and a
 * theme drawn at a glance has a drawing to show.
 */
describe('feature library', () => {
  it('stands every claim on a shipped capability', () => {
    for (const entry of Object.values(FEATURES)) {
      if (!entry.capability) continue;
      const row = capabilityById(entry.capability);
      expect(row, `${entry.id} names ${entry.capability}`).toBeDefined();
      expect(['have', 'partial'], `${entry.id} stands on ${entry.capability}`).toContain(row!.intent);
      expect(surfacesOf(entry).length, `${entry.id} works nowhere`).toBeGreaterThan(0);
    }
  });

  it('tells every feature in exactly one theme', () => {
    const told = THEMES.flatMap((theme) => theme.features);
    expect(new Set(told).size, 'a feature is in two themes').toBe(told.length);
    expect([...told].sort()).toEqual(Object.keys(FEATURES).sort());
  });

  it('gives each theme one anchor on its page', () => {
    const places = THEMES.map((theme) => `${theme.page}#${theme.anchor}`);
    expect(new Set(places).size).toBe(places.length);
  });

  it('draws every glance', () => {
    for (const theme of THEMES) {
      if (theme.glance) expect(feature(theme.glance.figure).figure, `${theme.id} glance`).toBeDefined();
    }
  });
});


describe('product hierarchy', () => {
  it('classifies every feature once without turning agents or foundations into areas', () => {
    const classified = [...PRODUCT_AREAS.flatMap((area) => area.features), ...Object.values(CROSS_AREA_FEATURES).flat()];
    expect(new Set(classified).size, 'a feature has two primary classifications').toBe(classified.length);
    expect([...classified].sort()).toEqual(Object.keys(FEATURES).sort());
    for (const area of PRODUCT_AREAS) expect(area.features).toContain(area.feature);
  });

  it('leads with shared work and keeps planning and credentials supporting', () => {
    expect(PRODUCT_AREAS.filter((area) => area.emphasis === 'primary').map((area) => area.id)).toEqual(['work', 'messages', 'calls', 'docs']);
    expect(PRODUCT_AREAS.filter((area) => area.emphasis === 'supporting').map((area) => area.id)).toEqual(['calendar', 'keep']);
  });

  it('gives agent readers the same outcomes, order and detail links', () => {
    const markdown = registryMarkdown('/workspace', 'https://site.example')!;
    expect(markdown).toContain(PRODUCT_MESSAGE);
    expect(markdown).toContain(PRODUCT_AGENT_MESSAGE);
    let previous = -1;
    for (const area of PRODUCT_AREAS) {
      const line = `- **[${area.name}](https://site.example${productAreaHref(area)})**: ${area.outcome}`;
      const position = markdown.indexOf(line);
      expect(position).toBeGreaterThan(previous);
      previous = position;
      const home = THEMES.find((theme) => theme.features.includes(area.feature))!;
      expect(productAreaHref(area)).toBe(`${home.page}#feature-${area.feature}`);
    }
  });
});
