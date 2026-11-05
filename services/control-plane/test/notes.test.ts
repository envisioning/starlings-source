// The notes engine: Claude writes the note when the key is set, the small
// model when it is not, and a Claude failure never leaves a meeting without
// notes. See docs/AMBIENT_CAPTURE.md §3.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { summarize } from '../src/artifacts';
import { notesEngineState, parseActionItems, readNotesAnswer } from '../src/notes';
import type { ArtifactMaterial } from '../src/room-coordinator';

const segment = {
  id: '199485db-f7aa-4766-b8b6-186661024c96',
  meeting_id: '3f2a3a7e-2c4f-4a52-9c2e-9a7a1f6a3b10',
  speaker_id: 'rosa',
  speaker_name: 'Rosa',
  language: 'en' as const,
  starts_at_ms: 0,
  ends_at_ms: 4_000,
  text: 'We agreed to ship the notes upgrade on Friday. Felix owns the deploy.',
  is_final: true,
};

function material(overrides: Partial<ArtifactMaterial> = {}): ArtifactMaterial {
  return {
    roomSlug: 'rosa',
    meetingId: segment.meeting_id,
    startedAt: Date.parse('2026-09-16T09:00:00Z'),
    endedAt: Date.parse('2026-09-16T09:45:00Z'),
    title: null,
    summary: null,
    transcript: [segment],
    ...overrides,
  };
}

const CLAUDE_NOTE = `Title: Notes upgrade ship date

## Action items
- **Felix** — deploy the notes upgrade, by Friday.

## Decisions
- Ship the notes upgrade on Friday.

## Summary
Short meeting. One commitment.

## Open questions
- None.`;

function stubClaude(handler: (body: Record<string, unknown>) => Response) {
  const seen: Array<Record<string, unknown>> = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname !== 'api.anthropic.com') return new Response('unexpected', { status: 500 });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    seen.push(body);
    return handler(body);
  });
  return seen;
}

/** The answer comes through the write_notes tool now (meet#143): the note, and its action items as data. */
function claudeMessage(text: string, actionItems: unknown[] = [{ what: 'Ship the notes upgrade', who: 'Felix', by_when: 'Friday', quote: 'We agreed to ship the notes upgrade on Friday', at_ms: 0 }]): Response {
  return Response.json({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5',
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'write_notes', input: { notes_markdown: text, action_items: actionItems } }],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 120, output_tokens: 80, cache_read_input_tokens: 0, cache_creation_input_tokens: 100 },
  });
}

const workersAI = { run: async () => ({ response: 'Title: Small model\n\nSummary from the small model.' }) } as unknown as Env['AI'];

