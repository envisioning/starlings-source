import { afterEach, describe, expect, it, vi } from 'vitest';
import fixture from '../../fixtures/workspace-defaults.json';
import { resolveLanguage } from '@starlings/contracts/language-values';
import { workspaceContact, workspaceLanguage, workspaceLanguages, workspaceProjectGroup, workspaceTimeZones } from './workspace-defaults';
import { isInternalProject, subjectDisplayTitle } from './crm-work';

// Branding is cached for a page's lifetime; these fixtures represent an HQ page.
vi.mock('./workspace-brand', async importOriginal => {
  const original = await importOriginal<typeof import('./workspace-brand')>();
  return { ...original, workspaceBrand: () => ({ name: 'HQ', markUrl: null }) };
});

function meta(name: string, content: string) {
  const tag = document.createElement('meta'); tag.name = name; tag.content = content; document.head.append(tag);
}
afterEach(() => document.head.querySelectorAll('meta[name^="workspace-"]').forEach(node => node.remove()));
describe('workspace default readers', () => {
  for (const row of fixture.cases) it(row.name, () => {
    meta('workspace-name', 'HQ');
    if (row.defaults) meta('workspace-defaults', JSON.stringify(row.defaults));
    expect(workspaceTimeZones().map(zone => zone.id)).toEqual(row.zones);
    expect(workspaceLanguages()).toEqual(row.languages);
    expect(workspaceLanguage(resolveLanguage(row.choice), resolveLanguage(row.device)!)).toBe(row.language);
    expect(workspaceProjectGroup()).toBe(row.group);
  });
  it('uses the configured project group but always respects an explicit external flag', () => {
    meta('workspace-defaults', JSON.stringify({ project_group_name: 'HQ Lab' }));
    const subject = { kind: 'project' as const, title: 'HQ Lab Operations' };
    expect(isInternalProject(subject)).toBe(true);
    expect(subjectDisplayTitle(subject)).toBe('Operations');
    expect(isInternalProject({ ...subject, internal: false })).toBe(false);
  });
  it('reads public contacts and tolerates a malformed page head', () => {
    meta('workspace-defaults', JSON.stringify({ contact_email: 'hello@hq.example.com', privacy_email: 'privacy@hq.example.com' }));
    expect(workspaceContact()).toBe('hello@hq.example.com');
    expect(workspaceContact(true)).toBe('privacy@hq.example.com');
    document.head.querySelector('meta[name="workspace-defaults"]')?.setAttribute('content', '{broken');
    expect(workspaceContact()).toBe('contact@site.example');
  });
});
