import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { ForceLink } from 'd3-force';
import type { DocsDocumentSummary, DocsGraphEdge, DocsGraphProgress } from './docs';
import { t } from './i18n';
import { LoadingIndicator } from '@/ui/spinner';
import graphConfig from '../../packages/contracts/src/docs-graph-config.json';
import { fitBounds } from './docs-graph-layout';
import {
  createGraphSimulation,
  graphLinks,
  seedGraphNodes,
  type GraphLink,
  type GraphNode,
  type GraphSimulation,
} from './docs-graph-force-layout';

export interface DocsGraphCanvasDocument extends DocsDocumentSummary {
  color: string;
  degree: number;
  group: string;
}

export interface DocsGraphCanvasControls {
  zoomIn: () => void;
  zoomOut: () => void;
  fitVisible: () => void;
}

interface Props {
  documents: DocsGraphCanvasDocument[];
  edges: DocsGraphEdge[];
  hiddenGroups: ReadonlySet<string>;
  selectedID: string | null;
  onOpen: (id: string) => void;
  loading: boolean;
  progress: DocsGraphProgress;
  onControlsReady: (controls: DocsGraphCanvasControls | null) => void;
  onZoomLevelChange: (zoom: number) => void;
}

/** Screen = canvas centre + pan + graph point × scale. */
interface Camera {
  scale: number;
  panX: number;
  panY: number;
  /** The Fit scale this camera was taken from; zoom limits are relative to it. */
  fitScale: number;
}

interface Model {
  documents: DocsGraphCanvasDocument[];
  links: Array<[number, number]>;
  neighbors: number[][];
  radius: number[];
  colors: string[];
  groupOf: number[];
}

type Gesture =
  | { kind: 'node'; index: number; startX: number; startY: number; moved: boolean }
  | { kind: 'pan'; origin: Camera; startX: number; startY: number; moved: boolean }
  | { kind: 'pinch'; origin: Camera; distance: number; midX: number; midY: number };

interface Scene {
  model: Model;
  visible: boolean[];
  nodes: GraphNode[];
  simulation: GraphSimulation | null;
  selected: number;
  hovered: number;
  /** Null until the member pans or zooms: the camera follows Fit every frame. */
  manual: Camera | null;
  current: Camera;
  width: number;
  height: number;
  gesture: Gesture | null;
  pointers: Map<number, { x: number; y: number }>;
  frame: number;
  reportedZoom: number;
}

const DRAG_THRESHOLD = 4;
const LABEL_LIMIT = 300;

function shortTitle(title: string): string {
  return title.length > 36 ? `${title.slice(0, 34)}…` : title;
}

function boundedZoom(zoom: number): number {
  return Math.max(graphConfig.zoom.min, Math.min(graphConfig.zoom.max, zoom));
}

function zoomedCamera(camera: Camera, zoom: number, anchorX: number, anchorY: number, width: number, height: number): Camera {
  const graphX = (anchorX - width / 2 - camera.panX) / camera.scale;
  const graphY = (anchorY - height / 2 - camera.panY) / camera.scale;
  const scale = camera.fitScale * boundedZoom(zoom);
  return {
    scale,
    panX: anchorX - width / 2 - graphX * scale,
    panY: anchorY - height / 2 - graphY * scale,
    fitScale: camera.fitScale,
  };
}

function buildModel(documents: DocsGraphCanvasDocument[], edges: DocsGraphEdge[]): Model {
  const index = new Map(documents.map((document, position) => [document.id, position]));
  const groupNames: string[] = [];
  const colors: string[] = [];
  const groupIndex = new Map<string, number>();
  const groupOf = documents.map((document) => {
    let group = groupIndex.get(document.group);
    if (group === undefined) {
      group = groupNames.length;
      groupIndex.set(document.group, group);
      groupNames.push(document.group);
      colors.push(document.color);
    }
    return group;
  });
  const neighbors: number[][] = documents.map(() => []);
  const links: Array<[number, number]> = [];
  for (const edge of edges) {
    const source = index.get(edge.source);
    const target = index.get(edge.target);
    if (source === undefined || target === undefined) continue;
    links.push([source, target]);
    neighbors[source]!.push(target);
    neighbors[target]!.push(source);
  }
  return {
    documents,
    links,
    neighbors,
    radius: documents.map((document) => Math.min(11, 5 + Math.sqrt(document.degree) * 1.5)),
    colors,
    groupOf,
  };
}

