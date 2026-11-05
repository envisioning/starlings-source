import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ComponentProps } from 'react';
import { LocalVideoTrack, Track, type Room } from 'livekit-client';
import {
  applyBackgroundEffect,
  backgroundEffectErrorMessage,
  backgroundEffectLabel,
  DEFAULT_BACKGROUND_EFFECT,
  nextBlurChoice,
  nextImageChoice,
  type BackgroundEffectChoice,
} from './background-effects';
import {
  CUSTOM_BACKGROUND_TYPES,
  loadCustomBackground,
  saveCustomBackground,
  type CustomBackground,
} from './custom-background';
import { startCameraWatchdog } from './camera-watchdog';
import { hasSavedBackgroundChoice, loadMeetMediaPreferences, saveMeetMediaPreferences } from './meet-media-preferences';
import { Button } from '@/ui/button';
import { cn } from '@/lib/utils';
import { ErrorNotice } from './ErrorNotice';
import { pressedClass } from './meeting-control';
import { t } from './i18n';
import { BACKGROUND_GALLERY } from '@starlings/contracts/background-gallery';
import { backgroundChoiceLabel } from './background-gallery';
import { SearchablePicker } from './SearchablePicker';
import { useWorkspaceBackgrounds, refreshWorkspaceBackgrounds, subscribeWorkspaceBackgrounds, workspaceDefaultBackground } from './workspace-backgrounds';

// One module-level store for the active choice, so the prejoin card, the
// meeting-header control, and the settings dialog can never disagree (each
// used to keep private state seeded from localStorage at mount).
let activeChoice: BackgroundEffectChoice | null = null;
const listeners = new Set<() => void>();

function getChoice(): BackgroundEffectChoice {
  activeChoice ??= loadMeetMediaPreferences().backgroundEffect;
  return activeChoice;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Store the choice without applying it to a track (camera off, apply failure). */
export function setBackgroundEffectChoice(next: BackgroundEffectChoice = DEFAULT_BACKGROUND_EFFECT): void {
  activeChoice = next;
  saveMeetMediaPreferences({ backgroundEffect: next });
  for (const listener of listeners) listener();
}

export function roomCameraTrack(room: Room): LocalVideoTrack | undefined {
  const track = room.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
  return track instanceof LocalVideoTrack ? track : undefined;
}

export function useBackgroundEffect(getTrack: () => LocalVideoTrack | undefined) {
  const choice = useSyncExternalStore(subscribe, getChoice);
  const trackReader = useRef(getTrack);
  trackReader.current = getTrack;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const unsubscribe = subscribeWorkspaceBackgrounds(() => {
      if (!hasSavedBackgroundChoice()) {
        activeChoice = workspaceDefaultBackground();
        for (const listener of listeners) listener();
        const track = trackReader.current();
        if (track) void applyBackgroundEffect(track, activeChoice).catch(reason => setError(backgroundEffectErrorMessage(reason)));
      }
    });
    void refreshWorkspaceBackgrounds();
    return unsubscribe;
  }, []);
  const change = useCallback(async (next: BackgroundEffectChoice) => {
    setPending(true);
    setError('');
    try {
      const track = getTrack();
      if (!track) throw new Error(t('Turn on your camera before changing the background.'));
      await applyBackgroundEffect(track, next);
      setBackgroundEffectChoice(next);
    } catch (reason) {
      setError(backgroundEffectErrorMessage(reason));
    } finally {
      setPending(false);
    }
  }, [getTrack]);

  return { choice, pending, error, change, setError };
}

/**
 * Watches the published camera for silently-dead video and recovers it.
 *
 * Mounted next to the effect controls because the ladder's last rungs are
 * effect-shaped (restart the processor, then drop it), and because the effect
 * buttons are where a guest looks when their tile goes black.
 */
