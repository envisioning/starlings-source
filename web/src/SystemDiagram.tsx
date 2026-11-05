import { t } from './i18n';
import { Fragment, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/ui/button';
import { Card } from '@/ui/card';
import { cn } from '@/lib/utils';
import {
  TRANSPORT_LABEL,
  childNodes,
  topologyGraph,
  topologyLanes,
  topologyNodeById,
  type TopologyDetail,
  type TopologyKind,
  type TopologyNode,
} from '@starlings/contracts/topology';
import {
  DIAGRAM,
  diagramOptions,
  layoutTopology,
  TEXT_CLASS,
  plain,
  type TopologyBox,
  type TopologyDiagram,
  type TopologyLine,
} from './topology-layout';

/** The height of a stack of rendered rows. */
function textHeight(rows: { height: number }[]): number {
  return rows.reduce((total, row) => total + row.height, 0);
}

/**
 * The system diagram: which services Meet is made of, drawn from the registry
 * in `packages/contracts/src/topology.ts`.
 *
 * Nothing here is a fact. Every name, sentence and line comes from the
 * registry, and every coordinate from `topology-layout.ts` — this file turns
 * numbers into markup and does not decide anything a reviewer would want to
 * argue with. Adding a service is a row in the registry; this file does not
 * change.
 *
 * The drawing is decorative (`aria-hidden`): the same facts are under it as
 * prose, which is what a screen reader reads, what prints, and what someone
 * greps. Pointing at a box lights its lines and dims the rest — an
 * enhancement for a mouse, never the only way to the content.
 *
 * The drawing is Tailwind utilities on the theme tokens; the
 * `data-topology` attributes name its parts for tests.
 */

/**
 * Kind is an edge, never a fill: a filled box would compete with the accent,
 * and the accent belongs to things a person can press. A store is the well;
 * somebody else's service is dashed; a sibling (Core, Docs, Keep) is ours and
 * solid, like the Worker.
 */
const KIND_RECT: Record<TopologyKind, string> = {
  client: 'fill-popover stroke-foreground/35',
  media: 'fill-popover stroke-(--accent-mark)',
  edge: 'fill-popover stroke-foreground/55',
  store: 'fill-muted stroke-border',
  sibling: 'fill-popover stroke-foreground/45',
  external: 'fill-popover stroke-border [stroke-dasharray:4_3]',
};

/** A box or chip that is picked, or has the keyboard, draws its edge in the accent. */
const PICKED_RECT = 'stroke-(--accent-mark) [stroke-width:2]';

/** Dimmed while something else is pointed at. */
const STATE_OPACITY = 'transition-opacity duration-120 ease-[ease]';

/** A lane title is drawn after the lines, with the card colour around its letters. */
const BAND_TEXT = '[paint-order:stroke] stroke-card [stroke-width:3px] [stroke-linejoin:round]';

export function SystemDiagram({ detail = 'overview', className }: { detail?: TopologyDetail; className?: string }) {
  const perRow = useNarrow() ? 2 : 4;
  const diagram = useMemo(() => layoutTopology(detail, diagramOptions(detail, perRow)), [detail, perRow]);
  const [active, setActive] = useState<string | null>(null);
  // What the reader asked to see in full. A box is clipped to the room it has;
  // this is where the whole of it is written.
  const [picked, setPicked] = useState<{ kind: 'node' | 'line'; id: string } | null>(null);
  const inside = (line: TopologyLine) => {
    const from = topologyNodeById(line.edge.from)?.parent;
    return from !== undefined && from === topologyNodeById(line.edge.to)?.parent;
  };
  const pick = (kind: 'node' | 'line', id: string) =>
    setPicked((current) => (current?.kind === kind && current.id === id ? null : { kind, id }));
  const under = diagram.lines.filter((line) => !inside(line));
  const over = diagram.lines.filter(inside);
  const lanes = topologyLanes(detail);
  const { edges } = topologyGraph(detail);

  return (
    <figure
      className={cn('relative m-0 rounded-xl border border-border bg-card px-[22px] pt-[22px] pb-5 max-[720px]:px-4 max-[720px]:pt-4 max-[720px]:pb-3.5', className)}
      onMouseLeave={() => setActive(null)}
    >
      {/* The frame is exactly the drawing, so the reader's percentages land on
          the box that was picked rather than on the card's padding. */}
      <div className="relative">
      <svg
        className="block h-auto w-full"
        viewBox={`0 0 ${diagram.width} ${diagram.height}`}
        preserveAspectRatio="xMidYMid meet"
        role="group"
        aria-label="How Starlings services fit together"
      >
        <defs>
          <marker id="topology-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 1 L7 4 L0 7 Z" fill="currentColor" />
          </marker>
        </defs>

        {under.map((line) => (
          <Line
            key={`${line.edge.from}-${line.edge.to}-${line.edge.carries}`}
            line={line}
            state={lineState(line, active)}
            labelled
            picked={picked?.kind === 'line' && picked.id === lineKey(line)}
            onPick={() => pick('line', lineKey(line))}
          />
        ))}

        {diagram.bands.map((band) => (
          <g key={band.id}>
            <text x={band.x} y={band.y + 14} className={`${BAND_TEXT} text-[12.5px] font-semibold fill-foreground/75`}>{band.title}</text>
            <text x={band.x} y={band.y + 28} className={`${BAND_TEXT} text-[11px] fill-foreground/50`}>{band.blurb}</text>
          </g>
        ))}

        {diagram.boxes.filter((box) => !isChip(box, diagram.boxes)).map((box) => (
          <Box
            key={box.node.id}
            box={box}
            state={boxState(box.node.id, active, diagram.lines)}
            picked={picked?.kind === 'node' && picked.id === box.node.id}
            onPoint={() => setActive(box.node.id)}
            onPick={() => pick('node', box.node.id)}
          />
        ))}

        {/* A line between two boxes inside the same box would be buried under
            them; it is the only kind drawn on top. */}
        {over.map((line) => (
          <Line
            key={`${line.edge.from}-${line.edge.to}-${line.edge.carries}`}
            line={line}
            state={lineState(line, active)}
            labelled={false}
            picked={false}
            onPick={() => undefined}
          />
        ))}

        {/* Last, so nothing is drawn through a chip: they are small, and a
            line crossing one made it look like a hole in the drawing. */}
        {diagram.boxes.filter((box) => box.collapsed).flatMap((parent) => parent.children.map((chip) => (
          <Chip
            key={chip.node.id}
            chip={chip}
            parent={parent}
            picked={picked?.kind === 'node' && picked.id === chip.node.id}
            onPoint={() => setActive(parent.node.id)}
            onPick={() => pick('node', chip.node.id)}
          />
        )))}
      </svg>

      <Reader
        picked={picked}
        diagram={diagram}
        onClose={() => setPicked(null)}
      />
      </div>

      {/* The drawing carries every fact now; this is the same thing in
          sentences, for a screen reader, a printer and a grep. */}
      <figcaption className="sr-only">
        {lanes.map((lane) => (
          <section key={lane.id}>
            <h3>{lane.title}</h3>
            <p>{lane.blurb}</p>
            <dl>
              {lane.nodes.map((node) => (
                <Fragment key={node.id}>
                  <Row node={node} />
                  {(detail === 'full' ? childNodes(node.id) : []).map((child) => (
                    <Row key={child.id} node={child} />
                  ))}
                </Fragment>
              ))}
            </dl>
          </section>
        ))}
        <section>
          <h3>What runs between them</h3>
          <ul>
            {edges.map((edge) => (
              <li key={`${edge.from}-${edge.to}-${edge.carries}`}>
                <b>{nodeName(edge.from)} {edge.dir === 'both' ? '↔' : '→'} {nodeName(edge.to)}</b>
                <span>{code(edge.carries)} · <i>{TRANSPORT_LABEL[edge.over]}</i></span>
                {edge.never && <span>Never: {code(edge.never)}</span>}
                {edge.dormant && <span>{code(edge.dormant)}</span>}
              </li>
            ))}
          </ul>
        </section>
      </figcaption>
    </figure>
  );
}

function Row({ node }: { node: TopologyNode }) {
  return (
    <div>
      <dt>
        {code(node.name)}
        {node.vendor && <small>{node.vendor}</small>}
      </dt>
      <dd>
        {code(node.holds)}
        {node.dormant && <span>{code(node.dormant)}</span>}
      </dd>
    </div>
  );
}

function Box({ box, state, onPoint, onPick, picked }: {
  box: TopologyBox;
  state: PointState;
  onPoint: () => void;
  onPick: () => void;
  picked: boolean;
}) {
  const { node } = box;
  const nested = node.parent !== undefined;
  const middle = box.x + box.width / 2;
  // Chips hang *under* the box, so a collapsed box uses its whole height for
  // its own words; a box that holds its children keeps to the strip above them.
  const strip = box.children.length > 0 && !box.collapsed
    ? textHeight(box.text) + DIAGRAM.boxPadding * 2
    : box.height;
  let y = box.y + (strip - textHeight(box.text)) / 2 + 12;
  return (
    <g
      className={cn('group/box cursor-pointer outline-none', STATE_OPACITY, state === 'dim' && 'opacity-25')}
      data-topology="box"
      data-node={node.id}
      role="button"
      tabIndex={0}
      aria-label={`${plain(node.name)}. ${plain(node.holds)}`}
      aria-pressed={picked}
      onMouseEnter={onPoint}
      onClick={onPick}
      onFocus={onPoint}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onPick();
      }}
    >
      <rect
        x={box.x}
        y={box.y}
        width={box.width}
        height={box.height}
        rx={nested ? 10 : 14}
        className={cn(KIND_RECT[node.kind], '[stroke-width:1]', picked ? PICKED_RECT : 'group-focus-visible/box:stroke-(--accent-mark) group-focus-visible/box:[stroke-width:2]')}
      />
      {box.text.map((row) => {
        const baseline = y;
        y += row.height;
        return (
          <text key={`${row.className}-${row.text}`} x={middle} y={baseline} textAnchor="middle" className={row.className}>
            {row.text}
          </text>
        );
      })}
    </g>
  );
}

