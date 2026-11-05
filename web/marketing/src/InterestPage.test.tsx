// /interest validates on submit: the button stays live, each missing answer
// is marked under its field, and one line beside the button counts them.
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { InterestPage } from './InterestPage';

vi.mock('./SiteChrome', () => ({ AppShell: ({ children }: { children: ReactNode }) => <>{children}</>, Arrow: () => null, Meter: () => null }));

describe('InterestPage', () => {
  it('marks every missing answer on submit and sends nothing', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    Element.prototype.scrollIntoView = vi.fn();
    render(<InterestPage />);
    const submit = screen.getByRole('button', { name: 'Request early access' });
    expect(submit.hasAttribute('disabled')).toBe(false);

    fireEvent.click(submit);

    expect(screen.getByText('Answer the 15 questions marked.')).toBeTruthy();
    expect(screen.getAllByText('Fill this in.')).toHaveLength(3);
    expect(screen.getAllByText('Pick one.')).toHaveLength(12);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(document.activeElement?.closest('[data-field="name"]')).not.toBeNull();
    expect(document.activeElement?.getAttribute('aria-invalid')).toBe('true');
    fetchSpy.mockRestore();
  });
});
