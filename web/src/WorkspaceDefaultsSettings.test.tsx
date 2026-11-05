import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceDefaultsSchema } from '@starlings/contracts/workspace-defaults';
import { WorkspaceDefaultsSettings } from './WorkspaceDefaultsSettings';
const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('./api', () => ({ apiFetch }));
const data = { defaults: workspaceDefaultsSchema.parse({ project_group_name: 'HQ' }), source: 'default', updated_at: null };
beforeEach(() => { vi.clearAllMocks(); apiFetch.mockResolvedValue(data); });
describe('Admin workspace defaults', () => {
  it('saves the complete draft and explains when it takes effect', async () => {
    render(<WorkspaceDefaultsSettings canEdit />);
    const group = await screen.findByRole('textbox', { name: 'Project group name' });
    fireEvent.change(group, { target: { value: 'HQ Lab' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Privacy email' }), { target: { value: 'privacy@hq.example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save defaults' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/admin/workspace/defaults', expect.objectContaining({ method: 'PUT', body: { ...data.defaults, project_group_name: 'HQ Lab', privacy_email: 'privacy@hq.example.com' } })));
    expect(await screen.findByRole('status')).toBeTruthy();
  });
  it('keeps one time zone and language, and makes every write unavailable to readers', async () => {
    const view = render(<WorkspaceDefaultsSettings canEdit />);
    await screen.findByRole('textbox', { name: 'Project group name' });
    for (const button of screen.getAllByRole('button', { name: /^Remove / })) {
      if (!button.hasAttribute('disabled')) fireEvent.click(button);
    }
    expect(screen.getByRole('button', { name: /^Remove / }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Português' }));
    expect(screen.getByRole('checkbox', { name: 'English' }).hasAttribute('disabled')).toBe(true);
    view.rerender(<WorkspaceDefaultsSettings canEdit={false} />);
    expect(screen.getByRole('button', { name: 'Save defaults' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('textbox', { name: 'Project group name' }).hasAttribute('disabled')).toBe(true);
  });
});