/** A chip is drawn by its parent, not on its own. */
function isChip(box: TopologyBox, boxes: TopologyBox[]): boolean {
  return boxes.some((other) => other.collapsed && other.children.includes(box));
}

/** A line's own id: two boxes and what runs between them. */
function lineKey(line: TopologyLine): string {
  return `${line.edge.from}-${line.edge.to}-${line.edge.carries}`;
}

/**
 * What a box or a line says in full. A drawing clips: the name to its width,
 * the sentence to two lines. Clicking one writes the whole of it here, with
 * the file and the doc that own it, so nothing on the drawing is a dead end.
 */
function Reader({ picked, diagram, onClose }: {
  picked: { kind: 'node' | 'line'; id: string } | null;
  diagram: TopologyDiagram;
  onClose: () => void;
}) {
  const lines = diagram.lines;
  if (!picked) return null;

  // Anchored where the thing is, not under the drawing: the SVG scales to the
  // width it is given, so a point in the viewBox is a percentage of the frame.
  const anchor = picked.kind === 'node'
    ? diagram.boxes.find((box) => box.node.id === picked.id)
    : undefined;
  const line = picked.kind === 'line' ? lines.find((row) => lineKey(row) === picked.id) : undefined;
  const at = anchor
    ? { x: anchor.x + anchor.width / 2, y: anchor.y + anchor.height }
    : line ? { x: line.label.x, y: line.label.y } : { x: diagram.width / 2, y: diagram.height / 2 };
  const style = {
    left: `${(at.x / diagram.width) * 100}%`,
    top: `${(at.y / diagram.height) * 100}%`,
    // Near an edge it hangs from that edge instead of walking off the page.
    transform: `translate(${at.x < diagram.width * 0.25 ? '0' : at.x > diagram.width * 0.75 ? '-100%' : '-50%'}, 10px)`,
  };

  const close = (
    <Button type="button" variant="ghost" size="icon-xs" className="-my-1 -mr-2 ml-auto self-start text-foreground/60" onClick={onClose} aria-label={t('Close')}>
      <X aria-hidden="true" />
    </Button>
  );

  if (picked.kind === 'line') {
    if (!line) return null;
    const { edge } = line;
    return (
      <ReaderCard style={style}>
        <ReaderTitle>
          <span>{nodeName(edge.from)} {edge.dir === 'both' ? '↔' : '→'} {nodeName(edge.to)}</span>
          {close}
        </ReaderTitle>
        <div className={READER_TEXT}>{code(edge.carries)} · <i>{TRANSPORT_LABEL[edge.over]}</i></div>
        {edge.never && <div className={cn(READER_TEXT, NEVER)}>Never: {code(edge.never)}</div>}
        {edge.dormant && <div className={cn(READER_TEXT, DORMANT)}>{code(edge.dormant)}</div>}
        {edge.doc && <div className={READER_SOURCE}><code>{edge.doc}</code></div>}
      </ReaderCard>
    );
  }

  const node = topologyNodeById(picked.id);
  if (!node) return null;
  const touching = lines.filter((line) => line.edge.from === node.id || line.edge.to === node.id);
  const children = childNodes(node.id);
  return (
    <ReaderCard style={style}>
      <ReaderTitle>
        <span>{code(node.name)}</span>
        {node.vendor && <small className="font-normal text-foreground/50">{node.vendor}</small>}
        {close}
      </ReaderTitle>
      <div className={READER_TEXT}>{code(node.holds)}</div>
      {node.stores && <div className={cn(READER_TEXT, 'text-foreground/60')}>Stored in {code(node.stores)}</div>}
      {node.dormant && <div className={cn(READER_TEXT, DORMANT)}>{code(node.dormant)}</div>}
      {children.length > 0 && (
        <div className={READER_TEXT}>
          {children.map((child, index) => (
            <Fragment key={child.id}>
              {index > 0 && <span className="text-foreground/40"> · </span>}
              <span>{code(child.name)}{child.dormant ? ' (off)' : ''}</span>
            </Fragment>
          ))}
        </div>
      )}
      {touching.length > 0 && (
        // A list by role, not <ul>: `.md` would add bullets and indent inside a document.
        <div role="list" className="mt-2.5 mb-1.5 grid gap-2 border-t border-border pt-2.5">
          {touching.map((line) => (
            <div role="listitem" key={lineKey(line)} className="grid gap-0.5">
              <b>{line.edge.from === node.id ? '→' : '←'} {nodeName(line.edge.from === node.id ? line.edge.to : line.edge.from)}</b>
              <span className="text-foreground/70">{code(line.edge.carries)} · <i className="text-foreground/50 not-italic">{TRANSPORT_LABEL[line.edge.over]}</i></span>
              {line.edge.never && <span className={NEVER}>Never: {code(line.edge.never)}</span>}
            </div>
          ))}
        </div>
      )}
      <div className={READER_SOURCE}>
        {node.code && <code>{node.code}</code>}
        {node.doc && <code>{node.doc}</code>}
      </div>
    </ReaderCard>
  );
}

