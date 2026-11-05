import { Tip } from './Tip';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  useMediaDevices,
  usePersistentUserChoices,
  usePreviewTracks,
  type LocalUserChoices as LiveKitLocalUserChoices,
} from '@livekit/components-react';
import {
  facingModeFromLocalTrack,
  Track,
  type LocalAudioTrack,
  type LocalVideoTrack,
} from 'livekit-client';
import { GatheringDots } from './GatheringDots';
import {
  applyBackgroundEffect,
  backgroundEffectErrorMessage,
  backgroundEffectSummary,
  type BackgroundEffectChoice,
} from './background-effects';
import type { LocalUserChoices } from './meeting-types';
import {
  loadMeetMediaPreferences,
  saveMeetMediaPreferences,
  supportsAudioOutputSelection,
} from './meet-media-preferences';
import {
  BackgroundEffectButtons,
  setBackgroundEffectChoice,
  useBackgroundEffect,
} from './use-background-effect';
import { CallCameraIcon, CallMicIcon, VideoIcon } from './action-icons';
import { DeviceList, DeviceMenuContent, DeviceSection } from './device-menu';
import { Button } from '@/ui/button';
import { Card } from '@/ui/card';
import { Popover, PopoverAnchor, PopoverTrigger } from '@/ui/popover';
import { Separator } from '@/ui/separator';
import { ControlGroup, ControlMenuButton, liveIconClass } from './meeting-control';
import { cn } from '@/lib/utils';
import { t } from './i18n';

/** LiveKit + browser defaults — keep preview aligned with the published call track. */
const PREVIEW_AUDIO = {
  autoGainControl: true,
  echoCancellation: true,
  noiseSuppression: true,
  voiceIsolation: true,
} as const;

/** Matches the Mac launch preview's meter, so "am I audible" reads the same. */
const METER_BAR_COUNT = 14;

/**
 * Live input level for the selected mic. The camera answers "do I look right"
 * on its own; without this, nothing on the prejoin screen answers "can they
 * hear me" until you are already in the room.
 */
function useMicrophoneLevel(track: LocalAudioTrack | undefined): number {
  const [level, setLevel] = useState(0);

  useEffect(() => {
    const stream = track?.mediaStream;
    if (!track || !stream) {
      setLevel(0);
      return;
    }
    // Safari still needs the prefix, and an AudioContext created before a
    // gesture starts suspended — resume is a no-op when it already runs.
    const AudioContextClass =
      window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;

    const context = new AudioContextClass();
    void context.resume().catch(() => {
      // Autoplay policy: the meter stays at zero until the join click.
    });
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    const source = context.createMediaStreamSource(stream);
    source.connect(analyser);

    const samples = new Float32Array(analyser.fftSize);
    let frame = 0;
    let peak = 0;
    const tick = () => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      const rms = Math.sqrt(sum / samples.length);
      // Same shaping as MicrophoneLevelMonitor on the Mac: boost the quiet
      // range, fast attack, slow decay.
      peak = Math.max(Math.min(1, rms * 4.5), peak * 0.86);
      setLevel(peak);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      source.disconnect();
      void context.close().catch(() => {
        // Already closed with the track.
      });
      setLevel(0);
    };
  }, [track]);

  return level;
}

function MicrophoneMeter({ level, muted }: { level: number; muted: boolean }) {
  const lit = muted ? 0 : Math.floor(level * METER_BAR_COUNT);
  return (
    <div
      className="flex flex-[1_0_100%] items-center gap-[3px]"
      role="meter"
      aria-label={t('Microphone input level')}
      aria-valuemin={0}
      aria-valuemax={METER_BAR_COUNT}
      aria-valuenow={lit}
    >
      {Array.from({ length: METER_BAR_COUNT }, (_, index) => (
        <span
          key={index}
          className={cn(
            'h-3.5 w-[7px] rounded-[2px] bg-border transition-colors duration-[90ms] ease-linear',
            index < lit && (index >= METER_BAR_COUNT - 2 ? 'bg-destructive' : 'bg-[var(--accent)]'),
          )}
        />
      ))}
      <span className="ml-[7px] text-xs text-muted-foreground">
        {muted ? t('Microphone is off') : t('Speak to check your mic')}
      </span>
    </div>
  );
}

/* The media row: two controls side by side, each a toggle that names its
   device and a chevron for the device menu (meeting-control.tsx). The face
   stays neutral; a live device lights its icon in the accent mark. */
const rowGroupClass = 'h-10 flex-1';
const rowToggleClass = cn('h-full min-w-0 flex-1 justify-start rounded-none text-xs', liveIconClass);

