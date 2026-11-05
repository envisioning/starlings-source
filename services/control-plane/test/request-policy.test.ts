import { describe, expect, it } from 'vitest';
import {
  REQUEST_RETRY,
  REQUEST_TIMEOUT_SECONDS,
  SNAPSHOT_ROWS,
  SNAPSHOT_WRITES,
  snapshotsInvalidatedBy,
} from '@starlings/contracts/request-policy';
import fixture from '../../../fixtures/request-policy.json';

describe('request policy', () => {
  it('equals fixtures/request-policy.json, the table the Swift clients are generated from', () => {
    expect(fixture.version).toBe(1);
    expect(fixture.timeoutSeconds).toBe(REQUEST_TIMEOUT_SECONDS);
    expect(fixture.retry).toEqual(REQUEST_RETRY);
    expect(fixture.snapshots).toEqual(JSON.parse(JSON.stringify(SNAPSHOT_ROWS)));
    expect(fixture.writes).toEqual(Object.fromEntries(SNAPSHOT_WRITES.map((write) => [write, snapshotsInvalidatedBy(write)])));
  });

  it('retries a request only when sending it twice cannot do harm', () => {
    expect([...REQUEST_RETRY.methods]).not.toContain('POST');
    expect([...REQUEST_RETRY.methods]).not.toContain('DELETE');
    expect(REQUEST_RETRY.extraAttempts).toBe(1);
  });

  it('gives every row a unique key and a unique Swift name', () => {
    expect(new Set(SNAPSHOT_ROWS.map((row) => row.key)).size).toBe(SNAPSHOT_ROWS.length);
    expect(new Set(SNAPSHOT_ROWS.map((row) => row.name)).size).toBe(SNAPSHOT_ROWS.length);
  });

  it('clears something for every write, and every write that a row names exists', () => {
    for (const write of SNAPSHOT_WRITES) expect(snapshotsInvalidatedBy(write), write).not.toEqual([]);
    for (const row of SNAPSHOT_ROWS) {
      for (const write of row.invalidatedBy) expect(SNAPSHOT_WRITES, `${row.key} names ${write}`).toContain(write);
    }
  });

  it('takes a write that changes a task out of Mine, the task pages and the Inbox, on every client', () => {
    expect(snapshotsInvalidatedBy('task.update')).toEqual(['crm/mine', 'crm/inbox', 'crm/tasks']);
    expect(snapshotsInvalidatedBy('task.create')).toEqual(['crm/mine', 'crm/tasks']);
  });

  it('differs from what the clients cleared before, where they disagreed', () => {
    // Mac cleared one list for a favourite, the phone two.
    expect(snapshotsInvalidatedBy('favorite.set')).toEqual(['crm/starred', 'crm/favorites']);
    // Mac cleared Mine for an issue, the phone Mine and the issue pages.
    expect(snapshotsInvalidatedBy('issue.write')).toEqual(['crm/mine', 'crm/issues']);
    // Neither cleared the conversation list when a subject's channel was opened (Mac) or when a thread was read, muted or archived (Mac, iOS).
    expect(snapshotsInvalidatedBy('thread.open')).toEqual(['threads']);
    expect(snapshotsInvalidatedBy('thread.state')).toEqual(['threads']);
    // The badges follow the pages.
    expect(snapshotsInvalidatedBy('subject.write')).toEqual(['crm/subjects', 'crm/subject-counts']);
  });
});
