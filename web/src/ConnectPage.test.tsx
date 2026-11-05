import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectPage } from './ConnectPage';

vi.mock('./owner-session', () => ({
  wasMember: () => true,
  useOwnerSession: () => ({ kind: 'loading' }),
}));

describe('ConnectPage without a client id', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/connect');
  });

  it('explains why Claude opened the page and links to the pairing guide', () => {
    render(<ConnectPage />);

    expect(screen.getByText('Claude opens this page when it pairs with Starlings.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'How to connect Claude' }).getAttribute('href')).toBe('/help/howto/connect-claude');
    expect(screen.queryByText('Sign in')).toBeNull();
  });
});
