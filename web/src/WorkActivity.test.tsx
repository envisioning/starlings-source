import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboxRecentEntry } from '@starlings/contracts/inbox';
import { WorkActivity } from './WorkActivity';
import { removeStoredWithPrefix, StorageKeys } from './storage';

const subject: InboxRecentEntry['subject'] = { kind: 'project', id: 'project-a', title: 'Acme', group: 'clients' };
const row: InboxRecentEntry = { subject, id: 'event-a', title: 'Task completed', type: 'event', date: '2026-10-04T13:15:00Z', url: null };
beforeEach(() => {
  localStorage.clear();
  removeStoredWithPrefix(StorageKeys.railFold);
});

describe('Work activity', () => {
  it('opens by default, opens History through its subject, and folds accessibly', () => {
    const open = vi.fn();
    render(<WorkActivity entries={[row]} partial={[]} failed={false} onRetry={vi.fn()} onOpen={open} />);
    fireEvent.click(screen.getByRole('button', { name: /Task completed/ }));
    expect(open).toHaveBeenCalledWith(subject);
    const fold = screen.getByRole('button', { name: /Activity/ });
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(fold);
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Task completed')).toBeNull();
  });

  it('shows partial history with Retry instead of claiming there was no activity', () => {
    const retry = vi.fn();
    render(<WorkActivity entries={[]} partial={['Acme']} failed={false} onRetry={retry} onOpen={vi.fn()} />);
    expect(screen.queryByText('No activity this week.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it('distinguishes a quiet week from a loading feed', () => {
    const { rerender } = render(<WorkActivity entries={null} partial={[]} failed={false} onRetry={vi.fn()} onOpen={vi.fn()} />);
    expect(screen.queryByText('No activity this week.')).toBeNull();
    rerender(<WorkActivity entries={[]} partial={[]} failed={false} onRetry={vi.fn()} onOpen={vi.fn()} />);
    expect(screen.getByText('No activity this week.')).toBeTruthy();
  });
});
