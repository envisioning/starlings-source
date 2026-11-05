/**
 * Seeded visual identity for Meet agents. Keep this module zod-free: the
 * browser's agent avatar can use the same recipe without pulling validation
 * code into its entry bundle.
 */
export const AGENT_AVATAR_SHAPES = [
  'circle', 'pebble', 'squircle', 'capsule', 'triangle', 'hexagon', 'cloud', 'droplet',
] as const;

/** Flat Meet palette swatches. Each seed resolves to one swatch. */
export const AGENT_AVATAR_PALETTE = [
  '#e4572e', '#68a9d5', '#bf91db', '#e98f70', '#50b99b',
  '#d6ad42', '#d8799b', '#8799e6', '#aacc00',
] as const;

export type AgentAvatarShapeName = (typeof AGENT_AVATAR_SHAPES)[number];

export interface AgentAvatarIdentity {
  /** Stable hex fingerprint of the canonical key; suitable for display. */
  seed: string;
  /** One solid six-digit sRGB color, generated from seed and the palette. */
  color: string;
  /** Shape chosen once by the contract recipe and sent to every client. */
  shape: AgentAvatarShapeName;
  /** Canonical vector paths in the -120..120 view box, shared by all clients. */
  body_path: string;
  eyes_path: string;
}

const SHAPE_SLOT = 1;
// Frozen palette mapping for the original roster; it keeps each of those
// addresses on a different swatch without storing colors in AGENT_ROSTER.
const COLOR_SLOT = 862;
const identityCache = new Map<string, AgentAvatarIdentity>();

/** FNV-1a over the roster's ASCII seed, matching the approved preview. */
export function agentAvatarSeedHash(seed: string): number {
  let value = 2_166_136_261;
  for (let index = 0; index < seed.length; index += 1) {
    value ^= seed.charCodeAt(index);
    value = Math.imul(value, 16_777_619);
  }
  return value >>> 0;
}

function mix(seed: number, slot: number): number {
  let value = (seed ^ Math.imul(slot + 1, 0x9e3779b9)) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x85ebca6b);
  value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35);
  return (value ^ (value >>> 16)) >>> 0;
}

/**
 * Resolve an identity in one place, at roster parse time. The shape recipe is
 * deliberately versioned by these stable slot numbers: changing it is a
 * product identity change, not a harmless random tweak.
 */
export function makeAgentAvatarIdentity(
  stableKey: string,
): AgentAvatarIdentity {
  const key = stableKey.trim().toLowerCase();
  const cached = identityCache.get(key);
  if (cached) return cached;
  const seedHash = agentAvatarSeedHash(key);
  // A later address can share a swatch, but existing agents never move when
  // the roster grows or is reordered. Both slots are versioned identity data.
  const color = AGENT_AVATAR_PALETTE[mix(seedHash, COLOR_SLOT) % AGENT_AVATAR_PALETTE.length]!;
  const shape = AGENT_AVATAR_SHAPES[mix(seedHash, SHAPE_SLOT) % AGENT_AVATAR_SHAPES.length]!;
  const profile = SHAPE_PROFILES[shape]!;
  const identity = {
    seed: `0x${seedHash.toString(16).padStart(8, '0')}`,
    color,
    shape,
    body_path: closedRadialPath(profile, 100),
    eyes_path: projectedEyesPath(profile),
  };
  identityCache.set(key, identity);
  return identity;
}

// These profile functions are the static part of the approved Bloub-inspired
// silhouette recipe. The Worker emits the resulting paths once in the peer
// contract, so web, Mac and iOS paint exactly the same outline and eye pose.
const SAMPLE_COUNT = 64;
const TAU = Math.PI * 2;
const angles = Array.from({ length: SAMPLE_COUNT }, (_, index) => (index / SAMPLE_COUNT) * TAU);
const cosine = angles.map(Math.cos);
const sine = angles.map(Math.sin);

interface Point { x: number; y: number }
interface Circle { x: number; y: number; r: number }

function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error('Agent avatar geometry is incomplete.');
  return value;
}

function normalize(radii: number[], maximum = 1): number[] {
  const peak = Math.max(...radii);
  return peak <= 0 ? radii : radii.map((radius) => radius * maximum / peak);
}

