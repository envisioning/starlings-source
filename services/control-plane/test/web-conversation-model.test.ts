import { describe, expect, it } from 'vitest';
import type { ThreadMessage, ThreadSummary } from '@starlings/contracts';
import { dayTitle, mergeMessages, threadHref, threadTitle, transcriptRows } from '../../../web/src/conversation-model';

const message = (id: string, sent_at: number, text = id): ThreadMessage => ({
  id, sent_at, text, thread_id: 'thread', sender_email: 'ada@example.com', sender_name: 'Ada', is_mine: false, type: 'text',
});
describe('Browser conversation history', () => {
  it('keeps older loaded history when a poll overlaps a just-sent message', () => {
    const history = [message('old', 1), message('new', 3)];
    expect(mergeMessages(history, [message('middle', 2), message('new', 3)]).map(row => row.id))
      .toEqual(['old', 'middle', 'new']);
  });
  it('orders equal timestamps consistently and replaces repeated IDs', () => {
    expect(mergeMessages([message('b', 1)], [message('a', 1), message('b', 1, 'updated')]))
      .toEqual([message('a', 1), message('b', 1, 'updated')]);
  });
  it.each(['project', 'lead', 'team', 'dm'] as const)('routes %s unread to its own workspace destination', kind => {
    const thread = { id: 'opaque/id', kind, title: kind === 'project' ? 'Project A' : null,
      peer_email: 'ada@example.com', peer_name: null } as ThreadSummary;
    // A permalink (meet#581); a subject thread with no subject id has none, and goes to Work.
    expect(threadHref(thread)).toBe(kind === 'project' || kind === 'lead' ? '/work' : '/team/thread/opaque%2Fid');
    expect(threadTitle(thread)).toBe(kind === 'project' ? 'Project A' : kind === 'team' ? 'Everyone' : 'ada');
  });
  it('routes a subject thread to its subject\'s Talk', () => {
    const thread = { id: 't1', kind: 'project', parent_id: 'p1', title: 'Project A', peer_email: null, peer_name: null } as ThreadSummary;
    expect(threadHref(thread)).toBe('/work/project/p1?pane=talk');
  });
  it('names a private group after the people in it', () => {
    // A group has no title, so the roster is the title — first names, because
    // three addresses in a list row is a line of ellipsis. The Worker orders
    // the roster, so every member reads the same name for it.
    const thread = { id: 'opaque/id', kind: 'dm', title: null,
      peer_email: 'ada@example.com', peer_name: 'Ada Lovelace',
      peers: [
        { email: 'ada@example.com', name: 'Ada Lovelace' },
        { email: 'kim@example.com', name: null },
      ] } as ThreadSummary;
    expect(threadTitle(thread)).toBe('Ada, kim');
  });

  it('keeps the full display name for a one-person conversation', () => {
    const thread = { id: 'opaque/id', kind: 'dm', title: null,
      peer_email: 'factory-app@example.com', peer_name: 'Factory: App' } as ThreadSummary;
    expect(threadTitle(thread)).toBe('Factory: App');
  });
});

/**
 * The same cases `Tests/ThreadTranscriptTests.swift` asserts, against the
 * TypeScript twin. Two implementations of one set of rules is a decision, and
 * the only thing that keeps it honest is testing both against the same table.
 */
describe('Browser transcript arrangement', () => {
  const start = 1_760_000_000_000;
  const at = (id: string, offsetMs: number, extra: Partial<ThreadMessage> = {}): ThreadMessage => ({
    id,
    sent_at: start + offsetMs,
    text: 'hello',
    thread_id: 'thread',
    sender_email: 'ada@example.com',
    sender_name: 'Ada',
    is_mine: false,
    type: 'text',
    ...extra,
  });

  it('groups consecutive messages from one person', () => {
    const rows = transcriptRows([at('a', 0), at('b', 60_000)], null);
    expect(rows.map(row => row.kind)).toEqual(['day', 'message', 'message']);
    expect(rows[1]).toMatchObject({ grouped: false });
    expect(rows[2]).toMatchObject({ grouped: true });
  });

  it('breaks the group past the window and on a different sender', () => {
    expect(transcriptRows([at('a', 0), at('b', 600_000)], null)[2]).toMatchObject({ grouped: false });
    expect(transcriptRows(
      [at('a', 0), at('b', 1_000, { sender_email: 'rosa@example.com' })],
      null,
    )[2]).toMatchObject({ grouped: false });
  });

  it('starts a new day and never groups across it', () => {
    const rows = transcriptRows([at('a', 0), at('b', 26 * 3_600_000)], null);
    expect(rows.map(row => row.kind)).toEqual(['day', 'message', 'day', 'message']);
    expect(rows[3]).toMatchObject({ grouped: false });
  });

  it('does not emit a second day heading after an event line', () => {
    const rows = transcriptRows(
      [at('a', 0), at('e', 10_000, { type: 'event', sender_email: 'meet@org.example' }), at('b', 20_000)],
      null,
    );
    expect(rows.map(row => row.kind)).toEqual(['day', 'message', 'event', 'message']);
    // The same person, ten seconds later — but not the same breath.
    expect(rows[3]).toMatchObject({ grouped: false });
  });

  it('marks where the reader left off, once', () => {
    const rows = transcriptRows([at('a', 0), at('b', 60_000), at('c', 120_000)], start - 1);
    expect(rows.filter(row => row.kind === 'unread')).toHaveLength(1);
    expect(rows[1]).toMatchObject({ kind: 'unread' });
  });

  it('never marks your own message as the thing you missed', () => {
    const rows = transcriptRows([at('a', 0, { is_mine: true })], start - 1);
    expect(rows.some(row => row.kind === 'unread')).toBe(false);
  });

  it('breaks the group either side of a withdrawn message', () => {
    const rows = transcriptRows(
      [at('a', 0), at('b', 10_000, { deleted_at: start }), at('c', 20_000)],
      null,
    );
    expect(rows[2]).toMatchObject({ grouped: false });
    expect(rows[3]).toMatchObject({ grouped: false });
  });

  it('names days the way somebody reads them', () => {
    const now = start;
    expect(dayTitle(now, now)).toBe('Today');
    expect(dayTitle(now - 86_400_000, now)).toBe('Yesterday');
    expect(dayTitle(now - 30 * 86_400_000, now)).not.toBe('Yesterday');
  });
});
