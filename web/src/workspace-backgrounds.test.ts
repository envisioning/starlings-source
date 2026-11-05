import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ENVISIONING_BACKGROUND_TONES, backgroundTonesFromAccent } from '@starlings/contracts/background-gallery';
import { setWorkspaceBackgroundProfile, workspaceDefaultBackground, workspaceTonePair } from './workspace-backgrounds';
import { loadMeetMediaPreferences, saveMeetMediaPreferences } from './meet-media-preferences';

beforeEach(() => localStorage.clear());
afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); setWorkspaceBackgroundProfile({ tones: ENVISIONING_BACKGROUND_TONES, image_url: null, default: null }); });
describe('workspace camera preferences', () => {
  it('uses the workspace default until a person chooses, including explicit Off', () => {
    const choice = { mode: 'generated', generator: 'grid', tone: 'dark' } as const;
    setWorkspaceBackgroundProfile({ tones: ENVISIONING_BACKGROUND_TONES, image_url: null, default: choice });
    expect(loadMeetMediaPreferences().backgroundEffect).toEqual(choice);
    saveMeetMediaPreferences({ noiseFilter: false });
    expect(loadMeetMediaPreferences().backgroundEffect).toEqual(choice);
    saveMeetMediaPreferences({ backgroundEffect: { mode: 'none' } });
    expect(loadMeetMediaPreferences().backgroundEffect).toEqual({ mode: 'none' });
  });
  it('honours old saved choices and changes untouched defaults without changing private media settings', () => {
    localStorage.setItem('meet-media', JSON.stringify({ backgroundEffect: { mode: 'blur' } }));
    setWorkspaceBackgroundProfile({ tones: ENVISIONING_BACKGROUND_TONES, image_url: 'https://local/workspace-background?v=1', default: { mode: 'image' } });
    expect(workspaceDefaultBackground()).toEqual({ mode: 'workspace-image' });
    expect(loadMeetMediaPreferences().backgroundEffect).toEqual({ mode: 'blur' });
  });
  it('labels workspace tones generically while retaining pinned Envisioning names', () => {
    expect(workspaceTonePair('accent').label).toBe('Lime');
    const tones = backgroundTonesFromAccent('#2563eb')!;
    setWorkspaceBackgroundProfile({ tones, image_url: null, default: null });
    expect(workspaceTonePair('accent')).toEqual({ ...tones.accent, label: 'Accent' });
  });
});
