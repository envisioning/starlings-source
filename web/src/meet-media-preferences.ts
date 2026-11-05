import { legacyPlateChoice, parseBackgroundChoice } from '@starlings/contracts/background-gallery';
import { workspaceDefaultBackground } from './workspace-backgrounds';
import { DEFAULT_BACKGROUND_EFFECT, type BackgroundEffectChoice } from './background-effects';

const STORAGE_KEY = 'meet-media';

export type MeetMediaPreferences = {
  backgroundEffect: BackgroundEffectChoice;
  backgroundEffectChosen?: boolean;
  audioOutputDeviceId: string;
  /** Krisp on the microphone (`noise-filter.ts`). On until this browser turns it off. */
  noiseFilter: boolean;
  /**
   * Voices from where their tiles are (`spatial-audio.tsx`). Off until this
   * browser turns it on. Stored under a new name: every save wrote the old
   * `spatialAudio: true` default back, so an old `true` is not a choice.
   */
  spatialAudioOptIn: boolean;
};

const DEFAULTS: MeetMediaPreferences = {
  backgroundEffect: DEFAULT_BACKGROUND_EFFECT,
  audioOutputDeviceId: 'default',
  noiseFilter: true,
  spatialAudioOptIn: false,
};

/**
 * The stored background. `{ mode: 'block', blockThemeId: 'night' }` is what
 * this browser saved before the gallery: it reads as the same
 * plate, so nobody loses their choice. Personal pictures are read from device-local storage when their
 * saved choice is restored.
 */
export function parseBackgroundEffect(raw: unknown): BackgroundEffectChoice {
  if (!raw || typeof raw !== 'object') return DEFAULT_BACKGROUND_EFFECT;
  const candidate = raw as { mode?: unknown; generator?: unknown; tone?: unknown; blockThemeId?: unknown };
  if (candidate.mode === 'workspace-image') return { mode: 'workspace-image' };
  if (candidate.mode === 'image') return { mode: 'image' };
  if (candidate.mode === 'blur') return { mode: 'blur' };
  const entry = candidate.mode === 'generated'
    ? parseBackgroundChoice(candidate.generator, candidate.tone)
    : candidate.mode === 'block' ? legacyPlateChoice(candidate.blockThemeId) : null;
  return entry ? { mode: 'generated', ...entry } : DEFAULT_BACKGROUND_EFFECT;
}

/// Choosing an output only means anything where a media element can be pointed
/// at one. Safari has no `setSinkId`, and a picker that silently does nothing
/// is worse than no picker, so both surfaces ask this before drawing one.
export function supportsAudioOutputSelection(): boolean {
  return (
    typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype
  );
}

export function loadMeetMediaPreferences(): MeetMediaPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS, backgroundEffect: workspaceDefaultBackground(), backgroundEffectChosen: false };
    const parsed = JSON.parse(raw) as Partial<MeetMediaPreferences>;
    return {
      backgroundEffect: hasSavedBackgroundChoice() ? parseBackgroundEffect(parsed.backgroundEffect) : workspaceDefaultBackground(),
      backgroundEffectChosen: hasSavedBackgroundChoice(),
      audioOutputDeviceId:
        typeof parsed.audioOutputDeviceId === 'string' && parsed.audioOutputDeviceId
          ? parsed.audioOutputDeviceId
          : DEFAULTS.audioOutputDeviceId,
      noiseFilter: typeof parsed.noiseFilter === 'boolean' ? parsed.noiseFilter : DEFAULTS.noiseFilter,
      spatialAudioOptIn: typeof parsed.spatialAudioOptIn === 'boolean' ? parsed.spatialAudioOptIn : DEFAULTS.spatialAudioOptIn,
    };
  } catch {
    return { ...DEFAULTS, backgroundEffect: workspaceDefaultBackground(), backgroundEffectChosen: false };
  }
}

export function saveMeetMediaPreferences(patch: Partial<MeetMediaPreferences>): MeetMediaPreferences {
  const next = { ...loadMeetMediaPreferences(), ...patch, backgroundEffectChosen: patch.backgroundEffect !== undefined ? true : hasSavedBackgroundChoice() };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Private mode / quota — preferences stay in-memory for this session only.
  }
  return next;
}

/** Old saved choices count too. Saving a speaker preference does not choose Off. */
export function hasSavedBackgroundChoice(): boolean {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<MeetMediaPreferences>;
    return parsed.backgroundEffectChosen ?? Object.prototype.hasOwnProperty.call(parsed, 'backgroundEffect');
  } catch { return false; }
}
