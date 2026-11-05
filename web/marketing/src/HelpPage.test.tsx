// /help renders the product docs from the build-time module: the index
// lists every page, a page rewrites its sibling links onto the site, and
// a slug nobody wrote gets a way back (meet#269).
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HelpPage } from './HelpPage';

const link = (container: HTMLElement, href: string) => container.querySelector(`a[href="${href}"]`);

describe('HelpPage', () => {
  it('lists every surface and how-to on the index', () => {
    const { container } = render(<HelpPage slug={null} />);
    expect(link(container, '/help/surfaces/home')?.textContent).toBe('Home');
    expect(link(container, '/help/howto/join-a-room')?.textContent).toBe('Join a room');
    expect(link(container, '/llms.txt')).not.toBeNull();
  });

  it('renders a page with its sibling links on the site and the registry rows', () => {
    const { container } = render(<HelpPage slug="surfaces/home" />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Home');
    expect(link(container, '/help/surfaces/team')?.textContent).toBe('team');
    expect(screen.getByText('Where it works')).toBeTruthy();
    expect(screen.getByText('now (MCP)')).toBeTruthy();
  });

  it('says so for a slug that is not a page', () => {
    const { container } = render(<HelpPage slug="surfaces/nothing" />);
    const links = [...container.querySelectorAll('a[href="/help"]')].map((a) => a.textContent);
    expect(links).toContain('Back to Help');
  });
});
