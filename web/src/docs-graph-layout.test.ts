import { describe, expect, it } from 'vitest';
import docsGraphConfig from '../../packages/contracts/src/docs-graph-config.json';
import graphFixture from '../../fixtures/docs-graph.json';
import { boundedZoomFactor, fitBounds, graphFolder, graphZoomLevel, resolveGraphEdges, scaleBounds } from './docs-graph-layout';
import { layoutDocuments } from './docs-graph-force-layout';

describe('Docs graph behavior shared with native clients', () => {
  it('uses the shared index limits, palette, and layout settings', () => {
    expect(docsGraphConfig.pageSize).toBe(200);
    expect(docsGraphConfig.maxDocuments).toBe(5_000);
    expect(docsGraphConfig.linkBatchSize).toBe(8);
    expect(docsGraphConfig.folderColors).toHaveLength(8);
    expect(docsGraphConfig.version).toBe(2);
    expect(docsGraphConfig.layout.linkLength).toBe(40);
    expect(docsGraphConfig.layout.chargeStrength).toBe(-120);
    expect(docsGraphConfig.fit.padding).toBe(90);
    expect(docsGraphConfig.zoom).toEqual({ min: 0.25, max: 4 });
  });

  it('resolves folder groups and wikilinks from the shared fixture', () => {
    const documents = graphFixture.documents;
    const documentIDs = new Set(documents.map(({ id }) => id));
    const edges = resolveGraphEdges(documentIDs, graphFixture.links);

    expect(Object.fromEntries(documents.map(({ id, path }) => [id, graphFolder(path)]))).toEqual(graphFixture.expect.groups);
    expect(edges).toEqual(graphFixture.expect.edges);
  });

  it('clusters linked nodes and fits the visible group', () => {
    const documents = graphFixture.documents;
    const edges = resolveGraphEdges(new Set(documents.map(({ id }) => id)), graphFixture.links);
    const linked = layoutDocuments(documents, edges);
    const unlinked = layoutDocuments(documents, []);
    const distance = (left: string, right: string, positions: Map<string, { x: number; y: number }>) => {
      const a = positions.get(left)!;
      const b = positions.get(right)!;
      return Math.hypot(a.x - b.x, a.y - b.y);
    };

    expect([...linked.keys()].sort()).toEqual(documents.map(({ id }) => id).sort());
    expect(distance('a', 'b', linked)).toBeLessThan(distance('a', 'b', unlinked));

    const visible = graphFixture.expect.visibleIds.map((id) => linked.get(id)!);
    const fitted = fitBounds(visible);
    const all = fitBounds([...linked.values()]);
    expect(fitted.width).toBeLessThanOrEqual(all.width);
    expect(fitted.height).toBeLessThanOrEqual(all.height);
  });

  it('clamps zoom to 25%–400% of Fit', () => {
    const fit = fitBounds([{ x: 0, y: 0 }]);
    const tooFarIn = scaleBounds(fit, 0.01, fit);
    const tooFarOut = scaleBounds(fit, 100, fit);

    expect(graphZoomLevel(tooFarIn, fit)).toBeCloseTo(docsGraphConfig.zoom.max);
    expect(graphZoomLevel(tooFarOut, fit)).toBeCloseTo(docsGraphConfig.zoom.min);
    expect(boundedZoomFactor(tooFarIn, 0.83, fit)).toBeCloseTo(1);
    expect(boundedZoomFactor(tooFarOut, 1.2, fit)).toBeCloseTo(1);
  });
});
