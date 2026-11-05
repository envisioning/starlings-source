import { describe, expect, it } from 'vitest';
import { meetEventsBatchSchema } from '../../packages/contracts/src/extension-events.ts';
import { createLifecycle, meetingCode } from '../src/lifecycle.js';
import { createRing, heartbeatDue, makeBatch, sameRoster } from '../src/batching.js';

describe('lifecycle', () => {
  it('fires join once, then leave once, with the clock it was given', () => {
    let t = 1000;
    const lc = createLifecycle(() => t);
    expect(lc.observe(false)).toBeNull();
    expect(lc.observe(true)).toEqual({ kind: 'call-started', atMs: 1000 });
    t = 2000;
    expect(lc.observe(true)).toBeNull();
    expect(lc.observe(false)).toEqual({ kind: 'call-ended', atMs: 2000, reason: 'left' });
    expect(lc.observe(false)).toBeNull();
  });

  it('pagehide ends an in-call page and is silent otherwise', () => {
    const lc = createLifecycle(() => 5);
    expect(lc.pagehide()).toBeNull();
    lc.observe(true);
    expect(lc.pagehide()).toEqual({ kind: 'call-ended', atMs: 5, reason: 'pagehide' });
    expect(lc.state).toBe('idle');
  });

  it('reads the meeting code and ignores the landing page', () => {
    expect(meetingCode('/abc-defg-hij')).toBe('abc-defg-hij');
    expect(meetingCode('/abc-defg-hij/')).toBe('abc-defg-hij');
    expect(meetingCode('/')).toBeNull();
    expect(meetingCode('/landing')).toBeNull();
  });
});

describe('batching', () => {
  it('builds a v2 batch with optional title and lifecycle', () => {
    const batch = makeBatch({ meetingCode: 'abc-defg-hij', roster: [{ name: 'Ana', speaking: true }], now: 7 });
    expect(batch).toEqual({ schemaVersion: 2, meetingCode: 'abc-defg-hij', capturedAtMs: 7, roster: [{ name: 'Ana', speaking: true }] });
    expect(makeBatch({ meetingCode: 'x', roster: [], title: 'Kickoff', lifecycle: { kind: 'heartbeat', atMs: 1 }, now: 2 }).title).toBe('Kickoff');
  });

  it('heartbeat is due after a minute of silence', () => {
    expect(heartbeatDue(0, 59_999)).toBe(false);
    expect(heartbeatDue(0, 60_000)).toBe(true);
  });

  it('the ring keeps the newest and drains oldest first', () => {
    const ring = createRing(2);
    ring.push(1); ring.push(2); ring.push(3);
    expect(ring.size).toBe(2);
    expect(ring.drain()).toEqual([2, 3]);
    expect(ring.size).toBe(0);
  });

  it('compares rosters by name and speaking state', () => {
    expect(sameRoster([{ name: 'A' }], [{ name: 'A', speaking: false }])).toBe(true);
    expect(sameRoster([{ name: 'A' }], [{ name: 'A', speaking: true }])).toBe(false);
    expect(sameRoster([{ name: 'A' }], [])).toBe(false);
  });

  it('validates an extension batch and leaves future lifecycle kinds readable', () => {
    const batch = makeBatch({
      meetingCode: 'abc-defg-hij',
      roster: [{ name: 'Ana', speaking: true }],
      lifecycle: { kind: 'heartbeat', atMs: 9 },
      now: 10,
    });
    expect(meetEventsBatchSchema.parse(batch)).toEqual(batch);
  });
});
