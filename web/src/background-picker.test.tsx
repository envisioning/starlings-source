import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundEffectButtons } from './use-background-effect';

vi.mock('./custom-background', () => ({
  CUSTOM_BACKGROUND_TYPES: ['image/png'],
  loadCustomBackground: async () => null,
  saveCustomBackground: vi.fn(),
}));

describe('background picker', () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  });
  afterEach(() => {
    delete (HTMLElement.prototype as unknown as { scrollIntoView?: () => void }).scrollIntoView;
  });
  it('finds a generator and chooses its tone directly', async () => {
    const onChange = vi.fn();
    render(<BackgroundEffectButtons choice={{ mode: 'none' }} pending={false} error="" onChange={onChange} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Background, None' }));
    fireEvent.change(screen.getByPlaceholderText('Search'), { target: { value: 'Flock' } });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(3));
    fireEvent.click(screen.getByRole('option', { name: 'Flock · Ice' }));
    expect(onChange).toHaveBeenCalledWith({ mode: 'generated', generator: 'flock', tone: 'bright' });
  });
});
