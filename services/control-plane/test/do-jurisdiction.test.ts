import { afterEach, describe, expect, it } from 'vitest';
import { forgetMoves, jurisdictionSetting, jurisdictionStub, quickNotesStub, roomStub } from '../src/do-jurisdiction';
import { threadStub } from '../src/threads';

// meet#312, #1164, docs/ROOM_JURISDICTION_PLAN.md steps 1 and 2.

const sources = import.meta.glob(['../src/*.ts', '../src/routes/*.ts'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

describe('every room and Quick Notes lookup goes through the jurisdiction stubs', () => {
  it('finds no direct getByName on ROOMS or QUICK_NOTES outside do-jurisdiction.ts', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(40);
    const direct = Object.entries(sources)
      .filter(([file]) => !file.endsWith('/do-jurisdiction.ts'))
      .filter(([, text]) => /\b(ROOMS|QUICK_NOTES)\.(getByName|idFromName)\(/u.test(text))
      .map(([file]) => file);
    expect(direct).toEqual([]);
  });
});

// A namespace that records which path a lookup took.
function fakeNamespace(options: { jurisdictionThrows?: boolean } = {}) {
  const calls: string[] = [];
  const stub = (path: string, name: string) => ({ path, name }) as unknown as DurableObjectStub<undefined>;
  const namespace = {
    getByName: (name: string) => { calls.push(`plain:${name}`); return stub('plain', name); },
    // The unpinned path a us workspace takes: a location hint, no jurisdiction.
    idFromName: (name: string) => ({ name }),
    get: (id: { name: string }, options?: { locationHint?: string }) => {
      calls.push(`hint-${options?.locationHint ?? 'none'}:${id.name}`);
      return stub('hint', id.name);
    },
    jurisdiction: (where: string) => {
      if (options.jurisdictionThrows) throw new Error('jurisdictions are not supported');
      return {
        idFromName: (name: string) => ({ where, name }),
        get: (id: { where: string; name: string }) => { calls.push(`${id.where}:${id.name}`); return stub(id.where, id.name); },
      };
    },
  } as unknown as DurableObjectNamespace<undefined>;
  return { namespace, calls };
}

// A D1 binding that answers the move table with these rows, and counts reads.
function fakeMoves(rows: Array<{ namespace: string; name: string }>) {
  const reads = { count: 0 };
  const USAGE = {
    prepare: () => ({ all: async () => { reads.count += 1; return { results: rows }; } }),
  } as unknown as D1Database;
  return { USAGE, reads };
}

describe('roomStub and quickNotesStub follow DO_JURISDICTION', () => {
  afterEach(() => forgetMoves());

  it('takes the EU path for a workspace set to eu, without reading the move table', async () => {
    const rooms = fakeNamespace();
    const notes = fakeNamespace();
    const moves = fakeMoves([]);
    const env = { ROOMS: rooms.namespace, QUICK_NOTES: notes.namespace, USAGE: moves.USAGE, ENVIRONMENT: 'production', DO_JURISDICTION: 'eu' } as unknown as Env;
    await roomStub(env, 'hq');
    await quickNotesStub(env, 'sub-1');
    expect(rooms.calls).toEqual(['eu:hq']);
    expect(notes.calls).toEqual(['eu:owner:sub-1']);
    expect(moves.reads.count).toBe(0);
  });

  it('keeps the plain lookup for a legacy workspace, except for an object that moved', async () => {
    const rooms = fakeNamespace();
    const notes = fakeNamespace();
    const moves = fakeMoves([{ namespace: 'rooms', name: 'moved' }, { namespace: 'quick_notes', name: 'sub-3' }]);
    const env = { ROOMS: rooms.namespace, QUICK_NOTES: notes.namespace, USAGE: moves.USAGE, ENVIRONMENT: 'production', DO_JURISDICTION: 'legacy' } as unknown as Env;
    await roomStub(env, 'rosa');
    await roomStub(env, 'moved');
    await quickNotesStub(env, 'sub-2');
    await quickNotesStub(env, 'sub-3');
    expect(rooms.calls).toEqual(['plain:rosa', 'eu:moved']);
    expect(notes.calls).toEqual(['plain:owner:sub-2', 'eu:owner:sub-3']);
    // One read serves the isolate for a minute.
    expect(moves.reads.count).toBe(1);
  });

  it('places a us workspace\'s objects with the location hint enam, without a jurisdiction or the move table', async () => {
    const rooms = fakeNamespace();
    const notes = fakeNamespace();
    const moves = fakeMoves([{ namespace: 'rooms', name: 'hq' }]);
    const env = { ROOMS: rooms.namespace, QUICK_NOTES: notes.namespace, USAGE: moves.USAGE, ENVIRONMENT: 'production', DO_JURISDICTION: 'us' } as unknown as Env;
    await roomStub(env, 'hq');
    await quickNotesStub(env, 'sub-1');
    expect(rooms.calls).toEqual(['hint-enam:hq']);
    expect(notes.calls).toEqual(['hint-enam:owner:sub-1']);
    expect(moves.reads.count).toBe(0);
  });

  it('names a second object for a moved one off production, so a local move is not onto itself', async () => {
    const rooms = fakeNamespace({ jurisdictionThrows: true });
    const moves = fakeMoves([{ namespace: 'rooms', name: 'moved' }]);
    const env = { ROOMS: rooms.namespace, USAGE: moves.USAGE, ENVIRONMENT: 'development', DO_JURISDICTION: 'legacy' } as unknown as Env;
    await roomStub(env, 'moved');
    expect(rooms.calls).toEqual(['plain:eu:moved']);
  });
});

describe('threads follow the data region (#1164)', () => {
  // Envisioning (legacy) and every eu workspace keep the EU thread ids they have today.
  it.each([
    ['eu', 'eu:t-1'],
    ['legacy', 'eu:t-1'],
    ['us', 'hint-enam:t-1'],
  ])('a %s workspace names %s', (setting, expected) => {
    const threads = fakeNamespace();
    threadStub({ THREADS: threads.namespace, ENVIRONMENT: 'production', DO_JURISDICTION: setting } as unknown as Env, 't-1');
    expect(threads.calls).toEqual([expected]);
  });
});

describe('DO_JURISDICTION fails closed in production', () => {
  it('refuses an unknown value in production', () => {
    expect(() => jurisdictionSetting({ ENVIRONMENT: 'production', DO_JURISDICTION: 'asia' } as unknown as Env)).toThrow(/eu, us or legacy/u);
    expect(() => jurisdictionSetting({ ENVIRONMENT: 'production' } as unknown as Env)).toThrow(/eu, us or legacy/u);
  });

  it('reads an unset or unknown value as legacy off production', () => {
    expect(jurisdictionSetting({ ENVIRONMENT: 'development' } as unknown as Env)).toBe('legacy');
  });
});

describe('jurisdictionStub never unpins silently in production', () => {
  it('throws in production when jurisdictions are not available', () => {
    const { namespace } = fakeNamespace({ jurisdictionThrows: true });
    expect(() => jurisdictionStub(namespace, 'hq', 'eu', { ENVIRONMENT: 'production' } as unknown as Env)).toThrow(/not supported/u);
  });

  it('never asks for a us jurisdiction, which Cloudflare does not have', () => {
    const { namespace, calls } = fakeNamespace({ jurisdictionThrows: true });
    jurisdictionStub(namespace, 'hq', 'us', { ENVIRONMENT: 'production' } as unknown as Env);
    expect(calls).toEqual(['hint-enam:hq']);
  });

  it('falls back to the plain lookup outside production (workerd, local, tests)', () => {
    const { namespace, calls } = fakeNamespace({ jurisdictionThrows: true });
    jurisdictionStub(namespace, 'hq', 'eu', { ENVIRONMENT: 'development' } as unknown as Env);
    expect(calls).toEqual(['plain:hq']);
  });
});
