import { describe, expect, it } from 'vitest';
import {
  SUBJECT_CONTEXT_BLOCKS,
  SUBJECT_CONTEXT_CLIENTS,
  SUBJECT_CONTEXT_LAYOUT,
  SUBJECT_CONTEXT_NOT_ON,
  subjectContextBlocks,
} from '@starlings/contracts/subject-context';
import { SUBJECT_KINDS } from '@starlings/contracts/subject-kinds';
import fixture from '../../../fixtures/subject-context.json';

describe('subject context blocks', () => {
  it('equals fixtures/subject-context.json, the table the Swift mirror pins', () => {
    expect(fixture.blocks).toEqual([...SUBJECT_CONTEXT_BLOCKS]);
    expect(fixture.layout).toEqual(SUBJECT_CONTEXT_LAYOUT);
    expect(fixture.notOn).toEqual(SUBJECT_CONTEXT_NOT_ON);
    for (const kind of SUBJECT_KINDS) {
      for (const client of SUBJECT_CONTEXT_CLIENTS) {
        expect(fixture.resolved[kind][client]).toEqual(subjectContextBlocks(kind, client));
      }
    }
  });

  it('lists every kind and only known blocks, each once', () => {
    expect(Object.keys(SUBJECT_CONTEXT_LAYOUT)).toEqual([...SUBJECT_KINDS]);
    for (const kind of SUBJECT_KINDS) {
      const blocks = SUBJECT_CONTEXT_LAYOUT[kind];
      expect(new Set(blocks).size).toBe(blocks.length);
      for (const block of blocks) expect(SUBJECT_CONTEXT_BLOCKS).toContain(block);
    }
  });

  it('puts the people first and the channel address last, on every kind', () => {
    for (const kind of SUBJECT_KINDS) {
      const blocks = SUBJECT_CONTEXT_LAYOUT[kind];
      expect(blocks.slice(0, 2)).toEqual(['team', 'agents']);
      expect(blocks[blocks.length - 1]).toBe('email');
    }
  });

  it('gives an event its own facts, and draws goals in no context: they are an Overview group (meet#1061)', () => {
    expect(SUBJECT_CONTEXT_LAYOUT.event).toEqual(expect.arrayContaining(['when', 'where', 'links', 'website']));
    expect(SUBJECT_CONTEXT_LAYOUT.event).not.toContain('goals');
    for (const client of ['mac', 'ios', 'web'] as const) {
      expect(subjectContextBlocks('project', client)).not.toContain('goals');
    }
  });
});