function resolveDeviceLabel(
  devices: MediaDeviceInfo[],
  deviceId: string,
  fallback: string,
): string {
  const exact = devices.find((device) => device.deviceId === deviceId);
  if (exact?.label) return exact.label;
  const preferred = devices.find((device) => device.deviceId === 'default') ?? devices[0];
  return preferred?.label || fallback;
}

/**
 * Microphone toggle plus its device list, and — where the browser supports
 * choosing one — the speaker too. One dropdown for every audio decision,
 * mirroring the in-call mic menu (`MicMenu` in `MeetingExperience.tsx`).
 */
function AudioMenu({
  audioEnabled,
  onAudioEnabledChange,
  micLabel,
  audioTrack,
  audioDeviceId,
  onAudioDeviceChange,
  speakerSupported,
  speakerLabel,
  speakerDeviceId,
  onSpeakerDeviceChange,
}: {
  audioEnabled: boolean;
  onAudioEnabledChange: (enabled: boolean) => void;
  micLabel: string;
  audioTrack: LocalAudioTrack | undefined;
  audioDeviceId: string;
  onAudioDeviceChange: (deviceId: string) => void;
  speakerSupported: boolean;
  speakerLabel: string;
  speakerDeviceId: string;
  onSpeakerDeviceChange: (deviceId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [openSection, setOpenSection] = useState<'microphone' | 'speaker' | null>(null);
  const toggleSection = useCallback((id: string) => {
    setOpenSection((current) => (current === id ? null : (id as 'microphone' | 'speaker')));
  }, []);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <ControlGroup className={rowGroupClass}>
          <Button
            type="button"
            variant="ghost"
            className={rowToggleClass}
            aria-pressed={audioEnabled}
            onClick={() => onAudioEnabledChange(!audioEnabled)}
          >
            <CallMicIcon on={audioEnabled} />
            <span className="truncate">{micLabel}</span>
          </Button>
          <Tip label={t('Audio options')}>
            <PopoverTrigger asChild>
              <ControlMenuButton className="w-9" disabled={!audioTrack} aria-label={t('Audio options')} />
            </PopoverTrigger>
          </Tip>
        </ControlGroup>
      </PopoverAnchor>
<DeviceMenuContent>
          <DeviceSection label={t('Microphone')} summary={micLabel} open={openSection === 'microphone'} onOpenChange={() => toggleSection('microphone')}>
            <DeviceList
              initialSelection={audioDeviceId}
              kind="audioinput"
              track={audioTrack}
              onActiveDeviceChange={(id) => onAudioDeviceChange(id)}
            />
          </DeviceSection>
          {speakerSupported && (
            <>
              <Separator className="my-1" />
              <DeviceSection label={t('Speaker')} summary={speakerLabel} open={openSection === 'speaker'} onOpenChange={() => toggleSection('speaker')}>
                <DeviceList
                  initialSelection={speakerDeviceId}
                  kind="audiooutput"
                  onActiveDeviceChange={(id) => onSpeakerDeviceChange(id || 'default')}
                />
              </DeviceSection>
            </>
          )}
        </DeviceMenuContent>
</Popover>
  );
}

/**
 * Camera toggle, its device list, and background effects — the join-screen
 * twin of `CameraMenu` in `MeetingExperience.tsx`. Hide me has no meaning
 * before you have joined, so it stays out of this one.
 */
function VideoMenu({
  videoEnabled,
  onVideoEnabledChange,
  camLabel,
  videoTrack,
  videoDeviceId,
  onVideoDeviceChange,
  backgroundEffect,
  effectPending,
  effectError,
  onEffectChange,
  onEffectError,
}: {
  videoEnabled: boolean;
  onVideoEnabledChange: (enabled: boolean) => void;
  camLabel: string;
  videoTrack: LocalVideoTrack | undefined;
  videoDeviceId: string;
  onVideoDeviceChange: (deviceId: string) => void;
  backgroundEffect: BackgroundEffectChoice;
  effectPending: boolean;
  effectError: string;
  onEffectChange: (next: BackgroundEffectChoice) => Promise<void>;
  onEffectError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [openSection, setOpenSection] = useState<'camera' | 'background' | null>(null);
  const toggleSection = useCallback((id: string) => {
    setOpenSection((current) => (current === id ? null : (id as 'camera' | 'background')));
  }, []);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <ControlGroup className={rowGroupClass}>
          <Button
            type="button"
            variant="ghost"
            className={rowToggleClass}
            aria-pressed={videoEnabled}
            onClick={() => onVideoEnabledChange(!videoEnabled)}
          >
            <CallCameraIcon on={videoEnabled} />
            <span className="truncate">{camLabel}</span>
          </Button>
          <Tip label={t('Video options')}>
            <PopoverTrigger asChild>
              <ControlMenuButton className="w-9" disabled={!videoTrack} aria-label={t('Video options')} />
            </PopoverTrigger>
          </Tip>
        </ControlGroup>
      </PopoverAnchor>
<DeviceMenuContent>
          <DeviceSection label={t('Camera')} summary={camLabel} open={openSection === 'camera'} onOpenChange={() => toggleSection('camera')}>
            <DeviceList
              initialSelection={videoDeviceId}
              kind="videoinput"
              track={videoTrack}
              onActiveDeviceChange={(id) => onVideoDeviceChange(id)}
            />
          </DeviceSection>
          <Separator className="my-1" />
          <DeviceSection label={t('Background')} summary={backgroundEffectSummary(backgroundEffect)} open={openSection === 'background'} onOpenChange={() => toggleSection('background')}>
            <BackgroundEffectButtons
              choice={backgroundEffect}
              pending={effectPending}
              error={effectError}
              onError={onEffectError}
              disabled={!videoEnabled}
              onChange={(next) => void onEffectChange(next)}
            />
          </DeviceSection>
        </DeviceMenuContent>
</Popover>
  );
}

export function PrejoinDevices({
  defaults = {},
  joinLabel = t('Ask to join'),
  persistUserChoices = true,
  onSubmit,
  onError,
}: {
  defaults?: Partial<LiveKitLocalUserChoices>;
  joinLabel?: string;
  persistUserChoices?: boolean;
  onSubmit?: (values: LocalUserChoices) => void;
  onError?: (error: Error) => void;
}) {
  const {
    userChoices: initialUserChoices,
    saveAudioInputDeviceId,
    saveAudioInputEnabled,
    saveVideoInputDeviceId,
    saveVideoInputEnabled,
    saveUsername,
  } = usePersistentUserChoices({
    defaults,
    preventSave: !persistUserChoices,
    preventLoad: !persistUserChoices,
  });

  const username = (defaults.username ?? initialUserChoices.username).trim();
  const [audioEnabled, setAudioEnabled] = useState(initialUserChoices.audioEnabled);
  const [videoEnabled, setVideoEnabled] = useState(initialUserChoices.videoEnabled);
  const [audioDeviceId, setAudioDeviceId] = useState(initialUserChoices.audioDeviceId);
  const [videoDeviceId, setVideoDeviceId] = useState(initialUserChoices.videoDeviceId);

  useEffect(() => {
    saveAudioInputEnabled(audioEnabled);
  }, [audioEnabled, saveAudioInputEnabled]);
  useEffect(() => {
    saveVideoInputEnabled(videoEnabled);
  }, [videoEnabled, saveVideoInputEnabled]);
  useEffect(() => {
    saveAudioInputDeviceId(audioDeviceId);
  }, [audioDeviceId, saveAudioInputDeviceId]);
  useEffect(() => {
    saveVideoInputDeviceId(videoDeviceId);
  }, [videoDeviceId, saveVideoInputDeviceId]);
  useEffect(() => {
    if (username) saveUsername(username);
  }, [username, saveUsername]);

  const tracks = usePreviewTracks(
    {
      audio: audioEnabled ? { ...PREVIEW_AUDIO, deviceId: audioDeviceId } : false,
      video: videoEnabled ? { deviceId: videoDeviceId } : false,
    },
    onError,
  );

  const videoEl = useRef<HTMLVideoElement>(null);
  const videoTrack = useMemo(
    () => tracks?.find((track) => track.kind === Track.Kind.Video) as LocalVideoTrack | undefined,
    [tracks],
  );
  const getPreviewTrack = useCallback(
    () => (videoEnabled ? videoTrack : undefined),
    [videoEnabled, videoTrack],
  );
  const {
    choice: backgroundEffect,
    pending: effectPending,
    error: effectError,
    change: changeBackgroundEffect,
    setError: setEffectError,
  } = useBackgroundEffect(getPreviewTrack);
  const backgroundEffectRef = useRef(backgroundEffect);
  backgroundEffectRef.current = backgroundEffect;
  const audioTrack = useMemo(
    () => tracks?.find((track) => track.kind === Track.Kind.Audio) as LocalAudioTrack | undefined,
    [tracks],
  );
  const facingMode = useMemo(() => {
    if (!videoTrack) return 'undefined';
    return facingModeFromLocalTrack(videoTrack).facingMode;
  }, [videoTrack]);
  const micLevel = useMicrophoneLevel(audioEnabled ? audioTrack : undefined);

  useEffect(() => {
    if (videoEl.current && videoTrack) {
      videoTrack.unmute();
      videoTrack.attach(videoEl.current);
    }
    return () => {
      videoTrack?.detach();
    };
  }, [videoTrack]);

  // When the preview camera track is recreated (device switch), restore the chosen effect.
  useEffect(() => {
    const choice = backgroundEffectRef.current;
    if (!videoTrack || !videoEnabled) return;
    let cancelled = false;
    void applyBackgroundEffect(videoTrack, choice).catch((reason) => {
      if (cancelled) return;
      setEffectError(backgroundEffectErrorMessage(reason));
      setBackgroundEffectChoice();
    });
    return () => {
      cancelled = true;
    };
  }, [videoTrack, videoEnabled, backgroundEffect, setEffectError]);

  const audioDevices = useMediaDevices({ kind: 'audioinput' });
  const videoDevices = useMediaDevices({ kind: 'videoinput' });
  const speakerSupported = supportsAudioOutputSelection();
  const speakerDevices = useMediaDevices({ kind: 'audiooutput' });
  const [speakerDeviceId, setSpeakerDeviceId] = useState(
    () => loadMeetMediaPreferences().audioOutputDeviceId,
  );
  const micLabel = resolveDeviceLabel(audioDevices, audioDeviceId, t('Microphone'));
  const camLabel = resolveDeviceLabel(videoDevices, videoDeviceId, t('Camera'));
  const speakerLabel = resolveDeviceLabel(speakerDevices, speakerDeviceId, t('Speaker'));

  const userChoices: LocalUserChoices = {
    username,
    videoEnabled,
    videoDeviceId,
    audioEnabled,
    audioDeviceId,
    backgroundEffect,
  };

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!username) return;
    onSubmit?.(userChoices);
  }

  return (
    // The device card. The preview is square, like the in-call
    // self-view, and capped so it stays a preview rather than the page.
    <Card className="mx-auto w-full max-w-[440px] gap-4 bg-popover p-4 leading-normal shadow-[var(--shadow-raised)]">
      <div className="relative aspect-square w-full overflow-hidden rounded-md bg-muted">
        {videoTrack && (
          <video
            ref={videoEl}
            width="1280"
            height="720"
            className={cn('block size-full object-cover', facingMode === 'user' && '-scale-x-100')}
          />
        )}
        {(!videoTrack || !videoEnabled) && (
          // Camera off: the drifting flock, the idle sibling of the flock a
          // guest sees while they wait to be admitted.
          <div className="absolute inset-0 grid place-items-center bg-black text-white/45" aria-hidden="true">
            <GatheringDots motion="drift" width={128} height={128} />
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-stretch gap-2">
        <AudioMenu
          audioEnabled={audioEnabled}
          onAudioEnabledChange={setAudioEnabled}
          micLabel={micLabel}
          audioTrack={audioTrack}
          audioDeviceId={audioDeviceId}
          onAudioDeviceChange={setAudioDeviceId}
          speakerSupported={speakerSupported}
          speakerLabel={speakerLabel}
          speakerDeviceId={speakerDeviceId}
          onSpeakerDeviceChange={(id) => {
            setSpeakerDeviceId(id);
            saveMeetMediaPreferences({ audioOutputDeviceId: id });
          }}
        />
        <VideoMenu
          videoEnabled={videoEnabled}
          onVideoEnabledChange={(enabled) => {
            setVideoEnabled(enabled);
            if (!enabled) {
              setBackgroundEffectChoice();
              setEffectError('');
            }
          }}
          camLabel={camLabel}
          videoTrack={videoTrack}
          videoDeviceId={videoDeviceId}
          onVideoDeviceChange={setVideoDeviceId}
          backgroundEffect={backgroundEffect}
          effectPending={effectPending}
          effectError={effectError}
          onEffectChange={changeBackgroundEffect}
          onEffectError={setEffectError}
        />
        <MicrophoneMeter level={micLevel} muted={!audioEnabled || !audioTrack} />
      </div>

      <form className="grid" onSubmit={handleSubmit}>
        <Button type="submit" size="lg" className="w-full" disabled={!username}>
          <VideoIcon />
          {joinLabel}
        </Button>
      </form>
    </Card>
  );
}
