import { describe, expect, it } from 'vitest';
import { RAIL_BLOCKS, RAIL_SURFACES, railBlock } from '@starlings/contracts/rail-blocks';
import fixture from '../../../fixtures/rail-blocks.json';

describe('rail blocks', () => {
  it('equals fixtures/rail-blocks.json, the table the Swift mirror pins', () => {
    expect(fixture.blocks).toEqual(RAIL_BLOCKS);
    expect(Object.keys(fixture.blocks)).toEqual([...RAIL_SURFACES]);
  });

  it('keeps each fold key unique, prefixed by its surface, and named for its block', () => {
    const keys = new Set<string>();
    for (const surface of RAIL_SURFACES) {
      for (const block of RAIL_BLOCKS[surface]) {
        expect(block.key).toBe(`${surface}.${block.id}`);
        expect(keys.has(block.key)).toBe(false);
        keys.add(block.key);
      }
    }
  });

  it('finds a block by id and refuses an unknown one', () => {
    expect(railBlock('docs', 'library').hidesWhenEmpty).toBe(false);
    expect(railBlock('team', 'people').key).toBe('team.people');
    expect(() => railBlock('docs', 'nope')).toThrow();
  });
});
