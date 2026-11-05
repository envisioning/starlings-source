import graphConfig from '../../packages/contracts/src/docs-graph-config.json';
import { t } from './i18n';

export interface Point {
  x: number;
  y: number;
}

export interface GraphBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GraphEdge {
  source: string;
  target: string;
}

/** Compare Unicode scalar values so folder ordering is stable across locales. */
export function compareGraphStrings(left: string, right: string): number {
  const leftScalars = Array.from(left, (character) => character.codePointAt(0)!);
  const rightScalars = Array.from(right, (character) => character.codePointAt(0)!);
  const commonLength = Math.min(leftScalars.length, rightScalars.length);
  for (let index = 0; index < commonLength; index += 1) {
    const difference = leftScalars[index]! - rightScalars[index]!;
    if (difference !== 0) return difference;
  }
  return leftScalars.length - rightScalars.length;
}

/** Resolve only links whose endpoints are in the graph, once per pair. */
export function resolveGraphEdges(
  documentIDs: ReadonlySet<string>,
  candidates: Iterable<GraphEdge>,
  seenKeys = new Set<string>(),
): GraphEdge[] {
  const resolved: GraphEdge[] = [];
  for (const edge of candidates) {
    if (edge.source === edge.target || !documentIDs.has(edge.source) || !documentIDs.has(edge.target)) continue;
    const key = graphEdgeKey(edge.source, edge.target);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    resolved.push(edge);
  }
  return resolved;
}

export function graphEdgeKey(source: string, target: string): string {
  return [source, target].sort().join('\u0000');
}

export function graphFolder(path: string): string {
  const first = path.split('/').filter(Boolean)[0];
  if (!first) return t('Unfiled');
  return first.replace(/[-_]+/gu, ' ').replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
}

export function fitBounds(points: Point[]): GraphBounds {
  if (points.length === 0) {
    return { x: -520, y: -360, width: 1040, height: 720 };
  }
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const padding = graphConfig.fit.padding;
  const x = Math.min(...xs) - padding;
  const y = Math.min(...ys) - padding;
  const width = Math.max(graphConfig.fit.minWidth, Math.max(...xs) - Math.min(...xs) + padding * 2);
  const height = Math.max(graphConfig.fit.minHeight, Math.max(...ys) - Math.min(...ys) + padding * 2);
  return { x, y, width, height };
}

export function graphZoomLevel(bounds: GraphBounds, fit: GraphBounds): number {
  return fit.width / bounds.width;
}

/** Return the actual viewBox scale factor after enforcing shared limits relative to Fit. */
export function boundedZoomFactor(bounds: GraphBounds, requestedFactor: number, fit: GraphBounds): number {
  if (!Number.isFinite(requestedFactor) || requestedFactor <= 0) return 1;
  const currentZoom = graphZoomLevel(bounds, fit);
  const targetZoom = Math.max(graphConfig.zoom.min, Math.min(graphConfig.zoom.max, currentZoom / requestedFactor));
  return currentZoom / targetZoom;
}

export function scaleBounds(bounds: GraphBounds, requestedFactor: number, fit: GraphBounds): GraphBounds {
  const factor = boundedZoomFactor(bounds, requestedFactor, fit);
  const width = bounds.width * factor;
  const height = bounds.height * factor;
  const x = bounds.x + (bounds.width - width) / 2;
  const y = bounds.y + (bounds.height - height) / 2;
  return { x, y, width, height };
}
