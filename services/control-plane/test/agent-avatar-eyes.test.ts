import { describe, expect, it } from 'vitest';
import { AGENT_AVATAR_SHAPES, makeAgentAvatarIdentity } from '@starlings/contracts/agent-avatar-values';

interface Point { x: number; y: number }

function contours(path: string): Point[][] {
  const result: Point[][] = [];
  let current: Point[] | null = null;
  for (const match of path.matchAll(/([MCZ])([^MCZ]*)/gu)) {
    const values = match[2]!.trim().split(/\s+/u).filter(Boolean).map(Number);
    switch (match[1]) {
      case 'M':
        if (current) result.push(current);
        current = [{ x: values[0]!, y: values[1]! }];
        break;
      case 'C':
        current?.push({ x: values[4]!, y: values[5]! });
        break;
      case 'Z':
        if (current) result.push(current);
        current = null;
        break;
    }
  }
  if (current) result.push(current);
  return result;
}

function isConvex(points: Point[]): boolean {
  const turns: number[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index]!;
    const b = points[(index + 1) % points.length]!;
    const c = points[(index + 2) % points.length]!;
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) > 0.05) turns.push(Math.sign(cross));
  }
  return turns.length > 0 && turns.every((turn) => turn === turns[0]);
}

function center(points: Point[]): Point {
  return points.reduce((sum, point) => ({ x: sum.x + point.x / points.length, y: sum.y + point.y / points.length }), { x: 0, y: 0 });
}

function eyeAngleFromVertical(points: Point[]): number {
  const mean = center(points);
  let xx = 0;
  let yy = 0;
  let xy = 0;
  for (const point of points) {
    const x = point.x - mean.x;
    const y = point.y - mean.y;
    xx += x * x;
    yy += y * y;
    xy += x * y;
  }
  const majorAxis = Math.atan2(2 * xy, xx - yy) / 2;
  return Math.PI / 2 - Math.abs(majorAxis);
}

function bodyRadiusAt(points: Point[], angle: number): number {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  let best = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index]!;
    const b = points[(index + 1) % points.length]!;
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const denominator = dx * ey - dy * ex;
    if (Math.abs(denominator) < 1e-9) continue;
    const distance = (a.x * ey - a.y * ex) / denominator;
    const along = (a.x * dy - a.y * dx) / denominator;
    if (distance > best && along >= 0 && along <= 1) best = distance;
  }
  return best;
}

describe('agent avatar projected eyes', () => {
  it('renders two upright, forward-facing capsules on every shape', () => {
    const byShape = new Map<string, ReturnType<typeof makeAgentAvatarIdentity>>();
    for (let index = 0; index < 2_000 && byShape.size < AGENT_AVATAR_SHAPES.length; index += 1) {
      const identity = makeAgentAvatarIdentity(`avatar-${index}@test.local`);
      if (!byShape.has(identity.shape)) byShape.set(identity.shape, identity);
    }

    expect([...byShape.keys()].sort()).toEqual([...AGENT_AVATAR_SHAPES].sort());
    for (const identity of byShape.values()) {
      const body = contours(identity.body_path)[0]!;
      const eyes = contours(identity.eyes_path);
      expect(eyes).toHaveLength(2);
      eyes.forEach((eye, index) => {
        expect(isConvex(eye), `${identity.shape} eye ${index}`).toBe(true);
        expect(eyeAngleFromVertical(eye), `${identity.shape} eye ${index} angle`).toBeLessThan(12 * Math.PI / 180);
      });
      for (const point of eyes.flat()) {
        const angle = Math.atan2(point.y, point.x);
        expect(Math.hypot(point.x, point.y)).toBeLessThanOrEqual(bodyRadiusAt(body, angle) + 1.5);
      }

      const [left, right] = eyes.map(center).sort((a, b) => a.x - b.x);
      expect(left!.x).toBeLessThan(0);
      expect(right!.x).toBeGreaterThan(0);
      expect(Math.abs(left!.y - right!.y)).toBeLessThan(6);
      expect(Math.abs((left!.x + right!.x) / 2)).toBeLessThan(8);
    }
  });
});
