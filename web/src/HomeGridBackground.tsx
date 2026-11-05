import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useThemePreference } from './theme';
import { useHomeTexture } from './home-texture';

/**
 * The web twin of the Mac and iOS brand lattice, used behind Home and the
 * meeting Stage
 * (`HomeGridLattice.swift`, `BrandGridBackground.swift`,
 * `MobileHomeGridBackground.swift`): a centre-anchored field of 32px
 * squares, per-line alpha variation baked from the same seed, a fade on all
 * four edges. Home owns
 * the field as its atmospheric arrival point, and the meeting Stage reuses it
 * behind the participant tiles so the product has one visual ground.
 *
 * Centre-anchored and redrawn from a `ResizeObserver` rather than left to
 * stretch: each axis places its lines from the fixed pitch independently of
 * the other, so resizing reveals or hides whole cells at the edges without
 * changing the phase of the field. This is the same positioning rule used by
 * the Mac and iOS implementations.
 */
const PITCH = 32;
const MULTIPLIER_MIN = 0.7;
const MULTIPLIER_MAX = 1.0;
const BAKED_LINES = 80;
const SEED = 0x5eed1;
// Keep the dark value in step with HomeGridLattice.darkBaseAlpha on Mac/iOS.
const BASE_ALPHA_DARK = 0.09;
const BASE_ALPHA_LIGHT = 0.1;

/** Signed line indices covering `span`, index 0 nearest the centre. One extra
 * on each side keeps a line present past the edge, under the fade. */
function indices(span: number): number[] {
  if (span <= 0) return [0];
  const reach = Math.ceil(span / 2 / PITCH) + 1;
  const out: number[] = [];
  for (let i = -reach; i <= reach; i += 1) out.push(i);
  return out;
}

/** Where line `index` sits in a span of `span`, anchored to its centre. */
function position(index: number, span: number): number {
  return span / 2 + index * PITCH;
}

/** Same cheap seedable PRNG as `HomeGridNoise` — same seed, same field. */
function bakeMultipliers(): { columns: number[]; rows: number[] } {
  let state = SEED;
  function next(): number {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return (state >>> 16) / 65536;
  }
  function bake(): number[] {
    const out: number[] = [];
    for (let i = 0; i < BAKED_LINES; i += 1) {
      out.push(MULTIPLIER_MIN + next() * (MULTIPLIER_MAX - MULTIPLIER_MIN));
    }
    return out;
  }
  return { columns: bake(), rows: bake() };
}

function alphaFor(multipliers: number[], index: number, base: number): number {
  const slot = index + BAKED_LINES / 2;
  const multiplier = multipliers[slot] ?? 1;
  return multiplier * base;
}

/** Baked once at module scope — identical field on every mount, the same
 *  rule the native clients follow. */
const multipliers = bakeMultipliers();

