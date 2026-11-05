import type {
  QuickNote,
  QuickNoteContext,
  QuickNoteResponse,
  QuickNoteDeleteResponse,
  QuickNotesResponse,
  QuickNotePromotionKind,
  QuickNoteSource,
  CrmIssue,
  ThreadMessage,
  DocsCreateDocumentResponse,
} from '@starlings/contracts';
import { apiFetch } from './api';
import { ControlRequestError } from './config';
import { t } from './i18n';
import { readStored, removeStored, writeStored } from './storage';
import { invalidateFor, saveSnapshot } from './snapshot-store';

/** The last list read, for the NOTES card's first frame (docs/CACHING.md). */
export const QUICK_NOTES_SNAPSHOT = 'quick-notes';

/** The browser-side doorway for the owner-scoped Quick Notes inbox. */
export async function fetchQuickNotes(): Promise<QuickNote[]> {
  const response = await apiFetch<QuickNotesResponse>('/quick-notes', {
    fallbackError: t('Couldn’t load Quick Notes.'),
    noStore: true,
  });
  const notes = response.notes ?? [];
  saveSnapshot(QUICK_NOTES_SNAPSHOT, notes);
  return notes;
}

/**
 * The client names the note: `id` and `captured_at` go with the
 * body, so a retry after a lost answer finds the note the first try made
 * instead of making a second one. A caller that may retry mints the id once
 * and passes it every time; a caller that omits it gets a fresh one.
 */
export async function createQuickNote(
  body: string,
  source: QuickNoteSource = 'home',
  context: QuickNoteContext | null = null,
  capture: { id?: string; captured_at?: number } = {},
): Promise<QuickNote> {
  const id = capture.id ?? crypto.randomUUID();
  const capturedAt = capture.captured_at ?? Date.now();
  const response = await apiFetch<QuickNoteResponse>('/quick-notes', {
    method: 'POST',
    body: { body, source, context, id, captured_at: capturedAt },
    fallbackError: t('Couldn’t save that Quick Note.'),
  });
  invalidateFor('quickNote.write');
  return response.note;
}

/**
 * A note saved in this browser and not yet on the Worker.
 * `error` is set when the Worker refused it for good (a 4xx): it stays until
 * the person deletes it, and is not sent again.
 */
export interface PendingQuickNote {
  id: string;
  body: string;
  source: QuickNoteSource;
  captured_at: number;
  error?: string;
}

/**
 * One outbox per owner, so the next person on this browser neither sees nor
 * sends the last one's captures. It is not purged on sign-out: an expired
 * session also purges, and a capture must survive that.
 */
const OUTBOX_PREFIX = 'meet-quick-notes-outbox:';

function outboxKey(owner: string): string {
  return OUTBOX_PREFIX + owner;
}

function isPending(value: unknown): value is PendingQuickNote {
  const row = value as PendingQuickNote | null;
  return typeof row?.id === 'string'
    && typeof row.body === 'string'
    && typeof row.source === 'string'
    && typeof row.captured_at === 'number'
    && (row.error === undefined || typeof row.error === 'string');
}

/** The owner's unsent notes, oldest first. Storage that throws reads as empty. */
export function readQuickNoteOutbox(owner: string): PendingQuickNote[] {
  try {
    const raw = readStored(outboxKey(owner));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isPending) : [];
  } catch {
    return [];
  }
}

function writeQuickNoteOutbox(owner: string, entries: PendingQuickNote[]): void {
  try {
    if (entries.length === 0) removeStored(outboxKey(owner));
    else writeStored(outboxKey(owner), JSON.stringify(entries));
  } catch {
    // Storage blocked: `writeStored` already kept it in memory for this tab.
  }
}

/** Save first: the note is in the outbox before any request goes out. */
export function queueQuickNote(owner: string, body: string, source: QuickNoteSource = 'home'): PendingQuickNote {
  const entry: PendingQuickNote = { id: crypto.randomUUID(), body, source, captured_at: Date.now() };
  writeQuickNoteOutbox(owner, [...readQuickNoteOutbox(owner), entry]);
  return entry;
}

/** Delete an unsent note: it only ever lived here, so no request goes out. */
export function dropQuickNoteOutbox(owner: string, id: string): void {
  writeQuickNoteOutbox(owner, readQuickNoteOutbox(owner).filter((entry) => entry.id !== id));
}

function markQuickNoteOutbox(owner: string, id: string, error: string): void {
  writeQuickNoteOutbox(owner, readQuickNoteOutbox(owner).map((entry) => (
    entry.id === id ? { ...entry, error } : entry
  )));
}

/**
 * Whether a failed send is worth trying again later. No answer at all
 * (offline, DNS), a server fault, a timeout, a rate limit, or a session that
 * needs signing in again: yes. Any other 4xx will fail the same way again.
 */
export function isRetryableQuickNoteFailure(cause: unknown): boolean {
  if (!(cause instanceof ControlRequestError)) return true;
  return cause.status >= 500 || cause.status === 401 || cause.status === 408 || cause.status === 429;
}

const flushes = new Map<string, Promise<QuickNoteFlush>>();

export interface QuickNoteFlush {
  /** The Worker's notes for the entries that went through. */
  sent: QuickNote[];
  /** Entries the Worker refused for good on this pass. */
  refused: PendingQuickNote[];
}

