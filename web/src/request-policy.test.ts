import { afterEach, describe, expect, it } from 'vitest';
import { SNAPSHOT_ROWS, SNAPSHOT_WRITES, snapshotsInvalidatedBy } from '@starlings/contracts/request-policy';
import { INVALIDATE_EVENT, invalidateFor, loadSnapshot, purgeSnapshots, saveSnapshot, snapshotMatches } from './snapshot-store';

describe('invalidateFor', () => {
  afterEach(() => purgeSnapshots());

  it('names the table\'s keys for the write, pages included, and nothing else', () => {
    const named = snapshotsInvalidatedBy('subject.write');
    expect(named).toEqual(['crm/subjects', 'crm/subject-counts']);
    expect(snapshotMatches('crm/subjects?kind=project&q=&status=', named)).toBe(true);
    expect(snapshotMatches('crm/subject-counts?kind=project&q=', named)).toBe(true);
    expect(snapshotMatches('crm/subject-state', named)).toBe(false);
    expect(snapshotMatches('crm/mine', named)).toBe(false);
  });

  it('keeps the storage copy as the next open\'s head start', () => {
    saveSnapshot('crm/mine', 4);
    invalidateFor('task.update');
    expect(loadSnapshot('crm/mine')?.value).toBe(4);
  });

  it('tells a list on screen which keys went', () => {
    const heard: string[][] = [];
    const listen = (event: Event) => heard.push((event as CustomEvent<string[]>).detail);
    window.addEventListener(INVALIDATE_EVENT, listen);
    try {
      for (const write of SNAPSHOT_WRITES) invalidateFor(write);
    } finally {
      window.removeEventListener(INVALIDATE_EVENT, listen);
    }
    expect(heard).toEqual(SNAPSHOT_WRITES.map((write) => snapshotsInvalidatedBy(write)));
  });

  it('names a key the store can match for every row a write clears', () => {
    for (const row of SNAPSHOT_ROWS) {
      for (const write of row.invalidatedBy) {
        expect(snapshotMatches(row.key, snapshotsInvalidatedBy(write)), `${write} -> ${row.key}`).toBe(true);
      }
    }
  });
});