function drawLattice(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  dpr: number,
  color: string,
  baseAlpha: number,
): void {
  ctx.clearRect(0, 0, width, height);
  // One device pixel, wherever it lands.
  ctx.lineWidth = 1 / dpr;
  function align(value: number): number {
    return (Math.round(value * dpr) + 0.5) / dpr;
  }
  function line(x1: number, y1: number, x2: number, y2: number, alpha: number): void {
    ctx.strokeStyle = color;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  for (const index of indices(width)) {
    const x = align(position(index, width));
    line(x, 0, x, height, alphaFor(multipliers.columns, index, baseAlpha));
  }
  for (const index of indices(height)) {
    const y = align(position(index, height));
    line(0, y, width, y, alphaFor(multipliers.rows, index, baseAlpha));
  }
  ctx.globalAlpha = 1;
}

function readCSSColor(variable: string): string {
  if (typeof document === 'undefined') return '#ffffff';
  return getComputedStyle(document.documentElement).getPropertyValue(variable).trim() || '#ffffff';
}

/**
 * Decoration only: no hit testing, hidden from assistive tech, and the
 * reveal drops out under `prefers-reduced-motion` — the same rules the Mac
 * and iOS layers follow.
 */
export function HomeGridBackground({ meetingMode = false }: { meetingMode?: boolean }) {
  // Off is this browser's Appearance choice (#230): nothing is mounted, so
  // the canvas and its animation frame never run.
  const [showsTexture] = useHomeTexture();
  if (!showsTexture) return null;
  return <HomeGridCanvas meetingMode={meetingMode} />;
}

function HomeGridCanvas({ meetingMode }: { meetingMode: boolean }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [preference] = useThemePreference();
  const [prefersLight, setPrefersLight] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches,
  );
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => setPrefersLight(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  // Home: dark uses the mark's lime at low alpha; light is monochrome so the
  // brand colour stays reserved for fills. The meeting Stage is neutral in
  // both appearances, matching the native clients.
  const isDark = preference === 'dark' || (preference === 'auto' && !prefersLight);
  const colorVariable = meetingMode ? '--text-muted' : (isDark ? '--accent-mark' : '--ink');
  const baseAlpha = isDark ? BASE_ALPHA_DARK : BASE_ALPHA_LIGHT;
  const color = useMemo(() => readCSSColor(colorVariable), [colorVariable, isDark]);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!stage || !canvas) return;

    let frame: number | undefined;
    let lastPixelWidth = 0;
    let lastPixelHeight = 0;

    function redraw() {
      // `getBoundingClientRect()` includes the 0.98 reveal transform. Using
      // it here makes the first canvas 2% too narrow; once the reveal settles,
      // the next real resize redraws at full width and the grid visibly jumps.
      // Client dimensions are the untransformed layout box we actually want.
      const width = stage!.clientWidth;
      const height = stage!.clientHeight;
      if (width <= 0 || height <= 0) return;
      const dpr = Math.max(window.devicePixelRatio || 1, 1);
      const pixelWidth = Math.round(width * dpr);
      const pixelHeight = Math.round(height * dpr);
      if (pixelWidth === lastPixelWidth && pixelHeight === lastPixelHeight) return;
      lastPixelWidth = pixelWidth;
      lastPixelHeight = pixelHeight;
      // CSS already stretches the canvas to the layout box. Only resize the
      // backing bitmap when a device pixel boundary changes; repeatedly
      // assigning width/height during a live resize clears the canvas and
      // makes the lattice look like it is vibrating.
      canvas!.width = pixelWidth;
      canvas!.height = pixelHeight;
      const ctx = canvas!.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawLattice(ctx, width, height, dpr, color, baseAlpha);
    }

    redraw();
    const scheduleRedraw = () => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        redraw();
      });
    };
    const observer = new ResizeObserver(scheduleRedraw);
    observer.observe(stage);
    return () => {
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [color, baseAlpha]);

  useEffect(() => {
    // Home should open with the field already resolving, not materialise a
    // frame late — but a synchronous class on first paint never transitions,
    // so the reveal is deferred one frame.
    const id = requestAnimationFrame(() => setRevealed(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Nested fades (vertical, then horizontal) mirror `BrandGridBackground`'s
  // layer nesting: the ragged part-cells at the margins go quiet under the
  // fade rather than being drawn ragged. The vertical fade keeps a broad
  // central plateau: this is an atmospheric field, not a border treatment.
  return (
    <div
      ref={stageRef}
      className={`pointer-events-none absolute inset-0 z-0 overflow-hidden transition-[opacity,scale] duration-600 ease-out motion-reduce:transition-none ${revealed ? 'opacity-100' : 'scale-[0.98] opacity-0'}`}
      aria-hidden="true"
    >
      <div className="absolute inset-0 [mask-image:linear-gradient(to_bottom,transparent_0%,black_18%,black_82%,transparent_100%)]">
        <div className="absolute inset-0 [mask-image:linear-gradient(to_right,transparent_0%,black_12%,black_88%,transparent_100%)]">
          <canvas ref={canvasRef} className="absolute inset-0 size-full" />
        </div>
      </div>
    </div>
  );
}
