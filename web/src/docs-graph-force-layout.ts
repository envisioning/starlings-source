import { forceLink, forceManyBody, forceSimulation, forceX, forceY } from 'd3-force';
import type { Simulation, SimulationLinkDatum, SimulationNodeDatum } from 'd3-force';
import graphConfig from '../../packages/contracts/src/docs-graph-config.json';
import type { DocsDocumentSummary } from './docs';
import { compareGraphStrings, graphFolder, type GraphEdge, type Point } from './docs-graph-layout';

type GraphDocument = Pick<DocsDocumentSummary, 'id' | 'path' | 'title'>;

export interface GraphNode extends GraphDocument, SimulationNodeDatum {
  folderCenterX: number;
  folderCenterY: number;
}

export type GraphLink = SimulationLinkDatum<GraphNode>;
export type GraphSimulation = Simulation<GraphNode, GraphLink>;

const layout = graphConfig.layout;

/**
 Where each node starts and which anchor pulls it: folders on a ring wide
 enough that their settled discs don't overlap, members on a sunflower spiral
 sized to the disc the forces settle them into. Same as the native clients.
 A node already placed keeps its place and its velocity.
 */
export function seedGraphNodes(documents: GraphDocument[], previous?: ReadonlyMap<string, GraphNode>): GraphNode[] {
  const byGroup = new Map<string, GraphDocument[]>();
  for (const document of documents) {
    const group = graphFolder(document.path);
    const members = byGroup.get(group);
    if (members) members.push(document); else byGroup.set(group, [document]);
  }
  const names = [...byGroup.keys()].sort(compareGraphStrings);
  const memberRing = (count: number) => Math.max(layout.memberRingMin, Math.sqrt(count) * layout.memberRingPerSqrtDocument);
  const widest = Math.max(0, ...[...byGroup.values()].map((members) => memberRing(members.length)));
  const groupRing = names.length > 1
    ? Math.max(layout.groupRingMin, names.length * layout.groupRingPerFolder, (widest * 1.15) / Math.sin(Math.PI / names.length))
    : 0;

  const seeded = new Map<string, GraphNode>();
  names.forEach((group, groupIndex) => {
    const angle = -Math.PI / 2 + (groupIndex / names.length) * Math.PI * 2;
    const center = { x: Math.cos(angle) * groupRing, y: Math.sin(angle) * groupRing };
    const members = [...byGroup.get(group)!].sort((left, right) => compareGraphStrings(left.title, right.title)
      || compareGraphStrings(left.path, right.path)
      || compareGraphStrings(left.id, right.id));
    const ring = memberRing(members.length);
    members.forEach((document, order) => {
      const turn = order * 2.399963229728653;
      const spread = ring * Math.sqrt((order + 0.5) / members.length);
      const known = previous?.get(document.id);
      seeded.set(document.id, {
        ...document,
        folderCenterX: center.x,
        folderCenterY: center.y,
        x: known?.x ?? center.x + Math.cos(turn) * spread,
        y: known?.y ?? center.y + Math.sin(turn) * spread,
        vx: known?.vx ?? 0,
        vy: known?.vy ?? 0,
        fx: known?.fx ?? null,
        fy: known?.fy ?? null,
      });
    });
  });
  return documents.map((document) => seeded.get(document.id)!);
}

/** d3-force with the shared knobs: link springs, Barnes–Hut repulsion, folder anchors. */
export function createGraphSimulation(nodes: GraphNode[], edges: GraphEdge[]): GraphSimulation {
  return forceSimulation<GraphNode, GraphLink>(nodes)
    .alphaMin(layout.alphaMin)
    .alphaDecay(layout.alphaDecay)
    .velocityDecay(layout.velocityDecay)
    .force('links', forceLink<GraphNode, GraphLink>(graphLinks(nodes, edges))
      .id((node) => node.id)
      .distance(layout.linkLength))
    .force('charge', forceManyBody<GraphNode>().strength(layout.chargeStrength).theta(layout.theta))
    .force('folder-x', forceX<GraphNode>((node) => node.folderCenterX).strength(layout.folderStrength))
    .force('folder-y', forceY<GraphNode>((node) => node.folderCenterY).strength(layout.folderStrength));
}

export function graphLinks(nodes: GraphNode[], edges: GraphEdge[]): GraphLink[] {
  const ids = new Set(nodes.map((node) => node.id));
  return edges
    .filter(({ source, target }) => ids.has(source) && ids.has(target))
    .map(({ source, target }) => ({ source, target }));
}

/** The settled layout, run to rest in one go. The canvas animates the same simulation. */
export function layoutDocuments(documents: GraphDocument[], edges: GraphEdge[]): Map<string, Point> {
  if (documents.length === 0) return new Map();
  const nodes = seedGraphNodes(documents);
  const simulation = createGraphSimulation(nodes, edges).stop();
  while (simulation.alpha() >= layout.alphaMin) simulation.tick();
  return new Map(nodes.map((node) => [node.id, { x: node.x ?? 0, y: node.y ?? 0 }]));
}
