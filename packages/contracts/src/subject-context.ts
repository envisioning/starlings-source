/**
 * The blocks of a subject's context, and their order, decided once.
 *
 * The Mac draws them in the Work inspector, the web in the subject's right
 * sidebar, iOS above the groups of Subject Overview. Which blocks a subject
 * kind shows, and in what order, used to be written again in each client, and
 * the copies drifted (a partner listed ABOUT before RELATIONSHIP on the Mac
 * only; web and iOS never drew an event's WHEN, WHERE, LINKS or WEBSITE).
 * This table is that decision. It is rule input, not a wire shape: Swift
 * mirrors it (`Sources/SubjectContextBlocks.swift`) and
 * `fixtures/subject-context.json` pins the mirror.
 *
 * The panes are tabs in the subject header (`subject-panes.ts`), so the
 * context has no VIEWS block.
 *
 * Labels, symbols, and what a block says stay with each client. A block with
 * nothing to say draws nothing: RELATIONSHIP without an organization, GOALS
 * without an open goal, EMAIL until the channel has been opened.
 */

import { SUBJECT_KINDS, type SubjectKind } from './subject-kinds';

export const SUBJECT_CONTEXT_BLOCKS = [
  'team',
  'agents',
  'when',
  'where',
  'links',
  'website',
  'work',
  'goals',
  'relationship',
  'about',
  'email',
] as const;

export type SubjectContextBlock = (typeof SUBJECT_CONTEXT_BLOCKS)[number];

export const SUBJECT_CONTEXT_CLIENTS = ['mac', 'ios', 'web'] as const;
export type SubjectContextClient = (typeof SUBJECT_CONTEXT_CLIENTS)[number];

/** Top to bottom, per subject kind. */
export const SUBJECT_CONTEXT_LAYOUT: Readonly<Record<SubjectKind, readonly SubjectContextBlock[]>> = {
  project: ['team', 'agents', 'work', 'goals', 'relationship', 'about', 'email'],
  lead: ['team', 'agents', 'work', 'relationship', 'about', 'email'],
  organization: ['team', 'agents', 'work', 'relationship', 'about', 'email'],
  event: ['team', 'agents', 'when', 'where', 'links', 'website', 'work', 'email'],
};

/**
 * Blocks a client draws elsewhere, by design. Every block not listed is drawn
 * by every client. GOALS is a foldable group of the Overview on every client,
 * beside the tasks, so no context repeats it.
 */
export const SUBJECT_CONTEXT_NOT_ON: Readonly<Partial<Record<SubjectContextBlock, readonly SubjectContextClient[]>>> = {
  goals: ['mac', 'ios', 'web'],
};

/** The blocks one client draws for one kind, in order. */
export function subjectContextBlocks(kind: SubjectKind, client: SubjectContextClient): SubjectContextBlock[] {
  return SUBJECT_CONTEXT_LAYOUT[kind].filter((block) => !SUBJECT_CONTEXT_NOT_ON[block]?.includes(client));
}

export { SUBJECT_KINDS as SUBJECT_CONTEXT_KINDS };
