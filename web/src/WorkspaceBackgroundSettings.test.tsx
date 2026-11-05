import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ENVISIONING_BACKGROUND_TONES } from '@starlings/contracts/background-gallery';
import type { WorkspaceBackgroundAdminResponse } from '@starlings/contracts/workspace-backgrounds';
import { WorkspaceBackgroundSettings } from './WorkspaceBackgroundSettings';

const { apiFetch, apiUpload, prepareBackgroundImage } = vi.hoisted(() => ({ apiFetch: vi.fn(), apiUpload: vi.fn(), prepareBackgroundImage: vi.fn() }));
vi.mock('./api', () => ({ apiFetch, apiUpload }));
vi.mock('./custom-background', () => ({ prepareBackgroundImage }));
vi.mock('./background-gallery', () => ({ renderGalleryBackground: () => 'data:image/png;base64,eA==' }));
const data: WorkspaceBackgroundAdminResponse = { settings: { tones: null, image: null, default: null }, resolved: { tones: ENVISIONING_BACKGROUND_TONES, image_url: null, default: null }, updated_at: null };
beforeEach(() => { vi.clearAllMocks(); apiFetch.mockResolvedValue(data); Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() }); });
afterEach(() => vi.restoreAllMocks());
describe('Admin workspace backgrounds', () => {
  it('exposes six colours, nine previews and a searchable default, and saves the chosen values', async () => {
    const view = render(<WorkspaceBackgroundSettings canEdit accent={null} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save backgrounds' }).hasAttribute('disabled')).toBe(false));
    expect(view.container.querySelectorAll('img[data-generator]')).toHaveLength(9);
    fireEvent.change(screen.getByRole('combobox', { name: 'Tone colours' }), { target: { value: 'explicit' } });
    expect(screen.getAllByRole('textbox')).toHaveLength(6);
    fireEvent.click(screen.getByRole('combobox', { name: 'Default background, None' }));
    fireEvent.change(screen.getByPlaceholderText('Search'), { target: { value: 'Grid' } });
    fireEvent.click(screen.getByRole('option', { name: 'Grid · Dark' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save backgrounds' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/admin/workspace/backgrounds', expect.objectContaining({ method: 'PUT', body: { tones: ENVISIONING_BACKGROUND_TONES, default: { mode: 'generated', generator: 'grid', tone: 'dark' } } })));
  });
  it('blocks invisible explicit colours and makes every mutation unavailable to a reader', async () => {
    const view = render(<WorkspaceBackgroundSettings canEdit accent={null} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save backgrounds' }).hasAttribute('disabled')).toBe(false));
    fireEvent.change(screen.getByRole('combobox', { name: 'Tone colours' }), { target: { value: 'explicit' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Dark Pattern colour #rrggbb' }), { target: { value: ENVISIONING_BACKGROUND_TONES.dark.base } });
    expect(screen.getByRole('button', { name: 'Save backgrounds' }).hasAttribute('disabled')).toBe(true);
    view.rerender(<WorkspaceBackgroundSettings canEdit={false} accent={null} />);
    expect(screen.getByRole('combobox', { name: 'Tone colours' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Upload…' }).hasAttribute('disabled')).toBe(true);
  });
  it('uploads through the metadata-stripping preparation path and exposes replacement, image default and removal', async () => {
    const picture = { ...data, settings: { ...data.settings, image: { key: 'workspace/background' as const, version: 'one' } }, resolved: { ...data.resolved, image_url: 'http://localhost/workspace-background?v=one' } };
    apiUpload.mockResolvedValue(picture);
    const blob = new Blob(['raster'], { type: 'image/png' }); prepareBackgroundImage.mockResolvedValue({ blob });
    const view = render(<WorkspaceBackgroundSettings canEdit accent={null} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Upload…' }).hasAttribute('disabled')).toBe(false));
    const file = new File(['source'], 'picture.png', { type: 'image/png' });
    fireEvent.change(view.container.querySelector('input[type=file]')!, { target: { files: [file] } });
    await screen.findByRole('button', { name: 'Replace…' });
    expect(prepareBackgroundImage).toHaveBeenCalledWith(file);
    expect(apiUpload).toHaveBeenCalledWith('/admin/workspace/backgrounds/image', blob, expect.any(String));
    fireEvent.click(screen.getByRole('combobox', { name: 'Default background, None' }));
    expect(screen.getByRole('option', { name: 'Workspace picture' })).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: 'Workspace picture' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save backgrounds' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/admin/workspace/backgrounds', expect.objectContaining({ method: 'PUT', body: { tones: null, default: { mode: 'image' } } })));
    apiFetch.mockResolvedValue(picture);
    // The save mock above clears the picture; render its persisted state again.
    view.unmount(); render(<WorkspaceBackgroundSettings canEdit accent={null} />);
    await screen.findByRole('button', { name: 'Remove' });
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/admin/workspace/backgrounds/image', expect.objectContaining({ method: 'DELETE' })));
  });
});
