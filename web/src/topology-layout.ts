import {
  TOPOLOGY_LANES,
  childNodes,
  topologyGraph,
  type TopologyDetail,
  type TopologyEdge,
  type TopologyLaneId,
  type TopologyNode,
} from '@starlings/contracts/topology';

/**
 * Where the boxes of `packages/contracts/src/topology.ts` land.
 *
 * All of the arithmetic of the system diagram, and none of its markup:
 * `SystemDiagram.tsx` renders what this returns and decides nothing. Pure and
 * deterministic — the same registry and the same options give the same
 * numbers every time, which is what lets `topology-layout.test.ts` assert that
 * no two boxes overlap instead of a human squinting at a screenshot.
 *
 * Lanes are rows, top to bottom, in registry order. Within a lane the boxes
 * share the width equally and wrap at `perRow`. A box with children (the full
 * drawing) grows to hold them.
 */

/** Every measurement, in user units of the viewBox. One place to retune the drawing. */
export const DIAGRAM = {
  width: 960,
  padding: 18,
  /** Room above a lane for its title and blurb. */
  laneLabel: 44,
  /** The corridor between two lanes, where the lines carry their labels. */
  laneGap: 150,
  /** The same corridor on the full drawing, which has three times the lines. */
  denseLaneGap: 380,
  boxGap: 14,
  rowGap: 14,
  /** Air above and below a box's words. */
  boxPadding: 14,
  /** Chips are names, not sentences, so they pack tighter than nested boxes. */
  chipMinWidth: 130,
  chipGap: 8,
  /** Between a box's bottom edge and the chips hanging off it. */
  chipReach: 18,
  parentPadding: 12,
  childGap: 10,
  /** A child narrower than this wraps to the next row inside its parent. */
  minChildWidth: 120,
  /** No box grows past this, however few share the row — a lane of one is a box, not a bar. */
  maxBoxWidth: 320,
  /** What the wider of two side-by-side lanes takes. */
  besideSplit: 0.62,
  /** How far a line bows out of the box it leaves. */
  bow: 26,
  /** How wide a line's label runs before it wraps, and the room one takes. */
  labelWidth: 142,
  /** Air between two labels, so near-misses read as two things and not one. */
  labelGutter: 16,
  /** How much of a lane's row its heading takes, for a label to stay out of. */
  headingWidth: 300,
} as const;

export type BoxSide = 'top' | 'bottom' | 'left' | 'right';

/** One rendered line of text, with the utilities that style it (Tailwind, on the theme tokens). */
export type TextRow = { text: string; className: string; height: number };

/** The registry writes a literal in backticks; SVG has no `<code>`. */
export function plain(text: string): string {
  return text.replaceAll('`', '');
}

/**
 * A line's words sit on the line, with the card colour around their letters,
 * so the line runs under them cleanly.
 */
const HALO = 'text-[10px] [paint-order:stroke] stroke-card [stroke-width:3.5px] [stroke-linejoin:round]';

/** The utilities for each kind of text row. */
export const TEXT_CLASS = {
  boxName: 'text-[12.5px] font-semibold fill-foreground',
  boxVendor: 'text-[10.5px] fill-foreground/45',
  boxNote: 'text-[10.5px] fill-foreground/55',
  boxStores: 'text-[10px] fill-foreground/45',
  chipName: 'text-[10.5px] fill-foreground/80',
  lineLabel: `${HALO} fill-foreground/62`,
  lineNever: `${HALO} fill-(--accent-mark)`,
} as const;

/**
 * What a box says, wrapped to the width it has. Nothing is cut: a box is as
 * tall as its own words, because a sentence ending in an ellipsis is a
 * sentence the reader has to go somewhere else to finish.
 */
export function boxText(node: TopologyNode, width: number, nested: boolean): TextRow[] {
  const inner = width - 20;
  return [
    ...wrapLabel(plain(node.name), inner, nested ? 6.4 : 7.1, 4)
      .map((text) => ({ text, className: TEXT_CLASS.boxName, height: 16 })),
    ...(node.vendor ? [{ text: plain(node.vendor), className: TEXT_CLASS.boxVendor, height: 14 }] : []),
    ...wrapLabel(plain(node.holds), inner, nested ? 5.2 : 5.6, 16)
      .map((text) => ({ text, className: TEXT_CLASS.boxNote, height: 13 })),
    ...(node.stores
      ? wrapLabel(`Stored in ${plain(node.stores)}`, inner, 5.4, 8)
        .map((text) => ({ text, className: TEXT_CLASS.boxStores, height: 13 }))
      : []),
  ];
}

