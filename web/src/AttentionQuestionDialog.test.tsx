import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttentionRequest } from '@starlings/contracts/attention';
import { AttentionQuestionDialog } from './AttentionQuestionDialog';
import { readAttention, resolveAttention } from './attention';

vi.mock('./attention', async (original) => ({ ...await original<typeof import('./attention')>(), readAttention: vi.fn(), resolveAttention: vi.fn() }));
vi.mock('./owner-session', () => ({ useOwnerSession: () => ({ kind: 'owner', owner: { email: 'ada@example.com' } }) }));
const question = (changes: Partial<AttentionRequest> = {}): AttentionRequest => ({
  id: 'question:thread:message', kind: 'question', state: 'open', revision: 0,
  origin: { type: 'thread_question', thread_id: 'thread', message_id: 'message' },
  recipient_email: 'ada@example.com', asked_by_email: 'agent-vocab@example.com', asked_by: 'Vocab',
  prompt: 'Which direction?', context: 'Project Talk', options: [{ id: 'short', label: 'Keep it short' }, { id: 'examples', label: 'Use examples' }],
  selection_mode: 'single', allows_custom_answer: false, recommendation: null, default_by: null,
  subject: null, links: [], created_at: '2026-10-04T10:00:00Z', answer: null, ...changes,
});
const answered = (): AttentionRequest => question({ state: 'answered', revision: 1, answer: {
  option_ids: ['examples'], option_labels: ['Use examples'], custom_text: null, note: null,
  answered_by_email: 'ada@example.com', answered_at: '2026-10-04T10:01:00Z',
} });
const read = vi.mocked(readAttention);
const resolve = vi.mocked(resolveAttention);
beforeEach(() => { read.mockReset().mockResolvedValue(question()); resolve.mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
async function mount(initial = question()) {
  const onResolved = vi.fn();
  render(<AttentionQuestionDialog initial={initial} onResolved={onResolved} onClose={vi.fn()} />);
  await waitFor(() => expect((screen.getByRole('button', { name: 'Keep it short' }).closest('fieldset') as HTMLFieldSetElement).disabled).toBe(false));
  return onResolved;
}
describe('connected question detail', () => {
  it('names the asker and adopts a different winning answer from another surface', async () => {
    resolve.mockResolvedValue({ accepted: false, request: answered() });
    const onResolved = await mount();
    expect(screen.getByText('Asked by Vocab')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep it short' }));
    await waitFor(() => expect(onResolved).toHaveBeenCalledWith(answered()));
    expect(resolve).toHaveBeenCalledWith('question:thread:message', { action: 'answer', option_ids: ['short'] });
    expect(screen.queryByRole('button', { name: 'Use examples' })).toBeNull();
    expect(screen.getByText('Use examples')).toBeTruthy();
  });
  it('collects multiple choices and preserves the draft across an ordinary poll', async () => {
    const multi = question({ selection_mode: 'multiple' });
    read.mockResolvedValue(multi);
    await mount(multi);
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Keep it short' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    expect(screen.getByRole('button', { name: 'Keep it short' }).getAttribute('aria-pressed')).toBe('true');
    expect(resolve).not.toHaveBeenCalled();
    resolve.mockResolvedValue({ accepted: true, request: answered() });
    fireEvent.click(screen.getByRole('button', { name: 'Use examples' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit answer' }));
    expect(resolve).toHaveBeenCalledWith(multi.id, { action: 'answer', option_ids: ['short', 'examples'] });
    await act(async () => {});
  });
  it('dismisses explicitly without choosing an answer and retains the terminal result', async () => {
    const terminal = question({ state: 'dismissed', revision: 1 });
    resolve.mockResolvedValue({ accepted: true, request: terminal });
    const onResolved = await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(onResolved).toHaveBeenCalledWith(terminal));
    expect(resolve).toHaveBeenCalledWith(terminal.id, { action: 'dismiss', option_ids: [] });
    expect(screen.getByText('Dismissed')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Keep it short' })).toBeNull();
  });
  it('shows another recipient without answer controls', async () => {
    const other = question({ recipient_email: 'grace@example.com' });
    read.mockResolvedValue(other);
    render(<AttentionQuestionDialog initial={other} onResolved={vi.fn()} onClose={vi.fn()} />);
    await screen.findByText('Waiting on grace@example.com');
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Keep it short' })).toBeNull();
  });
  it('keeps controls disabled when the initial permission-checked refresh fails', async () => {
    read.mockRejectedValue(new Error('Source unavailable'));
    render(<AttentionQuestionDialog initial={question()} onResolved={vi.fn()} onClose={vi.fn()} />);
    await screen.findByText('Source unavailable');
    expect((screen.getByRole('button', { name: 'Keep it short' }).closest('fieldset') as HTMLFieldSetElement).disabled).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
  });
});
