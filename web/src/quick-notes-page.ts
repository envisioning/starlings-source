/**
 * Home's Quick Notes shows a page of notes: the leading notes whose rows fit
 * in a set height, by each row's own measured height. Short notes give a page
 * more rows, long notes fewer. The page is a share of the window's height, so
 * a taller window shows more. It never depends on where the card sits or on
 * the scroll position. See more unfolds one more page.
 * The same rule, with the same numbers, as `QuickNotePage` in
 * `Sources/QuickNotePage.swift`, which the Mac and the phone use.
 */
const QUICK_NOTES_MIN = 3;
/** One page, as a share of the window's height. */
const QUICK_NOTES_PAGE_SHARE = 0.4;

/**
 * How many leading notes `pages` pages hold. A note not measured yet counts
 * at the median of the notes that are, so a note just added at the top does
 * not shrink the page and re-decide on the next pass. With
 * nothing measured, the first note is shown so it can be, and the count
 * stops there. `floor` is how many the card keeps showing after an add: what
 * was on screen plus the new note, so adding never hides a visible note.
 */
export function quickNotesPageCount(
  notes: { id: string }[],
  heights: Record<string, number>,
  viewport: number,
  pages: number,
  gap: number,
  floor = 0,
): number {
  const budget = viewport * QUICK_NOTES_PAGE_SHARE * Math.max(1, pages);
  const known = notes.map((note) => heights[note.id]).filter((height): height is number => height !== undefined).sort((a, b) => a - b);
  const middle = Math.floor(known.length / 2);
  const estimate = known.length === 0 ? undefined : known.length % 2 === 0 ? ((known[middle - 1] ?? 0) + (known[middle] ?? 0)) / 2 : known[middle];
  const kept = Math.max(QUICK_NOTES_MIN, floor);
  let used = 0;
  let count = 0;
  for (const note of notes) {
    const height = heights[note.id] ?? estimate;
    if (height === undefined) return Math.min(notes.length, Math.max(kept, count + 1));
    used += height + (count === 0 ? 0 : gap);
    if (used > budget) break;
    count += 1;
  }
  return Math.min(notes.length, Math.max(kept, count));
}