const READER_TEXT = 'mb-1.5 text-foreground/80';
const READER_SOURCE = 'flex flex-wrap gap-2 text-xs text-foreground/50';
const NEVER = 'text-(--accent-mark)';
const DORMANT = 'text-foreground/55';

/** The reader: a Card over the drawing, beside the thing it belongs to. */
function ReaderCard({ style, children }: { style: CSSProperties; children: ReactNode }) {
  return (
    <Card
      data-topology="reader"
      role="status"
      style={style}
      className="absolute z-2 w-[min(320px,76vw)] gap-0 rounded-md bg-popover px-4 py-3.5 text-[13px] shadow-[0_12px_28px_rgb(0_0_0/0.28)]"
    >
      {children}
    </Card>
  );
}

function ReaderTitle({ children }: { children: ReactNode }) {
  return <div className="mb-1.5 flex items-baseline gap-2 text-sm font-semibold">{children}</div>;
}

/**
 * One of the things a collapsed box stands for, hanging under it on a stub:
 * Granola, GitHub and Slack under Connectors, and which of them is off.
 */
function Chip({ chip, parent, picked, onPoint, onPick }: {
  chip: TopologyBox;
  parent: TopologyBox;
  picked: boolean;
  onPoint: () => void;
  onPick: () => void;
}) {
  const { node } = chip;
  const middle = chip.x + chip.width / 2;
  let y = chip.y + (chip.height - textHeight(chip.text)) / 2 + 11;
  return (
    <g
      className="group/chip cursor-pointer outline-none"
      data-topology="chip"
      data-node={node.id}
      role="button"
      tabIndex={0}
      aria-label={`${plain(node.name)}. ${plain(node.holds)}`}
      onMouseEnter={onPoint}
      onFocus={onPoint}
      onClick={onPick}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onPick();
      }}
    >
      <path d={`M ${middle} ${chip.y} L ${middle} ${parent.y + parent.height}`} className="stroke-border [stroke-width:1.2]" fill="none" />
      <rect
        x={chip.x}
        y={chip.y}
        width={chip.width}
        height={chip.height}
        rx={9}
        className={cn('fill-popover stroke-border', picked ? PICKED_RECT : 'group-focus-visible/chip:stroke-(--accent-mark) group-focus-visible/chip:[stroke-width:2]')}
      />
      {chip.text.map((row) => {
        const baseline = y;
        y += row.height;
        return (
          <text key={row.text} x={middle} y={baseline} textAnchor="middle" className={row.className}>{row.text}</text>
        );
      })}
    </g>
  );
}

