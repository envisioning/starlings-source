import { describe, expect, it, vi } from 'vitest';
import { parseTaskCandidates, proposeTaskCandidates, taskCandidatesEnabled } from '../src/task-candidates';

const excerpt = '[00:10] ROSA: Okay, I\'ll send the pricing deck on Friday.';

describe('task candidate parsing', () => {
  it('reads a plain JSON array', () => {
    const candidates = parseTaskCandidates(JSON.stringify([{
      title: 'Send the pricing deck',
      quote: "I'll send the pricing deck on Friday",
      responsible: 'team',
      confidence: 90,
    }]));
    expect(candidates).toEqual([{
      title: 'Send the pricing deck',
      quote: "I'll send the pricing deck on Friday",
      responsible: 'team',
      confidence: 0.9,
    }]);
  });

  it('digs the array out of a fenced block with prose around it', () => {
    const raw = 'Here you go:\n```json\n[{"title":"Book the room","quote":"I\'ll book the room","responsible":"team","confidence":0.8}]\n```\nHope that helps.';
    const candidates = parseTaskCandidates(raw);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.title).toBe('Book the room');
    expect(candidates[0]?.confidence).toBeCloseTo(0.8);
  });

  it('drops entries that are not usable candidates', () => {
    const candidates = parseTaskCandidates(JSON.stringify([
      { title: '', quote: 'something', responsible: 'team', confidence: 90 },
      { title: 'No quote', responsible: 'team', confidence: 90 },
      'not an object',
      { title: 'Kept', quote: 'I said this', responsible: 'nonsense', confidence: 'high' },
    ]));
    expect(candidates).toEqual([{
      title: 'Kept',
      quote: 'I said this',
      responsible: 'unassigned',
      confidence: 0.5,
    }]);
  });

  it('returns nothing for an empty or unparseable answer', () => {
    expect(parseTaskCandidates('')).toEqual([]);
    expect(parseTaskCandidates('No commitments were made.')).toEqual([]);
    expect(parseTaskCandidates('[{oops}]')).toEqual([]);
  });
});

describe('task candidate proposal', () => {
  const model = '@cf/meta/llama-3.3-70b-instruct-fp8-fast' as const;

  it('stays inert without the binding or the mode', async () => {
    expect(taskCandidatesEnabled({ AI: {} as Ai, TASK_SUGGEST_MODE: 'off' } as unknown as Env)).toBe(false);
    expect(taskCandidatesEnabled({ TASK_SUGGEST_MODE: 'ai' } as unknown as Env)).toBe(false);

    const run = vi.fn();
    const candidates = await proposeTaskCandidates(
      { AI: { run } as unknown as Ai, TASK_SUGGEST_MODE: 'off', TASK_SUGGEST_MODEL: model } as unknown as Env,
      { excerpt },
    );
    expect(candidates).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it('sends the excerpt and the titles already tracked', async () => {
    const run = vi.fn(async () => ({
      response: '[{"title":"Send the pricing deck","quote":"I\'ll send the pricing deck on Friday","responsible":"team","confidence":88}]',
    }));
    const candidates = await proposeTaskCandidates(
      { AI: { run } as unknown as Ai, TASK_SUGGEST_MODE: 'ai', TASK_SUGGEST_MODEL: model } as unknown as Env,
      { excerpt, knownTitles: ['Book the workshop room'] },
    );
    expect(candidates).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(1);
    const [usedModel, payload] = run.mock.calls[0] as unknown as [string, { messages: { role: string; content: string }[] }];
    expect(usedModel).toBe(model);
    expect(payload.messages[1]?.content).toContain('pricing deck');
    expect(payload.messages[1]?.content).toContain('Book the workshop room');
  });
});
