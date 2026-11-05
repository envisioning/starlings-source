import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { WebCalendarAttendee } from './owner-agenda';

const roster = vi.hoisted(() => ({
  push: undefined as undefined | ((peers: { email: string; avatar_updated_at: number | null }[]) => void),
}));

vi.mock('./team-presence', () => ({
  subscribePeers: (subscriber: { onValue: (value: { peers: unknown[] }) => void }) => {
    roster.push = (peers) => subscriber.onValue({ peers });
    return () => { roster.push = undefined; };
  },
}));

const { AttendeeAvatar, AttendeeStack } = await import('./AttendeeAvatar');

function guest(name: string, status: WebCalendarAttendee['status'] = 'accepted'): WebCalendarAttendee {
  return { name, email: `${name.toLowerCase().replace(/\s/gu, '.')}@example.net`, status, optional: false, self: false } as WebCalendarAttendee;
}

describe('AttendeeStack', () => {
  it('shows every face up to five, then a +N that replaces the overflow', () => {
    const five = ['Ana One', 'Bo Two', 'Cy Three', 'Di Four', 'Ed Five'].map((name) => guest(name));
    const { container, rerender } = render(<AttendeeStack attendees={five} />);
    expect(container.textContent).not.toContain('+');
    rerender(<AttendeeStack attendees={[...five, guest('Fay Six'), guest('Gus Seven')]} />);
    // Four faces and "+3": seven guests, one slot spent on the count.
    expect(container.textContent).toContain('+3');
    expect(screen.getByRole('group').getAttribute('aria-label')).toContain('Gus Seven, Accepted');
  });

  it('badges declined and pending guests and leaves accepted ones bare', () => {
    const { container } = render(
      <AttendeeStack attendees={[guest('Ana One'), guest('Bo Two', 'declined'), guest('Cy Three', 'needsAction')]} />,
    );
    expect(container.querySelectorAll('svg')).toHaveLength(2);
  });
});

describe('AttendeeAvatar', () => {
  it('keeps the initials under a roster picture until it has loaded', async () => {
    const { container } = render(<AttendeeAvatar name="Ana One" email="Ana.One@example.net" member />);
    expect(container.textContent).toContain('AO');
    await act(async () => { roster.push?.([{ email: 'ana.one@example.net', avatar_updated_at: 42 }]); });
    // Radix renders the <img> only once it loads; the fallback stays until then.
    expect(container.textContent).toContain('AO');
  });
});