function Line({ line, state, picked, onPick, labelled }: {
  line: TopologyLine;
  state: PointState;
  picked: boolean;
  onPick: () => void;
  labelled: boolean;
}) {
  const { edge } = line;
  const rows = labelled ? line.labelText : [];
  let y = line.label.y - textHeight(rows) / 2 + 10;
  return (
    <g className={cn(STATE_OPACITY, state === 'dim' && 'opacity-25')} data-topology="line">
      {/* A line that carries a promise ("never audio or video") is the accent:
          it is the one thing on this drawing we want read first. The marker
          arrow takes the line's colour through currentColor. */}
      <path
        d={line.path}
        fill="none"
        className={cn(
          edge.never ? 'stroke-(--accent-mark) text-(--accent-mark)' : 'stroke-foreground/35 text-foreground/35',
          picked ? '[stroke-width:2.4]' : state === 'lit' ? '[stroke-width:2]' : '[stroke-width:1.4]',
        )}
        markerEnd="url(#topology-arrow)"
        markerStart={edge.dir === 'both' ? 'url(#topology-arrow)' : undefined}
      />
      {rows.length > 0 && (
        <g
          className="cursor-pointer outline-none hover:[&_text]:fill-foreground focus-visible:[&_text]:fill-foreground"
          role="button"
          tabIndex={0}
          aria-label={`${plain(edge.carries)}${edge.never ? `. Never: ${plain(edge.never)}` : ''}`}
          onClick={onPick}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            onPick();
          }}
        >
          {rows.map((row) => {
            const baseline = y;
            y += row.height;
            return (
              <text key={`${row.className}-${row.text}`} x={line.label.x} y={baseline} textAnchor="middle" className={cn(row.className, picked && row.className === TEXT_CLASS.lineLabel && 'fill-foreground')}>
                {row.text}
              </text>
            );
          })}
        </g>
      )}
    </g>
  );
}

