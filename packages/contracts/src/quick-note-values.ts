/**
 * Where a Quick Note can go from the triage sheet, in the order
 * every client offers them, with its words: the segment, the caption over
 * the title field (none for a message), and the button. Zod-free, so the web
 * entry path can import it; the generator writes the Swift words of
 * `QuickNotePromotionKind` (`Sources/Generated/QuickNoteValuesRegistry.swift`).
 */
export const QUICK_NOTE_TRIAGE = [
  { kind: 'task', label: 'Task', titleCaption: 'Task title', action: 'Create task' },
  { kind: 'issue', label: 'Issue', titleCaption: 'Issue title', action: 'Create issue' },
  { kind: 'message', label: 'Message', titleCaption: null, action: 'Send message' },
  { kind: 'doc', label: 'Doc', titleCaption: 'Document title', action: 'Create document' },
] as const;

export type QuickNoteTriageKind = (typeof QUICK_NOTE_TRIAGE)[number]['kind'];
