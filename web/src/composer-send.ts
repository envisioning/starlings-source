/**
 * The send button of a message or note field: a round accent button inside the
 * pill, on its right edge, bottom-aligned as the field grows. The field sits in
 * a `relative` wrapper and takes `composerFieldPadding`, so the button can
 * never wrap onto its own line at a narrow width.
 */
export const composerSendClass = 'absolute right-[3px] bottom-[3px] size-[30px] rounded-full';
export const composerFieldPadding = 'pr-11';

/** The message field itself: a pill on the muted fill that grows with the draft, with room for the send button. */
export const composerFieldClass = `max-h-48 min-h-9 w-full min-w-0 resize-none rounded-[1.125rem] bg-muted py-2 pl-3.5 leading-5 [scrollbar-width:none] dark:bg-muted [&::-webkit-scrollbar]:hidden ${composerFieldPadding}`;
