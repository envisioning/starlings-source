import { afterEach, describe, expect, it, vi } from 'vitest';
import { coreContactDoor, coreSubjectDoor, coreTaskDoor } from './row-menu-items';
import { coreRecordURL, fetchCoreRegistry, searchCore } from './core-fields';
import { hrefForDoor } from './search-doors';
import { coreDashboardURL, workspaceCoreOrigin, workspaceCoreURL } from './workspace-core';
import type { CoreSearchHit } from '@starlings/contracts/core-fields';

function core(origin: string) {
  const meta = document.createElement('meta');
  meta.name = 'workspace-core';
  meta.content = origin;
  document.head.append(meta);
}

function coreGroups(groups: string) {
  const meta = document.createElement('meta');
  meta.name = 'workspace-core-groups';
  meta.content = groups;
  document.head.append(meta);
}

afterEach(() => {
  document.querySelectorAll('meta[name="workspace-core"], meta[name="workspace-core-groups"]').forEach((meta) => meta.remove());
  vi.unstubAllGlobals();
});

describe('workspace Core links', () => {
  it.each([undefined, 'off', 'not an origin', 'javascript:alert(1)'])('offers no Core doors for %s', async (origin) => {
    if (origin !== undefined) core(origin);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(workspaceCoreOrigin()).toBeNull();
    expect(coreSubjectDoor('project', 'project-1')).toBeUndefined();
    expect(coreTaskDoor({ project_id: 'project-1' })).toBeUndefined();
    expect(coreContactDoor('https://core.org.example/contacts/contact-1')).toBeUndefined();
    expect(hrefForDoor({ to: 'core', id: 'projects' }, { roomSlug: null })).toBeNull();
    expect(await fetchCoreRegistry()).toEqual([]);
    expect(await searchCore('review')).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses the configured Core origin for subjects, tasks, search and contact links', () => {
    core('https://records.example.test/');
    expect(coreSubjectDoor('project', 'project-1')?.href).toBe('https://records.example.test/dashboard/projects/project-1');
    expect(coreTaskDoor({ lead_id: 'lead-1' })?.href).toBe('https://records.example.test/dashboard/leads/lead-1');
    expect(coreDashboardURL('signals', 'signals-1')).toBe('https://records.example.test/dashboard/signals/signals-1');
    expect(coreContactDoor('https://records.example.test/contacts/contact-1')?.href).toBe('https://records.example.test/contacts/contact-1');
    expect(hrefForDoor({ to: 'core', id: 'projects' }, { roomSlug: null })).toBe('https://records.example.test/dashboard/projects');
    expect(coreRecordURL({ href: '/dashboard/projects/project-1' } as CoreSearchHit)).toBe('https://records.example.test/dashboard/projects/project-1');
  });

  it('links no record to Core once its group has moved to D1 (meet#1219)', () => {
    core('https://records.example.test');
    coreGroups('tasks,goals,interactions');
    expect(coreSubjectDoor('project', 'project-1')).toBeUndefined();
    expect(coreSubjectDoor('organization', 'org-1')).toBeUndefined();
    expect(coreTaskDoor({ lead_id: 'lead-1' })).toBeUndefined();
    expect(coreContactDoor('https://records.example.test/contacts/contact-1')).toBeUndefined();
    expect(hrefForDoor({ to: 'core', id: 'projects' }, { roomSlug: null })).toBeNull();
    expect(coreRecordURL({ href: '/dashboard/contacts/contact-1' } as CoreSearchHit)).toBeNull();
    // Records in no group, and groups still on Core, keep their link.
    expect(coreSubjectDoor('event', 'event-1')?.href).toBe('https://records.example.test/dashboard/events/event-1');
    expect(coreRecordURL({ href: '/dashboard/interactions/i-1' } as CoreSearchHit)).toBe('https://records.example.test/dashboard/interactions/i-1');
  });

  it('refuses another workspace or an external search-result URL', () => {
    core('https://records.example.test');
    expect(coreContactDoor('https://core.org.example/contacts/contact-1')).toBeUndefined();
    expect(coreContactDoor('https://records.example.test/dashboard/projects/project-1')).toBeUndefined();
    expect(workspaceCoreURL('//other.example.test/dashboard/projects/1')).toBeNull();
    expect(coreRecordURL({ href: 'https://other.example.test/dashboard/projects/1' } as CoreSearchHit)).toBeNull();
  });
});