/** A chip carries a name and nothing else, over as many lines as the name needs. */
export function chipText(node: TopologyNode, width: number): TextRow[] {
  return wrapLabel(plain(node.name), width - 14, 5.9, 3)
    .map((text) => ({ text, className: TEXT_CLASS.chipName, height: 13 }));
}

/** What a line says: what it carries, then what it never carries. */
export function labelText(edge: TopologyEdge): TextRow[] {
  return [
    ...wrapLabel(plain(edge.carries), DIAGRAM.labelWidth, 4.9, 6)
      .map((text) => ({ text, className: TEXT_CLASS.lineLabel, height: 12 })),
    ...(edge.never
      ? wrapLabel(`Never: ${plain(edge.never)}`, DIAGRAM.labelWidth, 4.6, 6)
        .map((text) => ({ text, className: TEXT_CLASS.lineNever, height: 12 }))
      : []),
  ];
}

function textHeight(rows: TextRow[]): number {
  return rows.reduce((total, row) => total + row.height, 0);
}

type Rect = { x: number; y: number; width: number; height: number };

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

export type TopologyBox = {
  node: TopologyNode;
  /** Its words, already wrapped to its width. The component only draws them. */
  text: TextRow[];
  /**
   * True when `children` hang under the box as chips rather than sitting
   * inside it — the public drawing naming what it stands for.
   */
  collapsed?: boolean;
  /** Absolute, inside the viewBox — a child's numbers are not relative to its parent. */
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * The height of the box *and* whatever hangs under it. Lines leave from the
   * bottom of this, so a line never crosses the chips of the box it left.
   */
  footprint: number;
  /** Nested boxes, already absolute. Empty on the overview drawing. */
  children: TopologyBox[];
};

export type LineEnd = { x: number; y: number; side: BoxSide };

export type TopologyLine = {
  edge: TopologyEdge;
  /** Its label, already wrapped. Its height is what the spread pass reserves. */
  label: { x: number; y: number };
  labelText: TextRow[];
  /** Where it leaves `edge.from` and lands on `edge.to` — the arrow points at `to`. */
  from: LineEnd;
  to: LineEnd;
  /** A cubic bezier, ready for `d`. */
  path: string;
  /** The middle of that curve, for a badge or a hit target. */
  mid: { x: number; y: number };
};

export type TopologyBand = {
  id: TopologyLaneId;
  title: string;
  blurb: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type TopologyDiagram = {
  width: number;
  height: number;
  bands: TopologyBand[];
  /** Parents and children in one list, parents first — the drawing order. */
  boxes: TopologyBox[];
  lines: TopologyLine[];
};

export type LayoutOptions = {
  /** Boxes per lane row before it wraps. Two on a phone, four on a page. */
  perRow?: number;
  width?: number;
  /** The corridor between two lanes. The full drawing needs a wider one. */
  laneGap?: number;
};

function chunk<T>(items: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let index = 0; index < items.length; index += size) rows.push(items.slice(index, index + size));
  return rows;
}

/** Equal shares of `span`, less the gaps between them. */
function share(span: number, count: number, gap: number): number {
  return (span - gap * (count - 1)) / count;
}

function boxHeight(node: TopologyNode, width: number, detail: TopologyDetail): number {
  const own = textHeight(boxText(node, width, node.parent !== undefined)) + DIAGRAM.boxPadding * 2;
  const children = detail === 'full' ? childNodes(node.id) : [];
  if (children.length === 0) return own;
  const inner = width - DIAGRAM.parentPadding * 2;
  const perRow = Math.max(1, Math.min(children.length, Math.floor((inner + DIAGRAM.childGap) / (DIAGRAM.minChildWidth + DIAGRAM.childGap))));
  const childWidth = share(inner, Math.min(perRow, children.length), DIAGRAM.childGap);
  const rowHeight = Math.max(...children.map((child) => textHeight(boxText(child, childWidth, true)) + DIAGRAM.boxPadding * 2));
  const rows = Math.ceil(children.length / perRow);
  return own + rows * rowHeight + (rows - 1) * DIAGRAM.childGap + DIAGRAM.parentPadding;
}

/** How many chips fit across a box of this width. */
function chipsPerRow(width: number, count: number): number {
  return Math.max(1, Math.min(count, Math.floor((width + DIAGRAM.chipGap) / (DIAGRAM.chipMinWidth + DIAGRAM.chipGap))));
}