export function useCameraWatchdog(
  getTrack: () => LocalVideoTrack | undefined,
  onNotice: (message: string) => void,
): void {
  const noticeRef = useRef(onNotice);
  noticeRef.current = onNotice;

  useEffect(() => {
    return startCameraWatchdog({
      getTrack,
      hasEffect: () => getChoice().mode !== 'none',
      reapplyEffect: async (track) => {
        const choice = getChoice();
        if (choice.mode === 'none') return;
        await applyBackgroundEffect(track, choice);
      },
      onEvent: (event) => {
        switch (event.type) {
          case 'effect-dropped':
            setBackgroundEffectChoice();
            noticeRef.current(t('{reason} Turned it off so your camera keeps sending.', { reason: event.reason }));
            break;
          case 'camera-restarted':
            noticeRef.current('Your camera stopped sending video, so it was restarted.');
            break;
          case 'failed':
            noticeRef.current(event.reason);
            break;
          default:
            // 'stalled' is not worth a message on its own — recovery usually
            // lands within a tick or two and a flash of alarm helps nobody.
            // 'recovered' must not clear either: dropping the effect is what
            // *caused* the recovery, and that explanation has to stay up. The
            // next effect toggle clears it.
            break;
        }
      },
    });
  }, [getTrack]);
}

export function BlurIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="5" r="2.25" fill="currentColor" />
      <path
        d="M3.2 13.2c.55-2.35 2.35-3.7 4.8-3.7s4.25 1.35 4.8 3.7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M11.6 3.4c1.1.55 1.85 1.7 1.85 3.05 0 .55-.1 1.05-.3 1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        opacity="0.55"
      />
      <path
        d="M12.75 9.1c.85.7 1.4 1.7 1.4 2.85"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        opacity="0.4"
      />
    </svg>
  );
}

export function BlockIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="2.25" y="3.25" width="11.5" height="9.5" rx="1.5" fill="currentColor" opacity="0.22" />
      <rect
        x="2.25"
        y="3.25"
        width="11.5"
        height="9.5"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path d="M5 11.5h6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity="0.55" />
    </svg>
  );
}

export function ImageIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect
        x="2.25"
        y="3.25"
        width="11.5"
        height="9.5"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <circle cx="6" cy="6.5" r="1.15" fill="currentColor" />
      <path
        d="M3 11.4l3.1-2.7 2.2 1.9 2.2-2.4 2.5 3.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Your own picture: choose one, then toggle it like any other effect.
 *
 * One control doing both jobs, because they are the same question asked twice —
 * the first press has nothing to turn on, so it opens the file picker; after
 * that it toggles, and replacing the picture is on the right-click menu where
 * an infrequent action belongs. The file input is hidden rather than styled:
 * every browser draws it differently and none of them draw it like this bar.
 */
function CustomBackgroundButton({ choice, pending, disabled, onChange, onError, layout }: {
  choice: BackgroundEffectChoice;
  pending: boolean;
  disabled?: boolean;
  onChange: (next: BackgroundEffectChoice) => void;
  onError: (message: string) => void;
  layout: EffectLayout;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [stored, setStored] = useState<CustomBackground | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadCustomBackground().then((found) => {
      if (cancelled) return;
      setStored(found);
      setReady(true);
    });
    return () => { cancelled = true; };
  }, []);

  const choose = () => input.current?.click();

  const accept = async (file: File | undefined) => {
    if (!file) return;
    try {
      const saved = await saveCustomBackground(file);
      setStored(saved);
      // Turning it on is the point of having chosen it. Nobody picks a
      // background in order to look at a button.
      onChange({ mode: 'image' });
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : t('Couldn’t use that image.'));
    }
  };

  return (
    <>
      <EffectButton
        layout={layout}
        disabled={pending || disabled || !ready}
        aria-pressed={choice.mode === 'image'}
        onClick={() => (stored ? onChange(nextImageChoice(choice)) : choose())}
        onContextMenu={(event) => {
          if (!stored) return;
          event.preventDefault();
          choose();
        }}
      >
        <ImageIcon />
        <span>{pending && choice.mode === 'image' ? 'Image…' : backgroundEffectLabel(choice).image}</span>
      </EffectButton>
      {/* shadcn: a hidden file input; the image button opens it */}
      <input
        ref={input}
        type="file"
        accept={CUSTOM_BACKGROUND_TYPES.join(',')}
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Cleared so choosing the same file twice still fires a change —
          // otherwise replacing a picture with itself after an edit does nothing.
          event.target.value = '';
          void accept(file);
        }}
      />
    </>
  );
}