function profileFromPolygon(polygon: Point[]): number[] {
  return angles.map((_, index) => {
    const dx = at(cosine, index);
    const dy = at(sine, index);
    let best = 0;
    for (let edge = 0; edge < polygon.length; edge += 1) {
      const a = at(polygon, edge);
      const b = at(polygon, (edge + 1) % polygon.length);
      const ex = b.x - a.x;
      const ey = b.y - a.y;
      const denominator = dx * ey - dy * ex;
      if (Math.abs(denominator) < 1e-9) continue;
      const px = a.x;
      const py = a.y;
      const distance = (px * ey - py * ex) / denominator;
      const along = (px * dy - py * dx) / denominator;
      if (distance > best && along >= 0 && along <= 1) best = distance;
    }
    return best;
  });
}

function circleUnion(circles: Circle[]): number[] {
  return angles.map((_, index) => {
    const dx = at(cosine, index);
    const dy = at(sine, index);
    let best = 0;
    for (const circle of circles) {
      const b = dx * circle.x + dy * circle.y;
      const discriminant = b * b - (circle.x * circle.x + circle.y * circle.y - circle.r * circle.r);
      if (discriminant < 0) continue;
      best = Math.max(best, b + Math.sqrt(discriminant));
    }
    return best;
  });
}

function hullOfCircles(x1: number, y1: number, r1: number, x2: number, y2: number, r2: number): Point[] {
  const count = 96;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const distance = Math.hypot(dx, dy) || 1e-6;
  const base = Math.atan2(dy, dx);
  const spread = Math.acos(Math.max(-1, Math.min(1, (r1 - r2) / distance)));
  const points: Point[] = [];
  for (let index = 0; index <= count / 2; index += 1) {
    const angle = base + spread + ((TAU - 2 * spread) * index) / (count / 2);
    points.push({ x: x1 + Math.cos(angle) * r1, y: y1 + Math.sin(angle) * r1 });
  }
  for (let index = 0; index <= count / 2; index += 1) {
    const angle = base - spread + ((2 * spread) * index) / (count / 2);
    points.push({ x: x2 + Math.cos(angle) * r2, y: y2 + Math.sin(angle) * r2 });
  }
  return points;
}

function roundedPolygon(vertices: Point[], radius: number): Point[] {
  const points: Point[] = [];
  function outwardNormal(a: Point, b: Point): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy) || 1;
    return Math.atan2(-dx / length, dy / length);
  }
  for (let index = 0; index < vertices.length; index += 1) {
    const previous = at(vertices, (index - 1 + vertices.length) % vertices.length);
    const current = at(vertices, index);
    const next = at(vertices, (index + 1) % vertices.length);
    const start = outwardNormal(previous, current);
    const end = outwardNormal(current, next);
    let delta = end - start;
    while (delta > Math.PI) delta -= TAU;
    while (delta < -Math.PI) delta += TAU;
    for (let step = 0; step <= 10; step += 1) {
      const angle = start + delta * step / 10;
      points.push({ x: current.x + Math.cos(angle) * radius, y: current.y + Math.sin(angle) * radius });
    }
  }
  return points;
}

function polygonProfile(sides: number, radius: number, cornerRadius: number, rotationDegrees: number): number[] {
  const rotation = rotationDegrees * Math.PI / 180;
  const vertices = Array.from({ length: sides }, (_, index) => {
    const angle = rotation + index / sides * TAU;
    const inset = radius - cornerRadius;
    return { x: Math.cos(angle) * inset, y: Math.sin(angle) * inset };
  });
  return profileFromPolygon(roundedPolygon(vertices, cornerRadius));
}

function profiles(): Record<AgentAvatarShapeName, number[]> {
  const circle = new Array(SAMPLE_COUNT).fill(1) as number[];
  const pebble = normalize(angles.map((angle) => 1 + 0.075 * Math.cos(2 * angle + 0.5) + 0.035 * Math.cos(3 * angle + 2.1)), 1.02);
  const squircle = normalize(angles.map((_, index) => {
    const exponent = 4.2;
    return (Math.abs(at(cosine, index)) ** exponent + Math.abs(at(sine, index)) ** exponent) ** (-1 / exponent);
  }), 1.15);
  const capsule = profileFromPolygon(hullOfCircles(-0.42, 0, 0.62, 0.42, 0, 0.62));
  const cloud = normalize(circleUnion([
    { x: -0.44, y: 0.2, r: 0.54 }, { x: 0.46, y: 0.2, r: 0.5 },
    { x: 0.02, y: 0.3, r: 0.6 }, { x: -0.24, y: -0.3, r: 0.48 },
    { x: 0.3, y: -0.24, r: 0.44 },
  ]), 1.02);
  const droplet = normalize(profileFromPolygon(hullOfCircles(0, 0.28, 0.66, 0, -0.96, 0.05)), 1.04);
  return {
    circle,
    pebble,
    squircle,
    capsule,
    triangle: polygonProfile(3, 1.12, 0.34, -90),
    hexagon: polygonProfile(6, 1.04, 0.26, 0),
    cloud,
    droplet,
  };
}

