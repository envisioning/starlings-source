import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const favorites = vi.hoisted(() => ({
  starred: false,
  setFavorite: vi.fn(),
}));

vi.mock('./favorites', () => ({
  useFavorites: () => ({ rows: [], starredRows: [], loaded: true }),
  isFavorite: () => favorites.starred,
  setFavorite: favorites.setFavorite,
}));

const { FavoriteToggle } = await import('./FavoriteToggle');

describe('FavoriteToggle', () => {
  beforeEach(() => {
    favorites.starred = false;
    favorites.setFavorite.mockReset().mockResolvedValue(undefined);
  });

  it('stars the requested target and exposes its state accessibly', async () => {
    render(<FavoriteToggle kind="docs.document" targetRef="document-1" />);
    const button = screen.getByRole('button', { name: 'Star' });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(button);
    expect(favorites.setFavorite).toHaveBeenCalledWith(
      { kind: 'docs.document', target_ref: 'document-1' },
      true,
    );
  });

  it('announces a failed mutation without changing the row state', async () => {
    favorites.setFavorite.mockRejectedValueOnce(new Error('offline'));
    render(<FavoriteToggle kind="meet.agent" targetRef="agent-sub" />);
    fireEvent.click(screen.getByRole('button', { name: 'Star' }));
    expect((await screen.findByRole('status')).textContent).toContain('Couldn’t update favorites.');
    expect(screen.getByRole('button', { name: 'Star' }).getAttribute('aria-pressed')).toBe('false');
  });
});
