// The topology registry is data two pages draw and a reader is asked to trust
// (`packages/contracts/src/topology.ts`). Every row parses, every path and doc
// it names exists, every line lands on a box — and the invariants of AGENTS.md
// hold as data, not as prose: no line carries media anywhere but to LiveKit.
//
// The layout is here too, because a drawing nobody can read is as wrong as a
// row that lies: at both densities and both widths, no two boxes may overlap
// and nothing may fall outside the frame.
import { describe, expect, it } from 'vitest';
import {
  childNodes,
  TOPOLOGY_EDGES,
  TOPOLOGY_LANES,
  TOPOLOGY_NODES,
  topologyEdgeSchema,
  topologyGraph,
  topologyInvariants,
  topologyLanes,
  topologyNodeById,
  topologyNodeSchema,
  topLevelNodes,
  type TopologyNode,
} from '@starlings/contracts/topology';
import { DIAGRAM, diagramOptions, layoutTopology, wrapLabel, type TopologyBox } from './topology-layout';

// What the repo holds, as paths from its root. Vite keys a glob relative to
// this file — and normalises a pattern that walks back into `web/src` to
// `./…` — so each group is put back together with the prefix it came from.
const rootward = (globbed: Record<string, unknown>) => Object.keys(globbed).map((key) => key.replace(/^\.\.\/\.\.\//u, ''));
// These globs answer only whether a path exists. A URL query keeps Markdown,
// Swift and SQL files out of Vite's JavaScript import analysis.
const files = new Set([
  ...rootward(import.meta.glob('../../docs/**/*.md', { query: '?url' })),
  ...rootward(import.meta.glob('../../Sources/**/*.swift', { query: '?url' })),
  ...rootward(import.meta.glob('../../iOS/**/*.swift', { query: '?url' })),
  ...rootward(import.meta.glob('../../watchOS/**/*.swift', { query: '?url' })),
  ...rootward(import.meta.glob('../../extension/**/*', { query: '?url' })),
  ...rootward(import.meta.glob('../../services/control-plane/src/**/*.ts', { query: '?url' })),
  ...rootward(import.meta.glob('../../services/control-plane/migrations/*.sql', { query: '?url' })),
  ...Object.keys(import.meta.glob('./*.tsx', { query: '?url' })).map((key) => `web/src/${key.replace(/^\.\//u, '')}`),
]);

// The public tree ships docs/help and docs/adr only, so the rest of a row's docs stay here.
const docsShipped = files.has('docs/SURFACES.md');

function exists(path: string): boolean {
  return files.has(path) || [...files].some((file) => file.startsWith(`${path}/`));
}

const byId = new Map(TOPOLOGY_NODES.map((node) => [node.id, node]));
const parentOf = (node: TopologyNode) => (node.parent ? byId.get(node.parent) : undefined);

describe('topology registry', () => {
  it('parses every row', () => {
    for (const node of TOPOLOGY_NODES) expect(() => topologyNodeSchema.parse(node), node.id).not.toThrow();
    for (const edge of TOPOLOGY_EDGES) expect(() => topologyEdgeSchema.parse(edge), `${edge.from}→${edge.to}`).not.toThrow();
  });

  it('has one row per id', () => {
    const ids = TOPOLOGY_NODES.map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('names only files and docs that exist', () => {
    for (const node of TOPOLOGY_NODES) {
      if (node.code) expect(exists(node.code), `${node.id}: ${node.code}`).toBe(true);
      if (node.doc && docsShipped) expect(exists(node.doc), `${node.id}: ${node.doc}`).toBe(true);
    }
    for (const edge of TOPOLOGY_EDGES) {
      if (edge.doc && docsShipped) expect(exists(edge.doc), `${edge.from}→${edge.to}: ${edge.doc}`).toBe(true);
    }
  });

  it('collapses one level, into a box in the same lane', () => {
    for (const node of TOPOLOGY_NODES) {
      if (!node.parent) continue;
      const parent = parentOf(node);
      expect(parent, `${node.id}: unknown parent ${node.parent}`).toBeDefined();
      expect(parent?.parent, `${node.id}: its parent is itself nested`).toBeUndefined();
      expect(parent?.lane, `${node.id} sits in a different lane from its parent`).toBe(node.lane);
    }
  });

  it('lands every line on a box, and never on itself', () => {
    for (const edge of TOPOLOGY_EDGES) {
      expect(byId.has(edge.from), `${edge.from} is not a box`).toBe(true);
      expect(byId.has(edge.to), `${edge.to} is not a box`).toBe(true);
      expect(edge.from, 'a line from a box to itself').not.toBe(edge.to);
    }
  });

  it('keeps the public drawing to boxes the public drawing has', () => {
    // An `overview` line may only join two boxes that are not collapsed into
    // another — otherwise it would point at something that is not drawn.
    for (const edge of TOPOLOGY_EDGES.filter((row) => row.detail === 'overview')) {
      for (const end of [edge.from, edge.to]) {
        const node = byId.get(end);
        expect(node?.parent, `${edge.from}→${edge.to} touches nested ${end}`).toBeUndefined();
        expect(node?.detail, `${edge.from}→${edge.to} touches ${end}, which the public drawing does not have`).not.toBe('full');
      }
    }
  });

  it('draws no box nothing reaches', () => {
    const touched = new Set(TOPOLOGY_EDGES.flatMap((edge) => [edge.from, edge.to]));
    for (const node of topLevelNodes()) {
      const nested = TOPOLOGY_NODES.some((row) => row.parent === node.id);
      expect(touched.has(node.id) || nested, `${node.id} has no line and holds nothing`).toBe(true);
    }
  });

  it('gives every lane of the drawing at least one box', () => {
    for (const lane of topologyLanes('full')) expect(lane.nodes.length, lane.id).toBeGreaterThan(0);
    // A column sits beside a lane that is itself drawn.
    for (const lane of TOPOLOGY_LANES) {
      if (!lane.beside) continue;
      expect(TOPOLOGY_LANES.some((other) => other.id === lane.beside), `${lane.id} sits beside nothing`).toBe(true);
    }
  });
});

describe('the invariants, as data', () => {
  it('carries media to LiveKit and nowhere else', () => {
    // AGENTS.md §Invariants 1 and 2: the Worker holds text only, and the
    // hosting device is never the relay. Both are true of the registry or the
    // drawing tells a lie about the product.
    for (const edge of TOPOLOGY_EDGES.filter((row) => row.over === 'webrtc')) {
      expect(edge.to, `${edge.from}→${edge.to} carries media somewhere else`).toBe('livekit');
      expect(edge.never, `${edge.from}→${edge.to} carries media and promises nothing`).toBeDefined();
    }
  });

  it('never runs a stream through the control plane or its store', () => {
    const inside = new Set(TOPOLOGY_NODES.filter((node) => node.id === 'worker' || node.parent === 'worker' || node.id === 'store' || node.parent === 'store').map((node) => node.id));
    for (const edge of TOPOLOGY_EDGES) {
      if (!inside.has(edge.from) && !inside.has(edge.to)) continue;
      expect(edge.over, `${edge.from}→${edge.to} is a media transport into the control plane`).not.toBe('webrtc');
      expect(/\b(audio|video|recording|stream)\b/iu.test(edge.carries), `${edge.from}→${edge.to} carries ${edge.carries}`).toBe(false);
    }
  });

  it('never joins two devices directly', () => {
    // A guest's media reaches the room through LiveKit. A line straight from
    // the browser to the hosting device would make that device the relay.
    for (const edge of TOPOLOGY_EDGES) {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      const both = from?.lane === 'people' && to?.lane === 'people';
      if (!both) continue;
      expect(from?.parent ?? from?.id, `${edge.from}→${edge.to} joins two devices that are not the same one`).toBe(to?.parent ?? to?.id);
    }
  });

  it('writes every promise as a sentence a page can print', () => {
    for (const { sentence } of topologyInvariants()) {
      expect(sentence).toContain('Never:');
      expect(sentence.length).toBeGreaterThan(30);
    }
  });
});

describe('the drawing', () => {
  const overlap = (a: TopologyBox, b: TopologyBox) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

  for (const detail of ['overview', 'full'] as const) {
    for (const perRow of [2, 4]) {
      it(`lays ${detail} out at ${perRow} to a row without a collision`, () => {
        const diagram = layoutTopology(detail, { perRow });
        const { nodes, edges } = topologyGraph(detail);

        // The public drawing also hangs a chip under each box that collapses
        // others; the full one holds them inside instead.
        const chips = detail === 'overview' ? nodes.reduce((total, node) => total + childNodes(node.id).length, 0) : 0;
        expect(diagram.boxes.length).toBe(nodes.length + chips);
        expect(diagram.lines.length).toBe(edges.length);

        for (const box of diagram.boxes) {
          expect(box.width, box.node.id).toBeGreaterThan(0);
          expect(box.x, box.node.id).toBeGreaterThanOrEqual(0);
          expect(box.y, box.node.id).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width, box.node.id).toBeLessThanOrEqual(diagram.width + 0.01);
          expect(box.y + box.height, box.node.id).toBeLessThanOrEqual(diagram.height + 0.01);
        }

        for (const [index, a] of diagram.boxes.entries()) {
          for (const b of diagram.boxes.slice(index + 1)) {
            // A child sits inside its own parent; nothing else may touch.
            if (a.children.includes(b) || b.children.includes(a)) continue;
            expect(overlap(a, b), `${a.node.id} overlaps ${b.node.id}`).toBe(false);
          }
        }
      });
    }
  }

  it('starts every line on one box and ends it on another', () => {
    const diagram = layoutTopology('full');
    for (const line of diagram.lines) {
      expect(line.path.startsWith('M ')).toBe(true);
      expect(line.path).toContain(' C ');
      expect(line.from.x === line.to.x && line.from.y === line.to.y, `${line.edge.from}→${line.edge.to}`).toBe(false);
    }
  });

  it('writes a line label in clear air, never on a box', () => {
    for (const detail of ['overview', 'full'] as const) {
      const diagram = layoutTopology(detail, diagramOptions(detail, 4));
      for (const line of diagram.lines) {
        // A line drawn inside one box carries no label; the prose has it.
        const nested = topologyNodeById(line.edge.from)?.parent;
        if (nested !== undefined && nested === topologyNodeById(line.edge.to)?.parent) continue;
        for (const box of diagram.boxes) {
          const inside = line.label.x > box.x && line.label.x < box.x + box.width
            && line.label.y > box.y && line.label.y < box.y + box.height;
          expect(inside, `${line.edge.from}→${line.edge.to} labels over ${box.node.id}`).toBe(false);
        }
      }
    }
  });

  it('gives every label a spot of its own, at page and phone width', () => {
    for (const detail of ['overview', 'full'] as const) {
      for (const perRow of [2, 4]) {
      const diagram = layoutTopology(detail, diagramOptions(detail, perRow));
      // A label is as tall as its own words now, so two of them clash when
      // they are closer than half the height of the pair.
      const tall = (line: { labelText: { height: number }[] }) => line.labelText.reduce((total, row) => total + row.height, 0) + 8;
      for (const [index, line] of diagram.lines.entries()) {
        for (const other of diagram.lines.slice(index + 1)) {
          const clash = Math.abs(line.label.x - other.label.x) < DIAGRAM.labelWidth + DIAGRAM.labelGutter
            && Math.abs(line.label.y - other.label.y) < (tall(line) + tall(other)) / 2;
          expect(clash, `${detail} at ${perRow}: ${line.edge.from}→${line.edge.to} sits on ${other.edge.from}→${other.edge.to}`).toBe(false);
        }
      }
      }
    }
  });

  it('breaks a label at the words, and says when it had to cut', () => {
    // 20 units a character at 5 a character is a four-character line.
    expect(wrapLabel('one two', 20, 5, 2)).toEqual(['one', 'two']);
    expect(wrapLabel('one', 200, 5, 2)).toEqual(['one']);
    // Out of lines with words left: the last line has to show it.
    expect(wrapLabel('one two six', 20, 5, 2).at(-1)?.endsWith('…')).toBe(true);
    // A word longer than the line is cut rather than allowed to overflow.
    expect(wrapLabel('extraordinary', 20, 5, 2)).toEqual(['ext…']);
    // Nothing that fits is ever marked as cut.
    for (const line of wrapLabel('a short one', 200, 5, 3)) expect(line).not.toContain('…');
  });

  it('keeps a column beside its lane rather than under it', () => {
    const diagram = layoutTopology('full');
    const control = diagram.bands.find((band) => band.id === 'control');
    const state = diagram.bands.find((band) => band.id === 'state');
    expect(control?.y).toBe(state?.y);
    expect(state!.x).toBeGreaterThan(control!.x + control!.width);
  });
});