/**
 The graph on one 2D canvas, driven by a live d3-force simulation that
 cools to rest and reheats when a document is dragged. Nodes are drawn, not
 DOM, so a frame costs drawing — never laying out thousands of elements.
 */
export default function DocsGraphCanvas({
  documents,
  edges,
  hiddenGroups,
  selectedID,
  onOpen,
  loading,
  progress,
  onControlsReady,
  onZoomLevelChange,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const model = useMemo(() => buildModel(documents, edges), [documents, edges]);
  const visible = useMemo(() => documents.map((document) => !hiddenGroups.has(document.group)), [documents, hiddenGroups]);
  const sceneRef = useRef<Scene>({
    model,
    visible,
    nodes: [],
    simulation: null,
    selected: -1,
    hovered: -1,
    manual: null,
    current: { scale: 1, panX: 0, panY: 0, fitScale: 1 },
    width: 0,
    height: 0,
    gesture: null,
    pointers: new Map(),
    frame: 0,
    reportedZoom: 1,
  });
  const onOpenRef = useRef(onOpen);
  const onZoomRef = useRef(onZoomLevelChange);
  onOpenRef.current = onOpen;
  onZoomRef.current = onZoomLevelChange;

  const draw = useCallback(() => {
    const scene = sceneRef.current;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !container || !context || scene.width <= 0 || scene.height <= 0) return;
    const { model, visible, nodes, width, height } = scene;
    const count = Math.min(nodes.length, model.documents.length, visible.length);

    // Until the member takes the camera, frame whatever is visible now.
    let camera = scene.manual;
    if (!camera) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let index = 0; index < count; index += 1) {
        if (!visible[index]) continue;
        const node = nodes[index]!;
        minX = Math.min(minX, node.x ?? 0);
        maxX = Math.max(maxX, node.x ?? 0);
        minY = Math.min(minY, node.y ?? 0);
        maxY = Math.max(maxY, node.y ?? 0);
      }
      const bounds = fitBounds(Number.isFinite(minX) ? [{ x: minX, y: minY }, { x: maxX, y: maxY }] : []);
      const scale = Math.min(width / bounds.width, height / bounds.height);
      camera = {
        scale,
        panX: -(bounds.x + bounds.width / 2) * scale,
        panY: -(bounds.y + bounds.height / 2) * scale,
        fitScale: scale,
      };
    }
    scene.current = camera;
    const zoom = scene.manual ? scene.manual.scale / scene.manual.fitScale : 1;
    if (zoom !== scene.reportedZoom) {
      scene.reportedZoom = zoom;
      onZoomRef.current(zoom);
    }

    const style = getComputedStyle(container);
    const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
    const lineColor = token('--line', '#888');
    const inkColor = token('--ink', '#111');
    const accentColor = token('--accent', '#3b82f6');
    const haloColor = token('--surface-sunken', '#fff');

    const dpr = window.devicePixelRatio || 1;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);

    const screenX = new Float64Array(count);
    const screenY = new Float64Array(count);
    const onScreen = new Uint8Array(count);
    const margin = 40;
    for (let index = 0; index < count; index += 1) {
      const x = width / 2 + camera.panX + (nodes[index]!.x ?? 0) * camera.scale;
      const y = height / 2 + camera.panY + (nodes[index]!.y ?? 0) * camera.scale;
      screenX[index] = x;
      screenY[index] = y;
      onScreen[index] = visible[index] && x > -margin && y > -margin && x < width + margin && y < height + margin ? 1 : 0;
    }
    const focus = scene.hovered >= 0 && scene.hovered < count ? scene.hovered : -1;
    const focused = new Set<number>(focus >= 0 ? [focus, ...model.neighbors[focus]!] : []);

    // Edges: one path, one stroke. Lines into the focused node go on top.
    context.lineWidth = 1;
    context.strokeStyle = lineColor;
    context.globalAlpha = focus >= 0 ? 0.3 : 0.8;
    context.beginPath();
    for (const [source, target] of model.links) {
      if (source >= count || target >= count || !visible[source] || !visible[target]) continue;
      if (!onScreen[source] && !onScreen[target]) continue;
      if (focus >= 0 && (source === focus || target === focus)) continue;
      context.moveTo(screenX[source]!, screenY[source]!);
      context.lineTo(screenX[target]!, screenY[target]!);
    }
    context.stroke();
    if (focus >= 0) {
      context.globalAlpha = 0.9;
      context.lineWidth = 1.5;
      context.strokeStyle = accentColor;
      context.beginPath();
      for (const neighbor of model.neighbors[focus]!) {
        if (!visible[neighbor]) continue;
        context.moveTo(screenX[focus]!, screenY[focus]!);
        context.lineTo(screenX[neighbor]!, screenY[neighbor]!);
      }
      context.stroke();
    }

    // Nodes: one fill per folder colour, dimmed apart from the focus.
    const radii = new Float64Array(count);
    for (let index = 0; index < count; index += 1) {
      if (onScreen[index]) radii[index] = Math.max(1.5, model.radius[index]! * camera.scale);
    }
    for (const dimmed of [true, false]) {
      if (dimmed && focus < 0) continue;
      context.globalAlpha = dimmed ? 0.25 : 1;
      model.colors.forEach((color, group) => {
        context.fillStyle = color;
        context.beginPath();
        for (let index = 0; index < count; index += 1) {
          if (!onScreen[index] || model.groupOf[index] !== group) continue;
          if (focus >= 0 && focused.has(index) === dimmed) continue;
          context.moveTo(screenX[index]! + radii[index]!, screenY[index]!);
          context.arc(screenX[index]!, screenY[index]!, radii[index]!, 0, Math.PI * 2);
        }
        context.fill();
      });
    }
    context.globalAlpha = 1;
    for (const [index, color] of [[scene.selected, accentColor], [focus, inkColor]] as const) {
      if (index < 0 || index >= count || !onScreen[index]) continue;
      context.lineWidth = 2;
      context.strokeStyle = color;
      context.beginPath();
      context.arc(screenX[index]!, screenY[index]!, radii[index]! + 2, 0, Math.PI * 2);
      context.stroke();
    }

    // Labels fade in with zoom, earlier for well-linked documents; the focus
    // and the open document always carry theirs.
    context.font = '500 11px "Inter", sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'top';
    context.lineJoin = 'round';
    context.lineWidth = 3;
    context.strokeStyle = haloColor;
    context.fillStyle = inkColor;
    const few = model.documents.length <= 35;
    let drawn = 0;
    for (let index = 0; index < count; index += 1) {
      if (!onScreen[index]) continue;
      const always = index === scene.selected || focused.has(index);
      let opacity = 1;
      if (!always && !few) {
        const reach = camera.scale * (1 + Math.sqrt(model.documents[index]!.degree) / 3);
        opacity = Math.min(1, Math.max(0, (reach - 0.6) / 0.4));
        if (focus >= 0) opacity *= 0.3;
      }
      if (opacity <= 0.02 || (!always && drawn >= LABEL_LIMIT)) continue;
      drawn += 1;
      const title = shortTitle(model.documents[index]!.title);
      const y = screenY[index]! + radii[index]! + 3;
      context.globalAlpha = opacity;
      context.strokeText(title, screenX[index]!, y);
      context.fillText(title, screenX[index]!, y);
    }
    context.globalAlpha = 1;
  }, []);

  const requestDraw = useCallback(() => {
    const scene = sceneRef.current;
    if (scene.frame) return;
    scene.frame = requestAnimationFrame(() => {
      scene.frame = 0;
      draw();
    });
  }, [draw]);

  // The simulation keeps every node it already placed, so streamed links
  // pull documents into place instead of restarting the layout.
  useEffect(() => {
    const scene = sceneRef.current;
    const previous = new Map(scene.nodes.map((node) => [node.id, node]));
    const nodes = seedGraphNodes(documents, previous);
    const fresh = nodes.reduce((total, node) => total + (previous.has(node.id) ? 0 : 1), 0);
    scene.nodes = nodes;
    if (!scene.simulation) {
      scene.simulation = createGraphSimulation(nodes, edges).on('tick', draw);
    } else {
      scene.simulation.nodes(nodes);
      (scene.simulation.force('links') as ForceLink<GraphNode, GraphLink>).links(graphLinks(nodes, edges));
    }
    const heat = previous.size === 0 || fresh * 4 > nodes.length ? 1 : graphConfig.layout.reheatAlpha;
    scene.simulation.alpha(Math.max(scene.simulation.alpha(), heat)).restart();
  }, [documents, draw, edges]);

  useEffect(() => () => {
    const scene = sceneRef.current;
    scene.simulation?.stop();
    if (scene.frame) cancelAnimationFrame(scene.frame);
  }, []);

  useEffect(() => {
    const scene = sceneRef.current;
    scene.model = model;
    scene.visible = visible;
    scene.selected = selectedID === null ? -1 : documents.findIndex((document) => document.id === selectedID);
    if (scene.hovered >= documents.length) scene.hovered = -1;
    requestDraw();
  }, [documents, model, requestDraw, selectedID, visible]);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      const scene = sceneRef.current;
      const dpr = window.devicePixelRatio || 1;
      scene.width = rect.width;
      scene.height = rect.height;
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      draw();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [draw]);

  const zoomBy = useCallback((factor: number) => {
    const scene = sceneRef.current;
    const camera = scene.manual ?? scene.current;
    scene.manual = zoomedCamera(camera, (camera.scale / camera.fitScale) * factor, scene.width / 2, scene.height / 2, scene.width, scene.height);
    requestDraw();
  }, [requestDraw]);

  const controls = useMemo<DocsGraphCanvasControls>(() => ({
    zoomIn: () => zoomBy(1.2),
    zoomOut: () => zoomBy(1 / 1.2),
    fitVisible: () => {
      sceneRef.current.manual = null;
      requestDraw();
    },
  }), [requestDraw, zoomBy]);

  useEffect(() => {
    onControlsReady(controls);
    return () => onControlsReady(null);
  }, [controls, onControlsReady]);

  // Wheel and trackpad pinch zoom around the pointer. React's wheel
  // listener is passive, so this one is attached by hand.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const scene = sceneRef.current;
      const camera = scene.manual ?? scene.current;
      const rect = canvas.getBoundingClientRect();
      const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015));
      scene.manual = zoomedCamera(camera, (camera.scale / camera.fitScale) * factor, event.clientX - rect.left, event.clientY - rect.top, scene.width, scene.height);
      requestDraw();
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [requestDraw]);

  function localPoint(event: ReactPointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  /** The nearest visible node under the pointer, measured on screen. */
  function hitTest(x: number, y: number): number {
    const scene = sceneRef.current;
    const camera = scene.current;
    let best = -1;
    let bestDistance = Infinity;
    const count = Math.min(scene.nodes.length, scene.visible.length);
    for (let index = 0; index < count; index += 1) {
      if (!scene.visible[index]) continue;
      const node = scene.nodes[index]!;
      const screenX = scene.width / 2 + camera.panX + (node.x ?? 0) * camera.scale;
      const screenY = scene.height / 2 + camera.panY + (node.y ?? 0) * camera.scale;
      const reach = Math.max(scene.model.radius[index]! * camera.scale, 6) + 3;
      const distance = Math.hypot(screenX - x, screenY - y);
      if (distance <= reach && distance < bestDistance) {
        best = index;
        bestDistance = distance;
      }
    }
    return best;
  }

  function setHovered(index: number) {
    const scene = sceneRef.current;
    if (scene.hovered === index) return;
    scene.hovered = index;
    requestDraw();
  }

  function updateCursor(canvas: HTMLCanvasElement) {
    const scene = sceneRef.current;
    canvas.style.cursor = scene.gesture?.kind === 'pan' && scene.gesture.moved
      ? 'grabbing'
      : scene.gesture?.kind === 'node' || scene.hovered >= 0 ? 'pointer' : 'grab';
  }

  function takeControl(): Camera {
    const scene = sceneRef.current;
    scene.manual ??= scene.current;
    return scene.manual;
  }

  function graphPoint(x: number, y: number) {
    const scene = sceneRef.current;
    const camera = scene.current;
    return {
      x: (x - scene.width / 2 - camera.panX) / camera.scale,
      y: (y - scene.height / 2 - camera.panY) / camera.scale,
    };
  }

  function endNodeDrag() {
    const scene = sceneRef.current;
    if (scene.gesture?.kind !== 'node' || !scene.gesture.moved) return;
    const node = scene.nodes[scene.gesture.index];
    if (node) {
      node.fx = null;
      node.fy = null;
    }
    scene.simulation?.alphaTarget(0);
  }

  function onPointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    const scene = sceneRef.current;
    const point = localPoint(event);
    event.currentTarget.setPointerCapture(event.pointerId);
    scene.pointers.set(event.pointerId, point);
    if (scene.pointers.size === 2) {
      endNodeDrag();
      const [first, second] = [...scene.pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
      scene.gesture = {
        kind: 'pinch',
        origin: takeControl(),
        distance: Math.max(1, Math.hypot(first.x - second.x, first.y - second.y)),
        midX: (first.x + second.x) / 2,
        midY: (first.y + second.y) / 2,
      };
      return;
    }
    const hit = hitTest(point.x, point.y);
    scene.gesture = hit >= 0
      ? { kind: 'node', index: hit, startX: point.x, startY: point.y, moved: false }
      : { kind: 'pan', origin: scene.manual ?? scene.current, startX: point.x, startY: point.y, moved: false };
    updateCursor(event.currentTarget);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    const scene = sceneRef.current;
    const point = localPoint(event);
    if (scene.pointers.has(event.pointerId)) scene.pointers.set(event.pointerId, point);
    const gesture = scene.gesture;
    if (!gesture) {
      setHovered(hitTest(point.x, point.y));
      updateCursor(event.currentTarget);
      return;
    }
    if (gesture.kind === 'pinch') {
      const [first, second] = [...scene.pointers.values()];
      if (!first || !second) return;
      const midX = (first.x + second.x) / 2;
      const midY = (first.y + second.y) / 2;
      const ratio = Math.hypot(first.x - second.x, first.y - second.y) / gesture.distance;
      const zoomed = zoomedCamera(gesture.origin, (gesture.origin.scale / gesture.origin.fitScale) * ratio, gesture.midX, gesture.midY, scene.width, scene.height);
      scene.manual = { ...zoomed, panX: zoomed.panX + midX - gesture.midX, panY: zoomed.panY + midY - gesture.midY };
      requestDraw();
      return;
    }
    if (!gesture.moved && Math.hypot(point.x - gesture.startX, point.y - gesture.startY) < DRAG_THRESHOLD) return;
    if (gesture.kind === 'node') {
      if (!gesture.moved) {
        // Freeze the camera first: a node dragged against a camera that keeps
        // refitting would chase its own frame.
        takeControl();
        scene.simulation?.alphaTarget(graphConfig.layout.dragAlphaTarget).restart();
      }
      gesture.moved = true;
      const node = scene.nodes[gesture.index];
      if (node) {
        const target = graphPoint(point.x, point.y);
        node.fx = target.x;
        node.fy = target.y;
      }
    } else {
      gesture.moved = true;
      scene.manual = { ...gesture.origin, panX: gesture.origin.panX + point.x - gesture.startX, panY: gesture.origin.panY + point.y - gesture.startY };
      requestDraw();
    }
    updateCursor(event.currentTarget);
  }

  function onPointerUp(event: ReactPointerEvent<HTMLCanvasElement>) {
    const scene = sceneRef.current;
    scene.pointers.delete(event.pointerId);
    const gesture = scene.gesture;
    if (gesture?.kind === 'pinch') {
      if (scene.pointers.size === 0) scene.gesture = null;
      return;
    }
    if (gesture?.kind === 'node' && !gesture.moved && event.type === 'pointerup') {
      const document = scene.model.documents[gesture.index];
      if (document) onOpenRef.current(document.id);
    }
    endNodeDrag();
    scene.gesture = null;
    updateCursor(event.currentTarget);
  }

  function onPointerLeave(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!sceneRef.current.gesture) setHovered(-1);
    updateCursor(event.currentTarget);
  }

  return (
    <>
      <div ref={containerRef} className="docs-graph-canvas">
        {/* hover: the canvas draws its own ring and cursor under the pointer */}
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={t('Docs graph')}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={onPointerLeave}
        />
        <ul className="sr-only" aria-label={t('Documents in the graph')}>
          {documents.map((document, index) => visible[index] && (
            <li key={document.id}>
              {/* hover: visually hidden; focus draws the node's ring on the canvas */}
              {/* shadcn: a screen-reader twin of a canvas node */}
              <button
                type="button"
                aria-current={document.id === selectedID ? 'page' : undefined}
                onFocus={() => setHovered(index)}
                onBlur={() => setHovered(-1)}
                onClick={() => onOpen(document.id)}
              >
                {t('Open {title}', { title: document.title })}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <p className="docs-graph-hint">{t('Drag to pan, or drag a document to pull its links; scroll to zoom. Point at a document to trace its links; select it to open it.')}</p>
      {loading && (
        <LoadingIndicator
          label={progress.phase === 'documents' ? t('Loading documents…') : t('Loading document links…')}
          labelVisibility="visible"
          className="docs-graph-link-status"
        />
      )}
    </>
  );
}