/** The room a collapsed box's chips take under it, including the reach to them. */
function chipStrip(node: TopologyNode, width: number, detail: TopologyDetail): number {
  if (detail === 'full') return 0;
  const children = childNodes(node.id);
  if (children.length === 0) return 0;
  const perRow = chipsPerRow(width, children.length);
  const rows = Math.ceil(children.length / perRow);
  return DIAGRAM.chipReach + rows * chipHeight(children, share(width, perRow, DIAGRAM.chipGap)) + (rows - 1) * DIAGRAM.chipGap;
}

/** One height for every chip of a box: the tallest name, plus its air. */
function chipHeight(children: TopologyNode[], width: number): number {
  return Math.max(...children.map((child) => textHeight(chipText(child, width)))) + 16;
}

/** The chips themselves, hanging under the box in rows. */
function layoutChips(parent: TopologyBox): TopologyBox[] {
  const children = childNodes(parent.node.id);
  if (children.length === 0) return [];
  const perRow = chipsPerRow(parent.width, children.length);
  const boxes: TopologyBox[] = [];
  const width = share(parent.width, perRow, DIAGRAM.chipGap);
  const height = chipHeight(children, width);
  let y = parent.y + parent.height + DIAGRAM.chipReach;
  for (const row of chunk(children, perRow)) {
    // Every chip is the same size, and a short last row sits in the middle.
    const used = width * row.length + DIAGRAM.chipGap * (row.length - 1);
    const left = parent.x + (parent.width - used) / 2;
    row.forEach((node, index) => {
      boxes.push({
        node,
        text: chipText(node, width),
        x: left + index * (width + DIAGRAM.chipGap),
        y,
        width,
        height,
        footprint: height,
        children: [],
      });
    });
    y += height + DIAGRAM.chipGap;
  }
  return boxes;
}

function layoutChildren(parent: TopologyBox, detail: TopologyDetail): TopologyBox[] {
  const children = detail === 'full' ? childNodes(parent.node.id) : [];
  if (children.length === 0) return [];
  const inner = parent.width - DIAGRAM.parentPadding * 2;
  const perRow = Math.max(1, Math.min(children.length, Math.floor((inner + DIAGRAM.childGap) / (DIAGRAM.minChildWidth + DIAGRAM.childGap))));
  const width = share(inner, Math.min(perRow, children.length), DIAGRAM.childGap);
  // One height for the row, so a short sentence beside a long one does not
  // make two boxes of different sizes out of two things of the same kind.
  const height = Math.max(...children.map((child) => textHeight(boxText(child, width, true)) + DIAGRAM.boxPadding * 2));
  const boxes: TopologyBox[] = [];
  let y = parent.y + textHeight(boxText(parent.node, parent.width, false)) + DIAGRAM.boxPadding * 2;
  for (const row of chunk(children, perRow)) {
    row.forEach((node, index) => {
      boxes.push({
        node,
        text: boxText(node, width, true),
        x: parent.x + DIAGRAM.parentPadding + index * (width + DIAGRAM.childGap),
        y,
        width,
        height,
        footprint: height,
        children: [],
      });
    });
    y += height + DIAGRAM.childGap;
  }
  return boxes;
}

/**
 * Anchors, spread along the side they share so two lines never leave a box
 * through the same point. Ordered by where the other end sits, so the lines
 * arrive in the order they are drawn and do not cross for no reason.
 */
function anchorPoints(
  box: TopologyBox,
  side: BoxSide,
  ends: { index: number; toward: number }[],
): Map<number, LineEnd> {
  const sorted = [...ends].sort((a, b) => a.toward - b.toward || a.index - b.index);
  const vertical = side === 'top' || side === 'bottom';
  const span = vertical ? box.width : box.height;
  const start = vertical ? box.x : box.y;
  const fixed = side === 'top' ? box.y : side === 'bottom' ? box.y + box.footprint : side === 'left' ? box.x : box.x + box.width;
  const points = new Map<number, LineEnd>();
  sorted.forEach((end, order) => {
    const along = start + (span * (order + 1)) / (sorted.length + 1);
    points.set(end.index, vertical ? { x: along, y: fixed, side } : { x: fixed, y: along, side });
  });
  return points;
}

function opposite(side: BoxSide): BoxSide {
  return side === 'top' ? 'bottom' : side === 'bottom' ? 'top' : side === 'left' ? 'right' : 'left';
}

