import { describe, expect, it } from 'vitest';
import { quickNotesPageCount } from './quick-notes-page';

/* meet#1024: adding a note never shrinks the visible list. */
describe('quickNotesPageCount', () => {
  const notes = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `n${index}` }));
  const measured = (count: number, height: number) => Object.fromEntries(notes(count).map((note) => [note.id, height]));

  it('counts an unmeasured note at the median, instead of stopping the page at it', () => {
    // 1000px window: a 400px page of 60px rows, 8px gap, holds 6.
    const heights = measured(8, 60);
    expect(quickNotesPageCount(notes(8), heights, 1000, 1, 8)).toBe(6);
    const added = [{ id: 'new' }, ...notes(8)];
    expect(quickNotesPageCount(added, heights, 1000, 1, 8)).toBe(6);
  });

  it('keeps what was showing plus the new note once a floor is set', () => {
    const heights = measured(8, 60);
    const added = [{ id: 'new' }, ...notes(8)];
    expect(quickNotesPageCount(added, heights, 1000, 1, 8, 7)).toBe(7);
  });

  it('with nothing measured, shows the floor and stops', () => {
    expect(quickNotesPageCount(notes(8), {}, 1000, 1, 8)).toBe(3);
  });
});