describe('notes engine', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('says which engine writes the notes', () => {
    expect(notesEngineState({ SUMMARY_MODE: 'ai', SUMMARY_MODEL: 'small', ANTHROPIC_API_KEY: 'sk-ant-x', NOTES_MODEL: 'claude-opus-5' } as unknown as Env))
      .toEqual({ engine: 'claude', model: 'claude-opus-5' });
    expect(notesEngineState({ SUMMARY_MODE: 'ai', SUMMARY_MODEL: 'small', ANTHROPIC_API_KEY: '' } as unknown as Env))
      .toEqual({ engine: 'workers-ai', model: 'small' });
    expect(notesEngineState({ SUMMARY_MODE: 'fallback', SUMMARY_MODEL: 'small' } as unknown as Env).engine).toBe('off');
  });

  it('writes the note with Claude when the key is set, action items first', async () => {
    const seen = stubClaude(() => claudeMessage(CLAUDE_NOTE));
    const result = await summarize(material(), {
      AI: workersAI, SUMMARY_MODE: 'ai', SUMMARY_MODEL: 'small', ANTHROPIC_API_KEY: 'sk-ant-test', NOTES_MODEL: 'claude-opus-5',
    } as unknown as Env);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.model).toBe('claude-opus-5');
    const user = (seen[0]!.messages as Array<{ content: string }>)[0]!.content;
    expect(user).toContain('] Rosa: We agreed to ship');
    expect(user).toContain('Participants: Rosa');
    expect(user).not.toContain('@');
    expect((seen[0]!.tool_choice as { name: string }).name).toBe('write_notes');
    expect(result.title).toBe('Notes upgrade ship date');
    expect(result.summary.startsWith('## Action items')).toBe(true);
    expect(result.summary).toContain('**Felix**');
    expect(result.actionItems).toEqual([{ what: 'Ship the notes upgrade', who: 'Felix', by_when: 'Friday', quote: 'We agreed to ship the notes upgrade on Friday', at_ms: 0, task_id: null }]);
  });

  it('keeps the rows the tool answered well and drops the rest; "Speaker" is nobody', () => {
    const answer = readNotesAnswer({
      notes_markdown: 'Title: T\n\n## Action items\n- x',
      action_items: [
        { what: 'Do the thing', who: 'Speaker', by_when: null, quote: null, at_ms: null },
        { what: '', who: null, by_when: null, quote: null, at_ms: null },
        { what: 'Half a row' },
      ],
    });
    expect(answer?.actionItems).toEqual([{ what: 'Do the thing', who: null, by_when: null, quote: null, at_ms: null, task_id: null }]);
    expect(readNotesAnswer({ action_items: [] })).toBeNull();
  });

  it('reads the follow-up when it holds its shape, and drops one past its caps (meet#756)', () => {
    const base = { notes_markdown: 'Title: T', action_items: [], decisions: [] };
    expect(readNotesAnswer({ ...base, follow_up: { subject: 'Next steps', body: 'Thanks, Ana.' } })?.followUp).toEqual({ subject: 'Next steps', body: 'Thanks, Ana.' });
    expect(readNotesAnswer({ ...base, follow_up: null })?.followUp).toBeNull();
    expect(readNotesAnswer(base)?.followUp).toBeNull();
    expect(readNotesAnswer({ ...base, follow_up: { subject: 'S', body: 'x'.repeat(1_501) } })?.followUp).toBeNull();
    expect(readNotesAnswer({ ...base, follow_up: { subject: '', body: 'B' } })?.followUp).toBeNull();
  });

  it('reads the small model’s Action items section into rows', () => {
    const rows = parseActionItems([
      'Title: Small',
      '',
      '## Action items',
      '- **Ana** — send the pricing deck, by Friday',
      '- **unassigned** — book the venue.',
      '- Confirm the date with legal',
      '- None.',
      '',
      '## Decisions',
      '- Not an action item',
    ].join('\n'));
    expect(rows).toEqual([
      { what: 'send the pricing deck', who: 'Ana', by_when: 'by Friday', quote: null, at_ms: null, task_id: null },
      { what: 'book the venue', who: null, by_when: null, quote: null, at_ms: null, task_id: null },
      { what: 'Confirm the date with legal', who: null, by_when: null, quote: null, at_ms: null, task_id: null },
    ]);
    expect(parseActionItems('## Summary\nNothing.')).toEqual([]);
  });

  it('falls back to the small model when Claude fails, and to the dated note when both do', async () => {
    stubClaude(() => Response.json({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, { status: 529 }));
    const small = await summarize(material(), {
      AI: workersAI, SUMMARY_MODE: 'ai', SUMMARY_MODEL: 'small', ANTHROPIC_API_KEY: 'sk-ant-test',
    } as unknown as Env);
    expect(small.title).toBe('Small model');

    const none = await summarize(material(), {
      AI: { run: async () => { throw new Error('AI unavailable'); } } as unknown as Env['AI'],
      SUMMARY_MODE: 'ai', SUMMARY_MODEL: 'small', ANTHROPIC_API_KEY: 'sk-ant-test',
    } as unknown as Env);
    expect(none.title).toMatch(/^Meeting notes — 2026-09-16$/u);
  });

  it('never calls Claude without a key', async () => {
    const seen = stubClaude(() => claudeMessage(CLAUDE_NOTE));
    const result = await summarize(material(), { AI: workersAI, SUMMARY_MODE: 'ai', SUMMARY_MODEL: 'small' } as unknown as Env);
    expect(seen).toHaveLength(0);
    expect(result.title).toBe('Small model');
  });
});