/** Which way a line leaves `a` for `b`: down the page when they are in different bands, sideways when level. */
function sideFor(a: TopologyBox, b: TopologyBox): BoxSide {
  if (b.y >= a.y + a.footprint) return 'bottom';
  if (a.y >= b.y + b.footprint) return 'top';
  return b.x + b.width / 2 >= a.x + a.width / 2 ? 'right' : 'left';
}

function curve(from: LineEnd, to: LineEnd): { path: string; mid: { x: number; y: number }; at: (t: number) => { x: number; y: number } } {
  const vertical = from.side === 'top' || from.side === 'bottom';
  const reach = Math.max(DIAGRAM.bow, (vertical ? Math.abs(to.y - from.y) : Math.abs(to.x - from.x)) / 2);
  const out = vertical
    ? { x: from.x, y: from.y + (from.side === 'bottom' ? reach : -reach) }
    : { x: from.x + (from.side === 'right' ? reach : -reach), y: from.y };
  const into = to.side === 'top' || to.side === 'bottom'
    ? { x: to.x, y: to.y + (to.side === 'bottom' ? reach : -reach) }
    : { x: to.x + (to.side === 'right' ? reach : -reach), y: to.y };
  // Any point of that cubic, so a caller can walk it looking for clear air.
  const at = (t: number) => {
    const u = 1 - t;
    return {
      x: round(u * u * u * from.x + 3 * u * u * t * out.x + 3 * u * t * t * into.x + t * t * t * to.x),
      y: round(u * u * u * from.y + 3 * u * u * t * out.y + 3 * u * t * t * into.y + t * t * t * to.y),
    };
  };
  return {
    path: `M ${round(from.x)} ${round(from.y)} C ${round(out.x)} ${round(out.y)}, ${round(into.x)} ${round(into.y)}, ${round(to.x)} ${round(to.y)}`,
    mid: at(0.5),
    at,
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The whole drawing at one density. `perRow` is the only thing the component
 * varies: two boxes to a row on a narrow screen, four on a wide one.
 */
export function layoutTopology(detail: TopologyDetail, options: LayoutOptions = {}): TopologyDiagram {
  const width = options.width ?? DIAGRAM.width;
  const perRow = Math.max(1, options.perRow ?? 4);
  const laneGap = options.laneGap ?? DIAGRAM.laneGap;
  const content = width - DIAGRAM.padding * 2;
  const { nodes, edges } = topologyGraph(detail);

  const bands: TopologyBand[] = [];
  const parents: TopologyBox[] = [];
  const children: TopologyBox[] = [];

  /** One lane's rows inside the region it was given. Returns the height it took. */
  function layoutLane(lane: (typeof TOPOLOGY_LANES)[number], x: number, span: number, top: number): number {
    const laneNodes = nodes.filter((node) => node.lane === lane.id && node.parent === undefined);
    let y = top + DIAGRAM.laneLabel;
    for (const row of chunk(laneNodes, perRow)) {
      const boxWidth = Math.min(DIAGRAM.maxBoxWidth, share(span, row.length, DIAGRAM.boxGap));
      // A row that does not fill its region sits in the middle of it.
      const used = boxWidth * row.length + DIAGRAM.boxGap * (row.length - 1);
      const left = x + (span - used) / 2;
      // Each box is as tall as it needs to be; the row advances by the tallest,
      // so a leaf beside a box full of children is not stretched to match it.
      const heights = row.map((node) => boxHeight(node, boxWidth, detail));
      const height = Math.max(...heights);
      // The row advances past the tallest box *and* whatever hangs under it.
      const stride = Math.max(...row.map((node, index) => heights[index] + chipStrip(node, boxWidth, detail)));
      row.forEach((node, index) => {
        const box: TopologyBox = {
          node,
          text: boxText(node, boxWidth, false),
          x: left + index * (boxWidth + DIAGRAM.boxGap),
          y,
          width: boxWidth,
          height: heights[index],
          footprint: heights[index],
          children: [],
        };
        box.children = layoutChildren(box, detail);
        if (box.children.length === 0) {
          box.children = layoutChips(box);
          box.collapsed = box.children.length > 0;
          if (box.collapsed) box.footprint = heights[index] + chipStrip(node, boxWidth, detail);
        }
        children.push(...box.children);
        parents.push(box);
      });
      y += stride + DIAGRAM.rowGap;
    }
    const height = y - DIAGRAM.rowGap - top;
    bands.push({ id: lane.id, title: lane.title, blurb: lane.blurb, x, y: top, width: span, height });
    return height;
  }

  const drawn = TOPOLOGY_LANES.filter((lane) => nodes.some((node) => node.lane === lane.id && node.parent === undefined));
  const placed = new Set<TopologyLaneId>();
  let y = DIAGRAM.padding;

  for (const lane of drawn) {
    if (placed.has(lane.id)) continue;
    placed.add(lane.id);
    // A lane that asked to sit beside this one takes the narrower column.
    const column = drawn.find((other) => other.beside === lane.id && !placed.has(other.id));
    if (!column) {
      y += layoutLane(lane, DIAGRAM.padding, content, y) + laneGap;
      continue;
    }
    placed.add(column.id);
    const wide = Math.round(share(content, 2, DIAGRAM.boxGap * 2) * (DIAGRAM.besideSplit * 2));
    const narrow = content - wide - DIAGRAM.boxGap * 2;
    const height = Math.max(
      layoutLane(lane, DIAGRAM.padding, wide, y),
      layoutLane(column, DIAGRAM.padding + wide + DIAGRAM.boxGap * 2, narrow, y),
    );
    y += height + laneGap;
  }

  const boxes = [...parents, ...children];
  const byId = new Map(boxes.map((box) => [box.node.id, box]));

  // Two passes: pick every line's sides first, so a box knows how many lines
  // share each of its sides before any anchor is placed.
  const picked = edges.map((edge, index) => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) return undefined;
    const side = sideFor(from, to);
    return { index, edge, from, to, fromSide: side, toSide: opposite(side) };
  });

  const anchors = new Map<string, Map<number, LineEnd>>();
  for (const box of boxes) {
    for (const side of ['top', 'bottom', 'left', 'right'] as BoxSide[]) {
      const ends = picked.flatMap((line) => {
        if (!line) return [];
        if (line.from === box && line.fromSide === side) {
          const other = line.to;
          return [{ index: line.index, toward: side === 'top' || side === 'bottom' ? other.x + other.width / 2 : other.y + other.height / 2 }];
        }
        if (line.to === box && line.toSide === side) {
          const other = line.from;
          return [{ index: line.index, toward: side === 'top' || side === 'bottom' ? other.x + other.width / 2 : other.y + other.height / 2 }];
        }
        return [];
      });
      if (ends.length === 0) continue;
      anchors.set(`${box.node.id}:${side}`, anchorPoints(box, side, ends));
    }
  }

  // Clear air is anywhere a label would not cover something already drawn:
  // a box, or the heading of a lane. Real geometry rather than a rule about
  // rows, so one more line cannot invalidate it.
  const obstacles: Rect[] = [
    ...boxes.filter((box) => box.node.parent === undefined || box.node.parent !== undefined)
      .filter((box) => box.node.parent === undefined || parents.some((parent) => parent.collapsed && parent.children.includes(box)))
      .map((box) => ({ x: box.x, y: box.y, width: box.width, height: box.height })),
    ...bands.map((band) => ({ x: band.x, y: band.y, width: Math.min(band.width, DIAGRAM.headingWidth), height: DIAGRAM.laneLabel })),
  ];
  const clear = (spot: { x: number; y: number }, height: number) => {
    const label = { x: spot.x - DIAGRAM.labelWidth / 2, y: spot.y - height / 2, width: DIAGRAM.labelWidth, height };
    if (label.x < 0 || label.x + label.width > width) return false;
    return !obstacles.some((box) => overlaps(label, box));
  };

  const lines: TopologyLine[] = [];
  for (const line of picked) {
    if (!line) continue;
    const from = anchors.get(`${line.from.node.id}:${line.fromSide}`)?.get(line.index);
    const to = anchors.get(`${line.to.node.id}:${line.toSide}`)?.get(line.index);
    if (!from || !to) continue;
    const drawn = curve(from, to);
    const text = labelText(line.edge);
    const height = textHeight(text) + 8;
    lines.push({
      edge: line.edge,
      from,
      to,
      path: drawn.path,
      mid: drawn.mid,
      labelText: text,
      label: labelPoint(drawn, (spot) => clear(spot, height)),
    });
  }

  spreadLabels(lines, clear);

  return { width, height: y - laneGap + DIAGRAM.padding, bands, boxes, lines };
}

