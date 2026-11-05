/*
 * The editor dialog's frame, shared by the event editor and the Quick Note
 * dialog. Both are a shadcn `DialogContent` with a title row and
 * a close button. Plain class strings, so a caller adds its own width.
 */

/** Tall content scrolls inside the dialog, never the page under it. */
export const editorDialogClass = 'max-h-[85vh] overflow-y-auto overscroll-contain';

/** The title on the left, the close button on the right. */
export const editorHeaderClass = 'flex items-start justify-between gap-4';

export const editorTitleClass = 'm-0 text-[clamp(24px,4vw,36px)] leading-[1.05] text-foreground';

/** A bare group: no frame, no inset, the same top gap as the fields above. */
export const editorFieldsetClass = 'm-0 mt-[18px] min-w-0 border-0 p-0';