function rounded(value: number): string { return (Math.round(value * 100) / 100).toString(); }

function pathFromRadii(
  radii: number[],
  scale: number,
  transform: (point: Point) => Point = (point) => point,
): string {
  const points = angles.map((_, index) => transform({
    x: at(radii, index) * scale * at(cosine, index),
    y: at(radii, index) * scale * at(sine, index),
  }));
  const first = at(points, 0);
  let path = `M${rounded(first.x)} ${rounded(first.y)}`;
  for (let index = 0; index < points.length; index += 1) {
    const p0 = at(points, (index - 1 + points.length) % points.length);
    const p1 = at(points, index);
    const p2 = at(points, (index + 1) % points.length);
    const p3 = at(points, (index + 2) % points.length);
    path += `C${rounded(p1.x + (p2.x - p0.x) / 6)} ${rounded(p1.y + (p2.y - p0.y) / 6)}`;
    path += ` ${rounded(p2.x - (p3.x - p1.x) / 6)} ${rounded(p2.y - (p3.y - p1.y) / 6)}`;
    path += ` ${rounded(p2.x)} ${rounded(p2.y)}`;
  }
  return `${path}Z`;
}

function radiusAt(radii: number[], angle: number): number {
  const position = ((((angle / TAU) % 1) + 1) % 1) * radii.length;
  const index = Math.floor(position);
  const fraction = position - index;
  return at(radii, index % radii.length)
    + (at(radii, (index + 1) % radii.length) - at(radii, index % radii.length)) * fraction;
}

/** Radial outline of a true capsule: a line segment thickened by one disk. */
function capsuleProfile(radius: number, halfSegment: number): number[] {
  return angles.map((_, index) => {
    const dx = Math.abs(at(cosine, index));
    const dy = Math.abs(at(sine, index));
    const stripRadius = radius / Math.max(dx, 1e-9);
    if (stripRadius * dy <= halfSegment) return stripRadius;
    const discriminant = radius * radius - halfSegment * halfSegment * dx * dx;
    return halfSegment * dy + Math.sqrt(Math.max(0, discriminant));
  });
}

function spinBasis(first: number[], second: number[], angle: number): [number[], number[]] {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return [
    first.map((value, index) => value * cosine + at(second, index) * sine),
    second.map((value, index) => value * cosine - at(first, index) * sine),
  ];
}

function projectedEyesPath(body: number[]): string {
  const radians = Math.PI / 180;
  // Keep the static identity nearly face-on: without animation, a strong head
  // turn or rolled capsule reads as a crooked gaze. A slight surface turn keeps
  // the eyes projected while leaving the pair level and centered.
  const eyeRadius = 18.6 / 2;
  const eyeHalfSegment = (41.2 - 18.6) / 2;
  const eyeCapsule = capsuleProfile(eyeRadius, eyeHalfSegment);
  const eyeTilt = 8 * radians;
  const eyeTiltCosine = Math.cos(eyeTilt);
  const eyeTiltSine = Math.sin(eyeTilt);
  let forward = [0, 0, 1];
  let right = [1, 0, 0];
  let down = [0, 1, 0];
  [forward, right] = spinBasis(forward, right, 4 * radians);
  [down, forward] = spinBasis(down, forward, 2 * radians);
  return [-1, 1].map((side) => {
    const [eyeForward, eyeRight] = spinBasis(forward, right, 9 * side * radians);
    const center = { x: at(eyeForward, 0) * 100, y: at(eyeForward, 1) * 100 };
    const fit = radiusAt(body, Math.atan2(center.y, center.x));
    const tx = center.x * fit;
    const ty = center.y * fit;
    return pathFromRadii(eyeCapsule, 1, (point) => {
      // Keep the capsule axis close to upright for a calm, forward gaze.
      const across = point.x * eyeTiltCosine + point.y * eyeTiltSine;
      const vertical = point.y * eyeTiltCosine - point.x * eyeTiltSine;
      return {
        x: at(eyeRight, 0) * across + at(down, 0) * vertical + tx,
        y: at(eyeRight, 1) * across + at(down, 1) * vertical + ty,
      };
    });
  }).join('');
}

function closedRadialPath(radii: number[], scale: number): string {
  return pathFromRadii(radii, scale);
}

const SHAPE_PROFILES = profiles();