/**
 * A label broken across lines to fit the box it sits in, at roughly `per`
 * units a character. When the words run out of room the last line ends in an
 * ellipsis, so a cut sentence always looks cut — a box is a label, and the key
 * under the drawing carries the whole sentence either way.
 */
export function wrapLabel(text: string, width: number, per: number, maxLines: number): string[] {
  const budget = Math.max(4, Math.floor(width / per));
  const words = text.split(/\s+/u).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  let index = 0;
  while (index < words.length && lines.length < maxLines) {
    const word = words[index];
    const next = line === '' ? word : `${line} ${word}`;
    if (next.length <= budget) {
      line = next;
      index += 1;
      continue;
    }
    // A word too long for a line of its own is cut; anything else starts the
    // next line, and the word is tried again there.
    if (line === '') {
      lines.push(`${word.slice(0, budget - 1)}…`);
      index += 1;
      continue;
    }
    lines.push(line);
    line = '';
  }
  if (line !== '' && lines.length < maxLines) {
    lines.push(line);
    line = '';
  }
  const dropped = index < words.length || line !== '';
  if (dropped && lines.length > 0) {
    const last = lines[lines.length - 1];
    lines[lines.length - 1] = last.length < budget ? `${last}…` : `${last.slice(0, budget - 1).trimEnd()}…`;
  }
  return lines;
}