/**
 * Where the effect buttons sit. `menu` is the device menu's row of three
 * (symbol over label, equal widths); `row` is Settings (outline buttons that
 * wrap). Both are shadcn Button; a pressed effect fills in the primary.
 */
type EffectLayout = 'menu' | 'row';

const effectLayoutClass: Record<EffectLayout, string> = {
  menu: 'h-auto min-w-0 flex-1 basis-0 flex-col gap-1 px-1 py-2 text-[11px]',
  row: 'h-10 px-3.5 text-xs',
};

function EffectButton({ layout, className, ...props }: ComponentProps<typeof Button> & { layout: EffectLayout }) {
  return (
    <Button
      type="button"
      variant={layout === 'menu' ? 'ghost' : 'outline'}
      size={null}
      className={cn(effectLayoutClass[layout], pressedClass, className)}
      {...props}
    />
  );
}

/** The Blur / Block / Image buttons every surface renders, and the error under them. */
export function BackgroundEffectButtons({ choice, pending, error, onChange, layout = 'menu', disabled, clearable, onError }: {
  choice: BackgroundEffectChoice;
  pending: boolean;
  error: string;
  onChange: (next: BackgroundEffectChoice) => void;
  layout?: EffectLayout;
  disabled?: boolean;
  clearable?: boolean;
  /** Where a bad file is reported. Optional so existing callers keep working. */
  onError?: (message: string) => void;
}) {
  const profile = useWorkspaceBackgrounds();
  const labels = backgroundEffectLabel(choice);
  const blocked = pending || disabled;
  return (
    <>
      <div className={layout === 'menu' ? 'flex gap-1 px-0.5' : 'flex flex-wrap gap-2'}>
        <EffectButton
          layout={layout}
          disabled={blocked}
          aria-pressed={choice.mode === 'blur'}
          onClick={() => onChange(nextBlurChoice(choice))}
        >
          <BlurIcon />
          <span>{pending && choice.mode !== 'generated' ? 'Blur…' : labels.blur}</span>
        </EffectButton>
        <SearchablePicker
          label={t('Background')}
          placeholder={t('Background')}
          emptyMessage={t('No backgrounds found.')}
          disabled={blocked}
          className="min-w-0 flex-1"
          options={[
            { id: 'none', title: t('None') },
            ...(profile.image_url ? [{ id: 'workspace-image', title: t('Workspace picture') }] : []),
            ...BACKGROUND_GALLERY.map(entry => ({ id: `${entry.generator}:${entry.tone}`, title: backgroundChoiceLabel(entry) })),
          ]}
          value={choice.mode === 'generated' ? `${choice.generator}:${choice.tone}` : choice.mode === 'workspace-image' ? 'workspace-image' : 'none'}
          onChange={id => {
            const entry = BACKGROUND_GALLERY.find(entry => `${entry.generator}:${entry.tone}` === id);
            onChange(id === 'workspace-image' ? { mode: 'workspace-image' } : entry ? { mode: 'generated', ...entry } : DEFAULT_BACKGROUND_EFFECT);
          }}
        />
        <CustomBackgroundButton
          choice={choice}
          pending={pending}
          disabled={disabled}
          onChange={onChange}
          onError={onError ?? (() => undefined)}
          layout={layout}
        />
        {clearable && choice.mode !== 'none' && (
          <EffectButton
            layout={layout}
            variant="ghost"
            disabled={blocked}
            onClick={() => onChange(DEFAULT_BACKGROUND_EFFECT)}
          >
            <span>{t('Clear')}</span>
          </EffectButton>
        )}
      </div>
      {error && (
        <ErrorNotice
          className={cn(
            'text-[var(--danger-ink)]',
            layout === 'menu' ? 'px-2 py-1 text-[11px] leading-snug' : 'mt-2 text-xs leading-normal',
          )}
          role="status"
          message={error}
        />
      )}
    </>
  );
}