/** Lit when the pointed-at box is one of its ends; dimmed when something else is pointed at. */
type PointState = 'rest' | 'lit' | 'dim';

function lineState(line: TopologyLine, active: string | null): PointState {
  if (!active) return 'rest';
  return line.edge.from === active || line.edge.to === active ? 'lit' : 'dim';
}

/** A box is lit when it is pointed at, or when a line of the pointed-at box lands on it. */
function boxState(id: string, active: string | null, lines: TopologyLine[]): PointState {
  if (!active) return 'rest';
  if (id === active) return 'lit';
  const joined = lines.some((line) => (line.edge.from === active && line.edge.to === id) || (line.edge.to === active && line.edge.from === id));
  return joined ? 'lit' : 'dim';
}

function nodeName(id: string): ReactNode {
  return code(topologyNodeById(id)?.name ?? id);
}

/** The registry writes a literal in backticks, the way every doc here does. */
function code(text: string): ReactNode {
  return text.split('`').map((part, index) => (index % 2 === 0 ? part : <code key={index}>{part}</code>));
}

/** Two boxes to a row on a phone, four on a page. The figure's `max-[720px]:` padding uses the same width. */
function useNarrow(): boolean {
  const query = '(max-width: 720px)';
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = (event: MediaQueryListEvent) => setNarrow(event.matches);
    setNarrow(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return narrow;
}
