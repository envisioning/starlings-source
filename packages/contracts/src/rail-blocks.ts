/**
 * The blocks of Docs' and Team's rails, and Work Overview's sections, in order, decided once.
 *
 * Each block is a foldable section of a rail. Which blocks there are, in what
 * order, the key each one's fold is saved under, and whether it draws nothing
 * when it has no rows were written again on the Mac, in the web pages, and (for
 * order) on iOS, and they had drifted: the Mac hid an empty PEOPLE block where
 * the web drew a message, and the web hid an empty LIBRARY where the Mac kept
 * its header for an error. This table is that decision. It is rule input, not a
 * wire shape: Swift mirrors it (`Sources/RailBlocks.swift`) and
 * `fixtures/rail-blocks.json` pins the mirror.
 *
 * Titles, rows, menus and what an empty block says stay with each client.
 */

export const RAIL_SURFACES = ['docs', 'team', 'workOverview'] as const;
export type RailSurface = (typeof RAIL_SURFACES)[number];

export interface RailBlock {
  id: string;
  /** The key the fold is saved under. */
  key: string;
  /** Draws nothing at all while it has no rows. */
  hidesWhenEmpty: boolean;
}

export const RAIL_BLOCKS: Readonly<Record<RailSurface, readonly RailBlock[]>> = {
  docs: [
    { id: 'explore', key: 'docs.explore', hidesWhenEmpty: false },
    { id: 'work', key: 'docs.work', hidesWhenEmpty: false },
    { id: 'projects', key: 'docs.projects', hidesWhenEmpty: true },
    { id: 'leads', key: 'docs.leads', hidesWhenEmpty: true },
    { id: 'partners', key: 'docs.partners', hidesWhenEmpty: true },
    { id: 'folders', key: 'docs.folders', hidesWhenEmpty: true },
    // Kept while empty: a mirror that failed to load says so inside it.
    { id: 'library', key: 'docs.library', hidesWhenEmpty: false },
  ],
  team: [
    { id: 'you', key: 'team.you', hidesWhenEmpty: true },
    { id: 'groups', key: 'team.groups', hidesWhenEmpty: true },
    { id: 'people', key: 'team.people', hidesWhenEmpty: true },
    { id: 'agents', key: 'team.agents', hidesWhenEmpty: true },
  ],
  // Work's Overview: two columns, INBOX over Quick Notes and MINE over
  // UNOWNED. Every header folds (mz, 2026-10-01: section headers always do).
  workOverview: [
    { id: 'inbox', key: 'workOverview.inbox', hidesWhenEmpty: false },
    { id: 'quickNotes', key: 'workOverview.quickNotes', hidesWhenEmpty: true },
    { id: 'activity', key: 'workOverview.activity', hidesWhenEmpty: false },
    { id: 'mine', key: 'workOverview.mine', hidesWhenEmpty: false },
    { id: 'unowned', key: 'workOverview.unowned', hidesWhenEmpty: true },
  ],
};

/** One block of a rail; an unknown id is a bug in the caller, not a quiet default. */
export function railBlock(surface: RailSurface, id: string): RailBlock {
  const block = RAIL_BLOCKS[surface].find((entry) => entry.id === id);
  if (!block) throw new Error(`No ${surface} rail block named ${id}.`);
  return block;
}
