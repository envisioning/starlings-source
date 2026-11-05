import { describe, expect, it } from 'vitest';
import type { ThreadMessage } from '@starlings/contracts';
import { elapsedLabel, transcriptRows } from './conversation-model';

const start = 1_760_000_000_000;
const agent = 'status@example.com';

function message(id: string, from: string, at: number, extra: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id, thread_id: 't1', sent_at: at, sender_email: from, sender_name: null,
    text: 'hello', is_mine: from === 'rosa@example.com', type: 'text', ...extra,
  };
}

describe('transcriptRows', () => {
  it('folds an agent’s consecutive steps into one trail, and leaves Meet’s events alone', () => {
    const rows = transcriptRows([
      message('q', 'rosa@example.com', start),
      message('s1', agent, start + 1_000, { type: 'event', text: 'Reading the board' }),
      message('s2', agent, start + 2_000, { type: 'event', text: 'Searching for Acme' }),
      message('a', agent, start + 3_000, { text: 'Two cards moved.' }),
      message('e', 'meet@org.example', start + 4_000, { type: 'event', text: 'Notes filed' }),
    ], null, new Set([agent]));
    expect(rows.map((row) => row.kind)).toEqual(['day', 'message', 'trail', 'message', 'event']);
    const trail = rows[2];
    if (trail.kind !== 'trail') throw new Error('expected a trail');
    expect(trail.steps.map((step) => step.id)).toEqual(['s1', 's2']);
  });

  it('folds nothing without the roster’s agents', () => {
    const rows = transcriptRows([
      message('s1', agent, start, { type: 'event' }),
      message('s2', agent, start + 1_000, { type: 'event' }),
    ], null);
    expect(rows.map((row) => row.kind)).toEqual(['day', 'event', 'event']);
  });

  it('starts a second trail across a day heading', () => {
    const rows = transcriptRows([
      message('s1', agent, start, { type: 'event' }),
      message('s2', agent, start + 86_400_000, { type: 'event' }),
    ], null, new Set([agent]));
    expect(rows.map((row) => row.kind)).toEqual(['day', 'trail', 'day', 'trail']);
  });

  it('starts a new turn when the member’s Claude takes over, so the via tag shows', () => {
    const rows = transcriptRows([
      message('a', 'ada@example.com', start),
      message('b', 'ada@example.com', start + 1_000),
      message('c', 'ada@example.com', start + 2_000, { via: 'claude.ai' }),
      message('d', 'ada@example.com', start + 3_000, { via: 'claude.ai' }),
    ], null);
    expect(rows.flatMap((row) => row.kind === 'message' ? [row.grouped] : [])).toEqual([false, true, false, true]);
  });
});

describe('elapsedLabel', () => {
  it('reads like a stopwatch', () => {
    expect(elapsedLabel(start, start + 7_000)).toBe('0:07');
    expect(elapsedLabel(start, start + 102_000)).toBe('1:42');
    expect(elapsedLabel(start, start + 725_000)).toBe('12:05');
    expect(elapsedLabel(start + 5_000, start)).toBe('0:00');
  });
});
