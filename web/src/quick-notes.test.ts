import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuickNote } from '@starlings/contracts';
import { ControlRequestError } from './config';
import { removeStoredWithPrefix } from './storage';

const apiFetch = vi.fn();
vi.mock('./api', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

import {
  createQuickNote,
  dropQuickNoteOutbox,
  flushQuickNoteOutbox,
  mergeQuickNotes,
  queueQuickNote,
  readQuickNoteOutbox,
  settleQuickNoteOutbox,
} from './quick-notes';

const OWNER = 'owner-a';

function serverNote(id: string, body: string, createdAt = '2026-10-11T10:00:00.000Z'): QuickNote {
  return { id, body, source: 'home', context: null, state: 'open', promotion: null, created_at: createdAt, updated_at: createdAt };
}

/** The Worker as meet#1093 has it: one note per client id, a repeat answers with the first. */
function answerLikeTheWorker(): Map<string, QuickNote> {
  const notes = new Map<string, QuickNote>();
  apiFetch.mockImplementation((_path: string, options: { body: { id: string; body: string } }) => {
    const { id, body } = options.body;
    if (!notes.has(id)) notes.set(id, serverNote(id, body));
    return Promise.resolve({ note: notes.get(id) });
  });
  return notes;
}

describe('quick notes outbox (meet#1093)', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    removeStoredWithPrefix('meet-quick-notes-outbox:');
  });

  it('sends a client id and capture time, and a retry with the same id makes one note', async () => {
    const notes = answerLikeTheWorker();
    const capture = { id: crypto.randomUUID(), captured_at: 1_760_000_000_000 };
    const first = await createQuickNote('Call Ada', 'work', null, capture);
    const again = await createQuickNote('Call Ada', 'work', null, capture);
    expect(again.id).toBe(first.id);
    expect(notes.size).toBe(1);
    expect(apiFetch.mock.calls[0][1].body).toMatchObject({ id: capture.id, captured_at: capture.captured_at, body: 'Call Ada' });
  });

  it('mints an id when the caller has none', async () => {
    answerLikeTheWorker();
    await createQuickNote('Hello');
    expect(apiFetch.mock.calls[0][1].body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof apiFetch.mock.calls[0][1].body.captured_at).toBe('number');
  });

  it('keeps a note in the outbox until it is sent, then drops it', async () => {
    const entry = queueQuickNote(OWNER, 'Buy milk');
    expect(readQuickNoteOutbox(OWNER)).toEqual([entry]);
    expect(readQuickNoteOutbox('owner-b')).toEqual([]);

    answerLikeTheWorker();
    const result = await flushQuickNoteOutbox(OWNER);
    expect(result.sent.map((note) => note.id)).toEqual([entry.id]);
    expect(readQuickNoteOutbox(OWNER)).toEqual([]);
  });

  it('keeps the note pending, and quiet, when the network fails; the retry reuses its id', async () => {
    const entry = queueQuickNote(OWNER, 'Offline thought');
    apiFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const offline = await flushQuickNoteOutbox(OWNER);
    expect(offline).toEqual({ sent: [], refused: [] });
    expect(readQuickNoteOutbox(OWNER)).toEqual([entry]);

    const notes = answerLikeTheWorker();
    await flushQuickNoteOutbox(OWNER);
    expect(apiFetch.mock.calls.map((call) => call[1].body.id)).toEqual([entry.id, entry.id]);
    expect(notes.size).toBe(1);
  });

  it('marks a note the Worker refuses and does not send it again', async () => {
    const entry = queueQuickNote(OWNER, 'Too odd');
    apiFetch.mockRejectedValueOnce(new ControlRequestError('That note is not valid.', 400));
    const result = await flushQuickNoteOutbox(OWNER);
    expect(result.refused).toEqual([{ ...entry, error: 'That note is not valid.' }]);
    expect(readQuickNoteOutbox(OWNER)).toEqual([{ ...entry, error: 'That note is not valid.' }]);

    await flushQuickNoteOutbox(OWNER);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    dropQuickNoteOutbox(OWNER, entry.id);
    expect(readQuickNoteOutbox(OWNER)).toEqual([]);
  });

  it('retries a server fault quietly', async () => {
    queueQuickNote(OWNER, 'Later');
    apiFetch.mockRejectedValueOnce(new ControlRequestError('Server error.', 503));
    const result = await flushQuickNoteOutbox(OWNER);
    expect(result.refused).toEqual([]);
    expect(readQuickNoteOutbox(OWNER)[0].error).toBeUndefined();
  });

  it('runs one pass at a time', async () => {
    queueQuickNote(OWNER, 'Once');
    answerLikeTheWorker();
    const [a, b] = await Promise.all([flushQuickNoteOutbox(OWNER), flushQuickNoteOutbox(OWNER)]);
    expect(a).toBe(b);
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('draws pending notes over the server list, once each, newest first', () => {
    const older = { id: 'p1', body: 'older', source: 'home' as const, captured_at: 1_000 };
    const newer = { id: 'p2', body: 'newer', source: 'home' as const, captured_at: 2_000 };
    const server = [serverNote('s1', 'server'), serverNote('p1', 'older')];
    const merged = mergeQuickNotes(server, [older, newer]);
    expect(merged.map((note) => note.id)).toEqual(['p2', 's1', 'p1']);
    expect(merged[0].created_at).toBe(new Date(2_000).toISOString());
  });

  it('settles outbox entries a refresh shows the Worker already has', () => {
    const sent = queueQuickNote(OWNER, 'answer lost');
    const unsent = queueQuickNote(OWNER, 'still here');
    expect(settleQuickNoteOutbox(OWNER, [serverNote(sent.id, 'answer lost')])).toEqual([unsent]);
    expect(readQuickNoteOutbox(OWNER)).toEqual([unsent]);
  });

  it('reads a corrupt outbox as empty', () => {
    localStorage.setItem('meet-quick-notes-outbox:' + OWNER, '{not json');
    expect(readQuickNoteOutbox(OWNER)).toEqual([]);
  });
});