/**
 * Send what the outbox holds, oldest first, each with its own id, so a
 * resend after a lost answer gets the note back instead of a copy. A
 * network failure stops the pass and leaves the rest pending. One pass per
 * owner at a time: online, focus and a refresh can all ask together.
 */
export function flushQuickNoteOutbox(owner: string): Promise<QuickNoteFlush> {
  const running = flushes.get(owner);
  if (running) return running;
  const pass = (async (): Promise<QuickNoteFlush> => {
    const result: QuickNoteFlush = { sent: [], refused: [] };
    for (const entry of readQuickNoteOutbox(owner)) {
      if (entry.error) continue;
      let note: QuickNote;
      try {
        note = await createQuickNote(entry.body, entry.source, null, { id: entry.id, captured_at: entry.captured_at });
      } catch (cause) {
        if (isRetryableQuickNoteFailure(cause)) break;
        const error = cause instanceof Error ? cause.message : t('Couldn’t save that Quick Note.');
        markQuickNoteOutbox(owner, entry.id, error);
        result.refused.push({ ...entry, error });
        continue;
      }
      // Deleted while its request was out: the Worker has it now, so the
      // delete the person asked for goes there too.
      if (!readQuickNoteOutbox(owner).some((row) => row.id === entry.id)) {
        await deleteQuickNote(note.id).catch(() => undefined);
        continue;
      }
      dropQuickNoteOutbox(owner, entry.id);
      result.sent.push(note);
    }
    return result;
  })().finally(() => flushes.delete(owner));
  flushes.set(owner, pass);
  return pass;
}

/**
 * A list read that already holds an outbox note means it went through and
 * only its answer was lost: it leaves the outbox. Returns what is left.
 */
export function settleQuickNoteOutbox(owner: string, server: QuickNote[]): PendingQuickNote[] {
  const known = new Set(server.map((note) => note.id));
  const entries = readQuickNoteOutbox(owner);
  const left = entries.filter((entry) => !known.has(entry.id));
  if (left.length !== entries.length) writeQuickNoteOutbox(owner, left);
  return left;
}

/** An unsent note in the shape the list draws. */
export function pendingQuickNote(entry: PendingQuickNote): QuickNote {
  const at = new Date(entry.captured_at).toISOString();
  return {
    id: entry.id,
    body: entry.body,
    source: entry.source,
    context: null,
    state: 'open',
    promotion: null,
    created_at: at,
    updated_at: at,
  };
}

/**
 * The list as drawn: unsent notes, newest first, over the Worker's list. A
 * pending note the Worker already has is drawn once, as the Worker's, so a
 * refresh never drops a pending row and never draws one twice.
 */
export function mergeQuickNotes(server: QuickNote[], pending: PendingQuickNote[]): QuickNote[] {
  const known = new Set(server.map((note) => note.id));
  const unsent = pending
    .filter((entry) => !known.has(entry.id))
    .sort((a, b) => b.captured_at - a.captured_at)
    .map(pendingQuickNote);
  return [...unsent, ...server];
}

/** Rewrite the body; the note keeps its place, state and filing. */
export async function updateQuickNote(id: string, body: string): Promise<QuickNote> {
  const response = await apiFetch<QuickNoteResponse>(`/quick-notes/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: { body },
    fallbackError: t('Couldn’t save that Quick Note.'),
  });
  invalidateFor('quickNote.write');
  return response.note;
}

export async function deleteQuickNote(id: string): Promise<void> {
  await apiFetch<QuickNoteDeleteResponse>(`/quick-notes/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    fallbackError: t('Couldn’t delete that Quick Note.'),
  });
  invalidateFor('quickNote.write');
}

export async function promoteQuickNote(
  id: string,
  kind: QuickNotePromotionKind,
  promotionID: string,
): Promise<QuickNote> {
  const response = await apiFetch<QuickNoteResponse>(`/quick-notes/${encodeURIComponent(id)}/promote`, {
    method: 'POST',
    body: { kind, id: promotionID },
    fallbackError: t('Couldn’t file that Quick Note.'),
  });
  invalidateFor('quickNote.write');
  return response.note;
}

export async function createQuickNoteIssue(
  projectID: string,
  title: string,
  body: string,
): Promise<CrmIssue> {
  const response = await apiFetch<{ issue: CrmIssue }>('/crm/issue', {
    method: 'POST',
    body: { project_id: projectID, title, body },
    fallbackError: t('Couldn’t file that issue.'),
  });
  return response.issue;
}

/** The note's text, verbatim, as a message in a thread the owner is in. */
export async function sendQuickNoteMessage(threadID: string, text: string): Promise<ThreadMessage> {
  const response = await apiFetch<{ message: ThreadMessage }>(`/threads/${encodeURIComponent(threadID)}/messages`, {
    method: 'POST',
    body: { text },
    fallbackError: t('Couldn’t send that note.'),
  });
  invalidateFor('thread.message');
  return response.message;
}

/** The note as a new document under /work, written through the Worker. */
export async function createQuickNoteDocument(title: string, bodyMd: string): Promise<DocsCreateDocumentResponse['document']> {
  const response = await apiFetch<DocsCreateDocumentResponse>('/docs/documents', {
    method: 'POST',
    body: { title, body_md: bodyMd, message: t('Filed from a Quick Note') },
    fallbackError: t('Couldn’t create that document.'),
  });
  return response.document;
}