/**
 * Two labels in the same corridor may want the same spot. Each one, left to
 * right, takes the first free slot above or below its own line — inside the
 * corridor, so a label never climbs onto a box to get out of the way.
 */
function spreadLabels(lines: TopologyLine[], clear: (spot: { x: number; y: number }, height: number) => boolean): void {
  const placed: { x: number; y: number; height: number }[] = [];
  const free = (spot: { x: number; y: number }, height: number) => clear(spot, height) && !placed.some((other) =>
    Math.abs(other.x - spot.x) < DIAGRAM.labelWidth + DIAGRAM.labelGutter
    && Math.abs(other.y - spot.y) < (other.height + height) / 2);
  const step = DIAGRAM.labelWidth * 0.9;
  // Its own spot first, then the nearest free one on a grid around it — near
  // enough that the label still reads as belonging to its line.
  const spots: { dx: number; dy: number }[] = [];
  for (let column = -6; column <= 6; column += 1) {
    for (let row = -20; row <= 20; row += 1) spots.push({ dx: (step / 2) * column, dy: 14 * row });
  }
  spots.sort((a, b) => (Math.abs(a.dx) + Math.abs(a.dy) * 1.6) - (Math.abs(b.dx) + Math.abs(b.dy) * 1.6));

  // Tallest first: a label with five lines has the fewest places to go.
  for (const line of [...lines].sort((a, b) => textHeight(b.labelText) - textHeight(a.labelText) || a.label.x - b.label.x)) {
    const height = textHeight(line.labelText) + 8;
    for (const { dx, dy } of spots) {
      const spot = { x: line.label.x + dx, y: line.label.y + dy };
      if (!free(spot, height)) continue;
      line.label = spot;
      break;
    }
    placed.push({ ...line.label, height });
  }
}

/**
 * The point of a curve where its label belongs: walking out from the middle,
 * the first sample that sits in clear air. A line with no clear air anywhere
 * keeps its middle, lifted off the path.
 */
function labelPoint(
  drawn: { mid: { x: number; y: number }; at: (t: number) => { x: number; y: number } },
  clear: (point: { x: number; y: number }) => boolean,
): { x: number; y: number } {
  if (clear(drawn.mid)) return drawn.mid;
  for (let step = 1; step <= 20; step += 1) {
    for (const t of [0.5 + step * 0.02, 0.5 - step * 0.02]) {
      if (t <= 0 || t >= 1) continue;
      const point = drawn.at(t);
      if (clear(point)) return point;
    }
  }
  return { x: drawn.mid.x, y: drawn.mid.y - 16 };
}

/**
 * How each drawing is laid out. One place, so the page and the tests cannot
 * disagree about it. The full drawing has three times the lines, so it buys
 * the room for their labels with a wider corridor.
 */
export function diagramOptions(detail: TopologyDetail, perRow: number): LayoutOptions {
  return {
    perRow,
    laneGap: detail === 'full' ? DIAGRAM.denseLaneGap : DIAGRAM.laneGap,
  };
}

/** Every line that touches one box — what the drawing highlights when you point at it. */
export function linesTouching(diagram: TopologyDiagram, nodeId: string): TopologyLine[] {
  return diagram.lines.filter((line) => line.edge.from === nodeId || line.edge.to === nodeId);
}
