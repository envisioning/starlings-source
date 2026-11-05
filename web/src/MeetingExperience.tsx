import { Tip } from './Tip';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { BackButton } from './BackButton';
import { isWorkspaceMemberEmail } from './workspace-identity';
import type { TranscriptLanguage } from '@starlings/contracts';
import { CAPTION_DATA_TOPIC, MODERATION_DATA_TOPIC } from '@starlings/contracts/data-topics';
import type { ReactionEmoji } from '@starlings/contracts/reactions';
import {
  LayoutContextProvider,
  LiveKitRoom,
  RoomAudioRenderer,
  StartAudio,
  useConnectionQualityIndicator,
  useConnectionState,
  useCreateLayoutContext,
  useDataChannel,
  useLocalParticipant,
  useMaybeLayoutContext,
  useMediaDevices,
  useParticipants,
  usePersistentUserChoices,
  usePinnedTracks,
  useRemoteParticipants,
  useRoomContext,
  useTrackToggle,
  useTracks,
  isTrackReference,
  type TrackReferenceOrPlaceholder,
  type WidgetState,
} from '@livekit/components-react';
import { ConnectionQuality, ConnectionState, DisconnectReason, RoomEvent, Track, type RoomOptions } from 'livekit-client';
import {
  applyBackgroundEffect,
  backgroundEffectErrorMessage,
  backgroundEffectSummary,
  type BackgroundEffectChoice,
} from './background-effects';
import { roomPermalink } from './config';
import { ReactionControl, ReactionOverlay, useMeetingReactions } from './meeting-reactions';
import { ChatReactionsProvider } from './meeting-chat-reactions';
import { MeetingChat } from './meeting-chat';
import { PrejoinDevices } from './PrejoinDevices';
import { formatMeetingDuration } from './meeting-duration';
import { recordMeetError } from './meeting-error-log';
import { loadMeetMediaPreferences, saveMeetMediaPreferences, supportsAudioOutputSelection } from './meet-media-preferences';
import { watchMicrophoneForNoiseFilter } from './noise-filter';
import {
  BackgroundEffectButtons,
  roomCameraTrack,
  setBackgroundEffectChoice,
  useBackgroundEffect,
  useCameraWatchdog,
} from './use-background-effect';
import { MeetingDebugControl } from './MeetingDebugControl';
import { isSameTrack, MeetParticipantTile, participantDisplayName } from './MeetParticipantTile';
import {
  isLocalCameraTile,
  isScreenShareOverlay,
  personKey,
  SelfDockContext,
  useScreenShareLayoutChoice,
  useSelfViewMode,
  useSelfViewSize,
  type ScreenShareLayoutChoice,
} from './stage-layout';
import { Markdown } from './markdown';
import { MessageLinkPreview, guestPreviewLoader, type PreviewLoader } from './link-preview';
import { HandIcon, handWriter, useRaisedHands } from './meeting-hands';
import { HAND_ATTRIBUTE, HAND_STALE_AFTER_MS, HOST_ATTRIBUTE, handRaisedAt } from '@starlings/contracts/hands';
import { LIVE_TRANSCRIPT_HISTORY_LINES } from '@starlings/contracts/limits';
import { CallCameraIcon, CallChatIcon, CallLeaveIcon, CallMicIcon, CallSettingsIcon, CameraIcon, MeetingPeopleIcon, MicIcon, ScreenShareIcon, ScreenShareStopIcon } from './action-icons';
import { SquareGridLayout } from './SquareGridLayout';
import { HomeGridBackground } from './HomeGridBackground';
import { MeetingSettings } from './MeetingSettings';
import { applySpatialAudioOutput, SpatialAudioRenderer, useSpatialAudioState } from './spatial-audio';
import { DeviceList, DeviceMenuContent, DeviceSection } from './device-menu';
import { Popover, PopoverAnchor, PopoverTrigger } from '@/ui/popover';
import { Badge } from '@/ui/badge';
import { Separator } from '@/ui/separator';
import { Button } from '@/ui/button';
import { Card } from '@/ui/card';
import { Item, ItemActions, ItemContent, ItemGroup, ItemMedia, ItemTitle } from '@/ui/item';
import { Spinner } from '@/ui/spinner';
import { cn } from '@/lib/utils';
import { IdentityAvatar } from './PeerAvatar';
import { ControlButton, ControlGroup, ControlMenuButton, GroupedControlButton, leaveButtonClass } from './meeting-control';
import type { ConnectionDetails, JoinIdentity, LocalUserChoices } from './meeting-types';
import { QualityReporter } from './QualityReporter';
import { AppShell, SiteBrand } from './SiteChrome';
import { readStored, StorageKeys, writeStored } from './storage';
import { ErrorNotice } from './ErrorNotice';
import { plural, t } from './i18n';
import { CaptionLine } from './transcript-parts';

// adaptiveStream / dynacast: match subscribed layers to tile size and pause
// unpublished layers. Explicit audioCaptureDefaults keep browser AEC/NS/AGC on
// even when callers only pass a deviceId.
function buildRoomOptions(audioOutputDeviceId: string): RoomOptions {
  return {
    adaptiveStream: true,
    dynacast: true,
    audioCaptureDefaults: {
      autoGainControl: true,
      echoCancellation: true,
      noiseSuppression: true,
      voiceIsolation: true,
    },
    audioOutput: { deviceId: audioOutputDeviceId },
  };
}

/*
 * The room frame on utilities. Tiles, the stage and screen share
 * stay Meet shapes: no shadcn video tile exists.
 */
const ROOM_GRID = 'relative grid h-full w-full grid-cols-[minmax(0,1fr)] grid-rows-[0_minmax(0,1fr)_auto_auto] [&>*]:min-w-0';

/* Utility chrome over the canvas, not part of it: a 0-tall row whose own
   children take the pointer, so the header never steals input from the
   stage around them. On a phone the brand keeps only its mark. */
const HEADER =
  'pointer-events-none relative z-5 flex h-0 min-h-0 items-start gap-4 overflow-visible px-6 pt-3 [&>*]:pointer-events-auto max-[640px]:gap-2.5 max-[640px]:px-3 max-[640px]:pt-0';

/* LiveKit shows this only while the browser blocks playback. On a phone it
   sits in the middle of the screen, where a thumb finds it. */
const START_AUDIO =
  'relative cursor-pointer items-center justify-center gap-2 rounded-md border-0 bg-primary px-4 py-2.5 font-[inherit] whitespace-nowrap text-primary-foreground max-[600px]:fixed max-[600px]:top-1/2 max-[600px]:left-1/2 max-[600px]:-translate-1/2';

/*
 * Screen share: the share owns the stage. The camera row floats over it for
 * small groups (overlay); larger groups get a fixed rail with its own
 * scroll. The rail goes beside the share on a wide landscape stage and below
 * it elsewhere; a portrait tablet keeps the share wide. Tailwind reads class
 * names as written, so each media variant is spelled out in full: min 680
 * wide and landscape puts the rail beside, min 601 wide and portrait below.
 */
const SHARE_FOCUS_BESIDE_RAIL =
  '[@media(min-width:680px)_and_(min-aspect-ratio:5/4)]:right-[156px] [@media(min-width:601px)_and_(max-aspect-ratio:5/4)]:right-0 [@media(min-width:601px)_and_(max-aspect-ratio:5/4)]:bottom-[100px]';
const SHARE_RAIL =
  'absolute z-3 flex items-center gap-3 overflow-auto overscroll-contain [scrollbar-width:none] empty:hidden [&::-webkit-scrollbar]:hidden';
const SHARE_RAIL_OVERLAY = 'right-0 left-0 h-[88px] justify-center-safe px-3 py-1.5';
const SHARE_RAIL_BESIDE = [
  'right-0 bottom-0 left-0 h-[100px] px-3',
  '[@media(min-width:680px)_and_(min-aspect-ratio:5/4)]:top-0 [@media(min-width:680px)_and_(min-aspect-ratio:5/4)]:left-auto [@media(min-width:680px)_and_(min-aspect-ratio:5/4)]:h-auto [@media(min-width:680px)_and_(min-aspect-ratio:5/4)]:w-[144px] [@media(min-width:680px)_and_(min-aspect-ratio:5/4)]:flex-col [@media(min-width:680px)_and_(min-aspect-ratio:5/4)]:px-0 [@media(min-width:680px)_and_(min-aspect-ratio:5/4)]:py-3',
  '[@media(min-width:601px)_and_(max-aspect-ratio:5/4)]:top-auto [@media(min-width:601px)_and_(max-aspect-ratio:5/4)]:left-0 [@media(min-width:601px)_and_(max-aspect-ratio:5/4)]:h-[100px] [@media(min-width:601px)_and_(max-aspect-ratio:5/4)]:w-auto [@media(min-width:601px)_and_(max-aspect-ratio:5/4)]:flex-row [@media(min-width:601px)_and_(max-aspect-ratio:5/4)]:px-3 [@media(min-width:601px)_and_(max-aspect-ratio:5/4)]:py-0',
].join(' ');
const SHARE_RAIL_TILE = 'aspect-square size-[76px] min-h-[76px] min-w-[76px] flex-[0_0_76px]';
const SHARE_RAIL_TILE_BESIDE =
  '[@media(min-width:680px)_and_(min-aspect-ratio:5/4)]:size-[112px] [@media(min-width:680px)_and_(min-aspect-ratio:5/4)]:min-h-[112px] [@media(min-width:680px)_and_(min-aspect-ratio:5/4)]:min-w-[112px] [@media(min-width:680px)_and_(min-aspect-ratio:5/4)]:basis-[112px]';

/* Minimize, dock and close on your own tile: they fade in on hover or focus
   so they do not sit on your face the whole call. `group-[:hover]` and not
   `group-hover`: a tap on a phone must show them too. */
const SELF_ACTIONS = 'absolute top-1.5 right-1.5 z-1 flex gap-1 opacity-0 transition-opacity duration-150 focus-within:opacity-100';
const SELF_ACTION =
  "size-[22px] rounded-full bg-black/45 p-0 text-white hover:text-white [&_svg:not([class*='size-'])]:size-3";

/** A count pill on a bar cell. */
const CONTROL_BADGE =
  'inline-flex min-h-[18px] min-w-[18px] items-center justify-center rounded-[9px] px-[5px] text-[11px] leading-[18px] font-semibold';

/**
 * A notice directly above the controls, so the stop button sits next to the
 * button that started the share. Neutral while sharing, matching the outline
 * everyone else sees; danger when somebody stopped or muted you.
 */
function StageBanner({ stopped = false, icon, children }: { stopped?: boolean; icon: ReactNode; children: ReactNode }) {
  return (
    <div
      className={cn(
        'mx-auto mb-2 flex w-[min(100%,640px)] items-center gap-2.5 rounded-[10px] border py-2 pr-2.5 pl-3.5 text-sm text-foreground [&>svg]:shrink-0',
        stopped
          ? 'border-destructive bg-destructive/12 [&>svg]:fill-destructive'
          : 'border-[rgb(var(--ink-rgb)/0.6)] bg-[color-mix(in_srgb,var(--ink)_8%,transparent)] [&>svg]:fill-foreground',
      )}
      role="status"
    >
      {icon}
      {children}
    </div>
  );
}

/** Connecting, reconnecting, or gone: one line at the top of the window. */
function ConnectionToast() {
  const state = useConnectionState();
  const message = state === ConnectionState.Connecting
    ? t('Connecting')
    : state === ConnectionState.Reconnecting
      ? t('Reconnecting')
      : state === ConnectionState.Disconnected
        ? t('Disconnected')
        : null;
  if (!message) return null;
  const busy = state !== ConnectionState.Disconnected;
  return (
    <div role="status" aria-live="polite" className="fixed top-3 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-md border bg-popover px-5 py-3 text-popover-foreground shadow-[var(--shadow-raised)]">
      {busy && <Spinner />}
      {message}
    </div>
  );
}

/**
 * Every remote voice, flat or on the arc. LiveKit's own renderer is the flat
 * mix; spatial audio replaces it, one panner per microphone, when
 * this browser wants it and can run it. Screen-share audio stays flat either
 * way.
 */
function MeetingAudioOutput() {
  const spatial = useSpatialAudioState();
  if (spatial.wanted && spatial.supported) return <SpatialAudioRenderer />;
  return <RoomAudioRenderer />;
}

/** Guest-facing guidance for the common getUserMedia failures. */
function mediaErrorMessage(reason: unknown): string {
  const name = reason instanceof DOMException ? reason.name : '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return t('Camera and microphone are blocked. Allow them in browser settings or continue without them.');
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return t('No camera or microphone was found. Connect one, or ask to join without them.');
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return t('Another app is using your camera or microphone. Close it and reload this page.');
  }
  return t('Your camera or microphone couldn’t start. You can still ask to join without them.');
}

export function Prejoin({ roomSlug, identity, session = false, error, onJoin, onBack }: {
  roomSlug: string;
  identity: JoinIdentity;
  /** An event session (docs/SESSIONS.md §8): mic and camera start off on every visit. */
  session?: boolean;
  error: string;
  onJoin: (choices: LocalUserChoices) => void;
  /** Up one step, to Room entry — never browser history (docs/SURFACES.md). */
  onBack: () => void;
}) {
  const [mediaError, setMediaError] = useState('');
  return (
    <AppShell variant="wide" roomSlug={roomSlug}>
      <section className="grid w-full grid-cols-[minmax(240px,0.72fr)_minmax(500px,1.28fr)] items-center gap-12 text-[14px] leading-normal max-[760px]:grid-cols-1 max-[760px]:gap-6 max-[640px]:gap-4">
        <div className="[&_h1]:text-[clamp(36px,4.5vw,52px)] max-[760px]:max-w-[560px]">
          <BackButton label={t('Back')} onClick={onBack} />
          <h1>{t('Ready when you are, {name}', { name: identity.name.trim().split(/\s+/)[0] || identity.name })}</h1>
          <p className="lede">
            {t('Your camera and microphone are off. Switch on what you want to join with, and choose a background.')}
          </p>
          {(error || mediaError) && <ErrorNotice message={error || mediaError} />}
        </div>
        <PrejoinDevices
          // A guest arriving from a link is a visitor in someone else's room,
          // so nothing transmits until they say so. `persistUserChoices` means
          // this is a first-visit default, not a per-visit reset: whatever they
          // pick here is what the next visit from this browser starts with.
          defaults={{ username: identity.name, audioEnabled: false, videoEnabled: false }}
          joinLabel="Ask to join"
          // In an event session the last visit's choice does not carry over.
          persistUserChoices={!session}
          onSubmit={onJoin}
          onError={(reason) => {
            console.error('Media preview failed', reason);
            recordMeetError('media preview', reason);
            setMediaError(mediaErrorMessage(reason));
          }}
        />
      </section>
    </AppShell>
  );
}

/**
 * Why the room let go, in App's terms. Read here and not in App so the
 * LiveKit SDK stays in this lazy chunk and out of every page's entry
 *: `owner-closed` — the room was deleted or closed, the meeting
 * is over; `removed` — the host removed this guest; `dropped` — anything
 * else, transient and worth a reconnect.
 */
export type MeetingDisconnect = 'owner-closed' | 'removed' | 'dropped';

function classifyDisconnect(reason?: DisconnectReason): MeetingDisconnect {
  if (reason === DisconnectReason.ROOM_DELETED || reason === DisconnectReason.ROOM_CLOSED) return 'owner-closed';
  if (reason === DisconnectReason.PARTICIPANT_REMOVED) return 'removed';
  return 'dropped';
}

export function ConnectedMeeting({ roomSlug, connection, mediaChoices, scheduledEndsAt, onDisconnected, onLeave, onOwnerLeft }: {
  roomSlug: string;
  connection: ConnectionDetails;
  mediaChoices: LocalUserChoices;
  /** End of the booking behind a token link, or null on a bare slug. */
  scheduledEndsAt?: string | null;
  onDisconnected: (why: MeetingDisconnect) => void;
  onLeave?: () => void;
  /** Host left or the SFU room was torn down — show the ended summary. */
  onOwnerLeft?: () => void;
}) {
  const initialEffect = mediaChoices.backgroundEffect ?? loadMeetMediaPreferences().backgroundEffect;
  const audioOutputDeviceId = useMemo(
    () => loadMeetMediaPreferences().audioOutputDeviceId,
    [],
  );
  const roomOptions = useMemo(
    () => buildRoomOptions(audioOutputDeviceId),
    [audioOutputDeviceId],
  );
  // A guest has no account, so chat's link previews are authorized by the
  // meeting's own artifact token — the same credential the quality report uses,
  // and the same thing it asserts: you are in this meeting.
  const previewLoader = useMemo(
    () => guestPreviewLoader(roomSlug, connection.meeting_id, connection.artifact_token),
    [roomSlug, connection.meeting_id, connection.artifact_token],
  );
  // Raising a hand is a write the browser is not allowed to make itself — see
  // meeting-hands.tsx — so it goes through the control plane on the same
  // meeting token, which is what says whose hand it is.
  const writeHand = useMemo(
    () => handWriter(roomSlug, connection.meeting_id, connection.artifact_token),
    [roomSlug, connection.meeting_id, connection.artifact_token],
  );

  return (
    <main className="h-screen bg-[var(--surface-sunken)] pb-[env(safe-area-inset-bottom)] text-[14px] leading-normal supports-[height:100dvh]:h-dvh">
      <LiveKitRoom
        // The meeting grid lives on LiveKit's own container, the one child of
        // the shell. Order matches the Mac app: stage, controls, transcript.
        // The header row is 0 tall: its controls float over the stage, so the
        // stage and its top-centred self-view get the full height. The column
        // floor is 0, not auto, so a narrow window never keeps the stage's
        // last measured width and grows a horizontal scrollbar (#211).
        className={ROOM_GRID}
        token={connection.participant_token}
        serverUrl={connection.server_url}
        options={roomOptions}
        connect
        audio={
          mediaChoices.audioEnabled
            ? {
                deviceId: mediaChoices.audioDeviceId,
                autoGainControl: true,
                echoCancellation: true,
                noiseSuppression: true,
                voiceIsolation: true,
              }
            : false
        }
        video={mediaChoices.videoEnabled ? { deviceId: mediaChoices.videoDeviceId } : false}
        onDisconnected={(reason) => onDisconnected(classifyDisconnect(reason))}
      >
        <header className={HEADER}>
          <SiteBrand className="[@media(max-width:640px)]:mr-auto" labelClassName="[@media(max-width:640px)]:sr-only" signedOut />
          <CopyableRoomURL roomSlug={roomSlug} />
          <ScheduledClock endsAt={scheduledEndsAt} />
          <MeetingDebugControl roomSlug={roomSlug} connection={connection} />
        </header>
        {onOwnerLeft && <OwnerPresenceGuard onOwnerLeft={onOwnerLeft} />}
        <NoiseFilterGuard />
        <MeetingWorkspace
          initialEffect={initialEffect}
          startedAtMs={connection.started_at}
          previewLoader={previewLoader}
          writeHand={writeHand}
          onLeave={onLeave}
        />
        <MeetingAudioOutput />
        <StartAudio label={t('Enable meeting audio')} className={START_AUDIO} />
        <MeetingAnnouncer />
        <ConnectionToast />
        <QualityReporter roomSlug={roomSlug} connection={connection} />
      </LiveKitRoom>
    </main>
  );
}

/**
 * How much of the booked window is left.
 *
 * Advisory only — nothing ends a meeting when this hits zero, and the copy is
 * careful not to imply otherwise. Past the end it counts up as "over by", which
 * is the honest reading of a meeting that ran long and is more use than a
 * timer frozen at zero. Rendered only when a booking gave us an end time.
 */
function ScheduledClock({ endsAt }: { endsAt?: string | null }) {
  const endMs = useMemo(() => {
    if (!endsAt) return null;
    const parsed = new Date(endsAt).getTime();
    return Number.isNaN(parsed) ? null : parsed;
  }, [endsAt]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (endMs === null) return;
    // Minute resolution is what the label shows, but a 60s tick would let the
    // displayed minute lag the real one by up to a minute. Ten seconds keeps
    // it honest without waking the tab needlessly.
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, [endMs]);

  if (endMs === null) return null;
  const remaining = endMs - now;
  const over = remaining < 0;
  const minutes = Math.max(0, Math.round(Math.abs(remaining) / 60_000));
  // Under a minute either way is "ending now" rather than a jittering 0.
  const label = minutes === 0
    ? t('Ending now')
    : over
      ? t('Over by {minutes}', { minutes: formatClockMinutes(minutes) })
      : `${formatClockMinutes(minutes)} left`;

  return (
    <div
      className={cn(
        'text-xs font-medium tracking-[0.01em] whitespace-nowrap tabular-nums',
        over ? 'text-[rgb(var(--ink-rgb)/0.75)]' : 'text-[rgb(var(--ink-rgb)/0.55)]',
      )}
      aria-live="off"
    >
      {label}
    </div>
  );
}

function formatClockMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : t('{hours} h {rest} min', { hours, rest });
}

/**
 * Drop React meeting state, then disconnect so the SFU seat is released.
 * The last cell of the call bar, symbol over word and as tall as the rest,
 * as the phone's call bar draws it.
 */
function LeaveButton({ onLeave }: { onLeave: () => void }) {
  const room = useRoomContext();
  return (
    <ControlButton
      icon={<CallLeaveIcon className="m-1 size-4" />}
      label={t('Leave')}
      className={leaveButtonClass}
      onClick={() => {
        onLeave();
        void room.disconnect();
      }}
    />
  );
}

/**
 * Guests stay connected if DeleteRoom is slow or skipped. When the verified
 * owner drops out, wait a short grace (host network blip / reconnect) then
 * treat the meeting as over.
 */
/** Keeps Krisp on the microphone across publishes (`noise-filter.ts`). */
function NoiseFilterGuard() {
  const room = useRoomContext();
  useEffect(() => watchMicrophoneForNoiseFilter(room), [room]);
  return null;
}

function OwnerPresenceGuard({ onOwnerLeft }: { onOwnerLeft: () => void }) {
  const room = useRoomContext();
  const graceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const endedRef = useRef(false);

  useEffect(() => {
    const clearGrace = () => {
      if (graceRef.current !== null) {
        clearTimeout(graceRef.current);
        graceRef.current = null;
      }
    };

    const ownerStillPresent = () => {
      if (isMeetingOwnerParticipant(room.localParticipant)) return true;
      for (const participant of room.remoteParticipants.values()) {
        if (isMeetingOwnerParticipant(participant)) return true;
      }
      return false;
    };

    const scheduleEnd = () => {
      if (endedRef.current || ownerStillPresent()) return;
      clearGrace();
      graceRef.current = setTimeout(() => {
        graceRef.current = null;
        if (endedRef.current || ownerStillPresent()) return;
        endedRef.current = true;
        onOwnerLeft();
        void room.disconnect();
      }, 4_000);
    };

    const onParticipantDisconnected = (participant: { identity: string; metadata?: string }) => {
      if (isMeetingOwnerParticipant(participant)) scheduleEnd();
    };
    const onParticipantConnected = (participant: { identity: string; metadata?: string }) => {
      if (isMeetingOwnerParticipant(participant)) clearGrace();
    };

    room.on(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
    room.on(RoomEvent.ParticipantConnected, onParticipantConnected);

    return () => {
      clearGrace();
      room.off(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
      room.off(RoomEvent.ParticipantConnected, onParticipantConnected);
    };
  }, [room, onOwnerLeft]);

  return null;
}

/**
 * Owner devices are the participants whose identity the Worker minted from a
 * verified Envisioning session; guests and members always carry `guest:` ids.
 * The identity is the only field the server signs into the token — metadata
 * is deliberately not consulted, so nothing a participant could ever write
 * about themselves can make them read as the owner.
 */
function isMeetingOwnerParticipant(participant: { identity: string; metadata?: string }): boolean {
  return isTrustedCaptionPublisher(participant.identity);
}

function trackReferenceKey(track: TrackReferenceOrPlaceholder): string {
  const sid = isTrackReference(track) ? track.publication?.trackSid ?? 'placeholder' : 'placeholder';
  return `${track.participant.identity}:${track.source}:${sid}`;
}

/**
 * Keeps each track's React identity stable across renders that didn't
 * actually change it.
 *
 * `useTracks()` rebuilds its whole array — a fresh `{ participant,
 * publication, source }` wrapper per track — on every one of a fixed list of
 * room events, and that list includes a *local* track being unpublished.
 * Turning your microphone off is exactly that: it fully stops and unpublishes
 * the audio track so the OS's "mic in use" indicator actually goes dark (see
 * `MicrophoneModeration` above), which means every *other* track — your own
 * camera included — gets handed a brand-new prop object on every mic toggle,
 * even though nothing about the camera changed. That flashed the self-view
 * tile.
 *
 * The underlying `publication` is not recreated, though — LiveKit mutates it
 * in place — so reusing the previous wrapper whenever `publication` is
 * unchanged gives every tile a reference that only actually changes when the
 * track does. Real changes (mute, subscription) still reach the tile exactly
 * as before: those come from the tile's own event subscription, never from
 * diffing this prop.
 */
function useStableTrackReferences(
  tracks: TrackReferenceOrPlaceholder[],
): TrackReferenceOrPlaceholder[] {
  const previous = useRef(new Map<string, TrackReferenceOrPlaceholder>());
  return useMemo(() => {
    const next = new Map<string, TrackReferenceOrPlaceholder>();
    const stabilized = tracks.map((track) => {
      const key = trackReferenceKey(track);
      const prior = previous.current.get(key);
      const reusable = prior
        && isTrackReference(prior) === isTrackReference(track)
        && (!isTrackReference(track) || !isTrackReference(prior) || prior.publication === track.publication);
      const stable = reusable ? prior! : track;
      next.set(key, stable);
      return stable;
    });
    previous.current = next;
    return stabilized;
  }, [tracks]);
}

/**
 * Stage, then controls, then the transcript — the same top-to-bottom order the
 * Mac app uses, instead of LiveKit's all-in-one `VideoConference`. Composing it
 * here is what lets the background buttons sit in the control row next to the
 * camera (as they do on the Mac) and the captions live in a panel rather than
 * floating over people's faces.
 */
function MeetingWorkspace({ initialEffect, startedAtMs, previewLoader, writeHand, onLeave }: {
  initialEffect: BackgroundEffectChoice;
  /** Leave, drawn as the last cell of the call bar. */
  onLeave?: () => void;
  startedAtMs?: number;
  /** How chat reads a pasted link: the Worker, on this guest's meeting token. */
  previewLoader: PreviewLoader;
  /** How this guest's hand goes up and down, on the same token. */
  writeHand: (raised: boolean) => Promise<void>;
}) {
  const [widgetState, setWidgetState] = useState<WidgetState>({
    showChat: false,
    unreadMessages: 0,
    showSettings: false,
  });
  // Local-only: where your camera tile goes on this browser's stage
  // (floating square, docked in the grid, hidden). Publishing is untouched.
  const [selfView, setSelfView] = useSelfViewMode();
  const [selfViewMinimized, setSelfViewMinimized] = useState(false);
  const [screenShareLayout, setScreenShareLayout] = useScreenShareLayoutChoice();
  useEffect(() => {
    if (selfView !== 'floating') setSelfViewMinimized(false);
  }, [selfView]);
  const floatSelf = useCallback(() => setSelfView('floating'), [setSelfView]);
  // Side length of the self-view square, in px — drag its corner to resize.
  const [selfViewSize, resizeSelfView] = useSelfViewSize();
  // People is the participant list inside a meeting — Team is the roster
  // outside one (docs/SURFACES.md). Local UI state like Chat, not a widget.
  const [showPeople, setShowPeople] = useState(false);
  // Focus goes back to the button that opened the panel when the panel
  // closes, by Close or by Escape.
  const peopleButton = useRef<HTMLButtonElement>(null);
  const closePeople = useCallback(() => {
    setShowPeople(false);
    peopleButton.current?.focus();
  }, []);
  const reactions = useMeetingReactions();
  const layoutContext = useCreateLayoutContext();
  const remoteParticipants = useRemoteParticipants();
  const participants = useParticipants();
  const people = peopleCount(participants);
  const rawTracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { updateOnlyOn: [RoomEvent.ActiveSpeakersChanged], onlySubscribed: false },
  );
  // Stable per-track identity, so an unrelated event (muting your mic, say)
  // doesn't hand every camera tile a "new" prop and flash the self-view.
  const tracks = useStableTrackReferences(rawTracks);

  // Your own camera is a square reference tile over the stage rather than a
  // peer in the grid, unless you dock it: then it is the last tile, in the
  // grid or the share carousel. "Hide me" drops it; publishing is untouched.
  const selfTrack = tracks.find(isLocalCameraTile);
  const peerTracks = mergeDeviceTiles(
    tracks.filter((track) => !isLocalCameraTile(track)),
    selfTrack?.participant.identity,
  );
  const stageTracks = selfView === 'docked' && selfTrack ? [...peerTracks, selfTrack] : peerTracks;
  // Same empty-room copy/placement as Mac `MeetingStageView.emptyLabel`.
  const aloneInRoom = remoteParticipants.length === 0;
  const screenShares = tracks
    .filter(isTrackReference)
    .filter((track) => track.publication.source === Track.Source.ScreenShare);
  const focusTrack = usePinnedTracks(layoutContext)?.[0];
  const carouselTracks = stageTracks.filter((track) => !isSameTrack(track, focusTrack));

  // Screen shares take the stage on their own, and give it back when they stop
  // — same auto-pin behaviour LiveKit's own prefab has. The dependency is a key
  // rather than the array: track references are rebuilt on every render, so the
  // array itself would re-run this on each one.
  const autoFocused = useRef<string | null>(null);
  const screenShareKey = screenShares
    .map((track) => `${track.publication.trackSid}_${track.publication.isSubscribed}`)
    .join();
  useEffect(() => {
    const share = screenShares.find((track) => track.publication.isSubscribed);
    if (share && autoFocused.current === null) {
      autoFocused.current = share.publication.trackSid;
      layoutContext.pin.dispatch?.({ msg: 'set_pin', trackReference: share });
      return;
    }
    if (
      autoFocused.current !== null
      && !screenShares.some((track) => track.publication.trackSid === autoFocused.current)
    ) {
      autoFocused.current = null;
      layoutContext.pin.dispatch?.({ msg: 'clear_pin' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutContext, screenShareKey]);

  return (
    <LayoutContextProvider value={layoutContext} onWidgetChange={setWidgetState}>
      <ChatReactionsProvider>
      <section className="relative flex min-h-0 items-stretch bg-[var(--surface-sunken)] p-2">
        <HomeGridBackground meetingMode />
        {/* Nothing a layout does inside may paint over the control row.
            `data-meet-stage` is where spatial audio measures faces. */}
        <div className="relative z-1 min-h-0 min-w-0 flex-1 overflow-hidden" data-meet-stage>
          {aloneInRoom && (
            <div
              className="pointer-events-none absolute top-1/2 left-1/2 z-3 m-0 max-w-[calc(100%-32px)] -translate-1/2 p-0 text-center text-[15px] leading-[1.3] font-medium whitespace-nowrap text-muted-foreground"
              aria-live="polite"
            >
              {t('Waiting for someone to join')}
            </div>
          )}
          <SelfDockContext.Provider value={selfView === 'docked' ? floatSelf : null}>
            {focusTrack && focusTrack.source === Track.Source.ScreenShare ? (
              <ScreenShareStage
                focusTrack={focusTrack}
                otherTracks={carouselTracks}
                choice={screenShareLayout}
                hasFloatingSelf={selfView === 'floating' && !selfViewMinimized && !!selfTrack}
              />
            ) : stageTracks.length > 0 ? (
              <SquareGridLayout tracks={stageTracks} />
            ) : null}
          </SelfDockContext.Provider>
          {selfTrack && selfView === 'floating' && (
            <SelfViewTile
              track={selfTrack}
              size={selfViewSize}
              onResize={resizeSelfView}
              minimized={selfViewMinimized}
              onMinimizedChange={setSelfViewMinimized}
              onDock={() => setSelfView('docked')}
              onClose={() => setSelfView('hidden')}
            />
          )}
        </div>
        <MeetingChat
          open={widgetState.showChat}
          formatMessage={(text) => (
            <>
              {/* Same subset the rest of the app renders, so a link a guest
                  pastes reads the same in chat as in a thread — and, like
                  everywhere else, as React nodes rather than markup. */}
              <Markdown text={text} />
              <MessageLinkPreview text={text} loader={previewLoader} />
            </>
          )}
        />
        {showPeople && (
          <PeoplePanel
            participants={participants}
            screenShares={screenShares}
            onClose={closePeople}
          />
        )}
        <MeetingSettings />
      </section>
      <ScreenSharePresence />
      <MicrophoneModeration />
      <MeetingControls
        initialEffect={initialEffect}
        selfHidden={selfView === 'hidden'}
        onShowSelf={floatSelf}
        onReact={reactions.send}
        peopleCount={people}
        showPeople={showPeople}
        onTogglePeople={() => (showPeople ? closePeople() : setShowPeople(true))}
        peopleButton={peopleButton}
        writeHand={writeHand}
        hasScreenShare={focusTrack?.source === Track.Source.ScreenShare}
        screenShareLayout={screenShareLayout}
        onScreenShareLayoutChange={setScreenShareLayout}
        onLeave={onLeave}
      />
      <TranscriptPanel startedAtMs={startedAtMs} />
      <ReactionOverlay floaters={reactions.floaters} onDone={reactions.remove} />
      </ChatReactionsProvider>
    </LayoutContextProvider>
  );
}

function ScreenShareStage({
  focusTrack,
  otherTracks,
  choice,
  hasFloatingSelf,
}: {
  focusTrack: TrackReferenceOrPlaceholder;
  otherTracks: TrackReferenceOrPlaceholder[];
  choice: ScreenShareLayoutChoice;
  hasFloatingSelf: boolean;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = stage.current;
    if (!element) return undefined;
    const update = (width: number, height: number) => setSize((current) => (
      current.width === width && current.height === height ? current : { width, height }
    ));
    const bounds = element.getBoundingClientRect();
    update(bounds.width, bounds.height);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) update(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const mode = isScreenShareOverlay(choice, otherTracks.length, size.width, size.height)
    ? 'overlay'
    : 'rail';
  return (
    <div ref={stage} className="absolute inset-0 min-h-0 min-w-0">
      <div className={cn('absolute inset-0 min-h-0 min-w-0', mode === 'rail' && SHARE_FOCUS_BESIDE_RAIL)}>
        <MeetParticipantTile trackRef={focusTrack} className="size-full min-h-0 min-w-0" />
      </div>
      <div
        className={cn(
          SHARE_RAIL,
          mode === 'overlay'
            // The browser self-view is top-centred: the overlay row goes to
            // the opposite edge when it floats.
            ? cn(SHARE_RAIL_OVERLAY, hasFloatingSelf ? 'bottom-1.5' : 'top-1.5')
            : SHARE_RAIL_BESIDE,
        )}
        role="group"
        aria-label={t('People')}
      >
        {otherTracks.map((track) => (
          <MeetParticipantTile
            key={`${track.participant.identity}:${track.source}:${track.publication?.trackSid ?? 'placeholder'}`}
            trackRef={track}
            compactInShareRail
            className={cn(SHARE_RAIL_TILE, mode === 'rail' && SHARE_RAIL_TILE_BESIDE)}
          />
        ))}
      </div>
    </div>
  );
}

/** Side length of the minimized bubble — fixed, independent of the resizable square's size. */
const SELF_VIEW_MINIMIZED_SIZE = 64;

/**
 * The self-view square: separate from the participant stage, resizable by
 * dragging its corner, minimizable to a small bubble in the stage's
 * bottom-left corner, dockable into the grid, and closable with the ×.
 * Closing is the same state as "Hide me" — `MeetingControls`' "Show me"
 * toggle is the one place to bring it back; docking moves the tile into the
 * grid, where its own Float control reverses it; minimizing is local to the
 * tile and reverses by clicking the bubble again.
 */
function SelfViewTile({
  track,
  size,
  onResize,
  minimized,
  onMinimizedChange,
  onDock,
  onClose,
}: {
  track: TrackReferenceOrPlaceholder;
  size: number;
  onResize: (size: number) => void;
  minimized: boolean;
  onMinimizedChange: (minimized: boolean) => void;
  onDock: () => void;
  onClose: () => void;
}) {
  const drag = useRef<{ pointerId: number; startX: number; startY: number; startSize: number } | null>(null);

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startSize: size,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [size]);

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    // Corner handle: either axis moving outward grows the square, averaged so
    // a diagonal drag doesn't grow it twice as fast as a straight one.
    const delta = ((event.clientX - active.startX) + (event.clientY - active.startY)) / 2;
    onResize(active.startSize + delta);
  }, [onResize]);

  const endDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
  }, []);

  return (
    <div
      className={cn(
        // Your own camera rides over the stage as a square, centred against
        // the top edge under the webcam, as on Mac and iOS. Minimized, it is a
        // small bubble in the bottom-left corner. The tile inside is always a
        // square crop (`object-cover!`): LiveKit reads the local camera as
        // portrait before the first frame and would letterbox it. No name
        // plate on your own face; a smaller hand badge.
        'group/self absolute z-4 aspect-square overflow-hidden rounded-[12px] [&_[data-tile-hand]]:size-5 [&_[data-tile-hand]_svg]:size-3 [&_[data-tile-meta]]:hidden [&_video]:object-cover!',
        minimized
          ? 'bottom-3 left-3 cursor-pointer shadow-[0_4px_14px_rgb(0_0_0/45%)] hover:ring-1 hover:ring-(--hover-border)'
          : 'top-0 left-1/2 -translate-x-1/2 shadow-[0_8px_20px_rgb(0_0_0/35%)]',
      )}
      style={{ width: `${minimized ? SELF_VIEW_MINIMIZED_SIZE : size}px` }}
      onClick={minimized ? () => onMinimizedChange(false) : undefined}
    >
      <MeetParticipantTile trackRef={track} className="size-full" />
      <div className={cn(SELF_ACTIONS, 'group-[:hover]/self:opacity-100', minimized && 'opacity-85')}>
        {!minimized && (
          <Tip label={t('Minimize — tuck this into the corner')}><Button
            type="button"
            variant="ghost"
            className={SELF_ACTION}
            aria-label={t('Minimize — tuck this into the corner')}
            onClick={(event) => { event.stopPropagation(); onMinimizedChange(true); }}
          >
            <MinimizeIcon />
          </Button></Tip>
        )}
        {!minimized && (
          <Tip label={t('Dock — put your tile in the grid with everyone else')}><Button
            type="button"
            variant="ghost"
            className={SELF_ACTION}
            aria-label={t('Dock — put your tile in the grid with everyone else')}
            onClick={(event) => { event.stopPropagation(); onDock(); }}
          >
            <DockIcon />
          </Button></Tip>
        )}
        <Tip label={t('Close your own tile — bring it back with Show me in the controls')}><Button
          type="button"
          variant="ghost"
          className={SELF_ACTION}
          aria-label={t('Close your own tile — bring it back with Show me in the controls')}
          onClick={(event) => { event.stopPropagation(); onClose(); }}
        >
          <CloseIcon />
        </Button></Tip>
      </div>
      {!minimized && (
        <div
          // Drag the corner to resize the square; the grip shows on hover.
          className="absolute right-0 bottom-0 z-1 size-[18px] cursor-nwse-resize touch-none after:absolute after:right-1 after:bottom-1 after:size-2 after:rounded-br-[2px] after:border-r-2 after:border-b-2 after:border-solid after:border-[rgb(255_255_255/65%)] after:opacity-0 after:transition-opacity after:duration-150 after:content-[''] group-[:hover]/self:after:opacity-100"
          aria-hidden="true"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        />
      )}
    </div>
  );
}

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path d="M1.5 1.5 10.5 10.5M10.5 1.5 1.5 10.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function MinimizeIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path d="M2 9 10 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/** Four cells: this tile joins the grid. */
function DockIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path
        d="M2 2h3.2v3.2H2zM6.8 2H10v3.2H6.8zM2 6.8h3.2V10H2zM6.8 6.8H10V10H6.8z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * One person, one camera tile.
 *
 * Somebody in the room from two devices is two LiveKit participants on purpose
 * — LiveKit evicts a duplicate identity — so their camera tiles collapse back
 * to one here, keeping whichever device has a live camera. Their own other
 * device disappears entirely: it is already on screen as the self inset.
 *
 * Screen shares never merge. A share from someone's second device is another
 * thing to look at, not a duplicate of the first.
 */
function mergeDeviceTiles(
  tracks: TrackReferenceOrPlaceholder[],
  localIdentity: string | undefined,
): TrackReferenceOrPlaceholder[] {
  const SELF = -1;
  const keptByPerson = new Map<string, number>([[personKey(localIdentity), SELF]]);
  const merged: TrackReferenceOrPlaceholder[] = [];
  for (const track of tracks) {
    if (track.source !== Track.Source.Camera) {
      merged.push(track);
      continue;
    }
    const person = personKey(track.participant.identity);
    const kept = keptByPerson.get(person);
    if (kept === undefined) {
      keptByPerson.set(person, merged.length);
      merged.push(track);
      continue;
    }
    if (kept === SELF) continue;
    if (hasLiveCamera(track) && !hasLiveCamera(merged[kept]!)) merged[kept] = track;
  }
  return merged;
}

function hasLiveCamera(track: TrackReferenceOrPlaceholder): boolean {
  return isTrackReference(track) && !track.publication.isMuted;
}

const supportsScreenShare = typeof navigator !== 'undefined'
  && typeof navigator.mediaDevices?.getDisplayMedia === 'function';

/** `MODERATION_DATA_TOPIC`, inlined so the bundle need not pull in zod. */
const MODERATION_TOPIC = MODERATION_DATA_TOPIC;

/**
 * Says out loud that this browser is sharing, and carries the host's stop.
 *
 * A page cannot draw on the desktop, so unlike the Mac there is no border
 * around the shared screen itself — the browser's own sharing bar is the only
 * OS-level indicator, and it says nothing about *this meeting*. This banner is
 * the in-app half: which meeting the screen is going to, and one button to stop
 * without hunting for the browser's bar.
 *
 * It doubles as the receiver for the host stopping the share. The SFU mute
 * already took the picture off everyone's stage; unpublishing here is what
 * releases the capture, so the browser stops claiming to share something nobody
 * can see.
 */
function ScreenSharePresence() {
  const { localParticipant, isScreenShareEnabled } = useLocalParticipant();
  const [stoppedBy, setStoppedBy] = useState<string | null>(null);

  useDataChannel(MODERATION_TOPIC, (message) => {
    // Server-sent only. The control plane publishes moderation through
    // RoomService, which leaves the packet with no participant behind it — a
    // guest forging this topic arrives with `from` set, and is ignored.
    if (message.from) return;
    try {
      const decoded = JSON.parse(new TextDecoder().decode(message.payload)) as {
        version: number;
        type: string;
        by: string;
      };
      if (decoded.version !== 1 || decoded.type !== 'screenshare.stopped') return;
      void localParticipant.setScreenShareEnabled(false);
      setStoppedBy(decoded.by || t('The host'));
    } catch {
      // Moderation must never interrupt media.
    }
  });

  // Sharing again clears the last notice, so it reads as history rather than a
  // standing prohibition — being stopped once does not take the right away.
  useEffect(() => {
    if (isScreenShareEnabled) setStoppedBy(null);
  }, [isScreenShareEnabled]);

  if (isScreenShareEnabled) {
    return (
      <StageBanner icon={<ScreenShareIcon />}>
        <span className="flex-1">{t('You’re sharing your screen with everyone in this meeting.')}</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void localParticipant.setScreenShareEnabled(false)}
        >
          {t('Stop sharing')}
        </Button>
      </StageBanner>
    );
  }

  if (stoppedBy) {
    return (
      <StageBanner stopped icon={<ScreenShareIcon />}>
        <span className="flex-1">{t('{name} stopped your screen share.', { name: stoppedBy })}</span>
        <Button type="button" variant="outline" size="sm" onClick={() => setStoppedBy(null)}>
          {t('Dismiss')}
        </Button>
      </StageBanner>
    );
  }

  return null;
}

/**
 * Says who closed this browser's microphone.
 *
 * The SFU mute is what actually took the voice off the call, and LiveKit's own
 * mute state is what turns the mic button off — this adds the one thing neither
 * can: the reason. A microphone that goes dead with no explanation reads as a
 * broken device, and the next thing somebody does about a broken device is
 * leave the meeting to go and fix it.
 *
 * Nothing here unmutes. Opening a microphone again is the decision of the
 * person sitting behind it, which is why the notice is dismissible and the
 * control it points at is the ordinary mic button.
 */
function MicrophoneModeration() {
  const { localParticipant, isMicrophoneEnabled } = useLocalParticipant();
  const [mutedBy, setMutedBy] = useState<string | null>(null);

  useDataChannel(MODERATION_TOPIC, (message) => {
    // Server-sent only, exactly as above: a guest forging this topic arrives
    // with `from` set and is ignored.
    if (message.from) return;
    try {
      const decoded = JSON.parse(new TextDecoder().decode(message.payload)) as {
        version: number;
        type: string;
        by: string;
      };
      if (decoded.version !== 1 || decoded.type !== 'audio.muted') return;
      // Belt and braces with the SFU mute: this also releases the capture, so
      // the browser's own recording indicator stops claiming a live mic.
      void localParticipant.setMicrophoneEnabled(false);
      setMutedBy(decoded.by || t('The host'));
    } catch {
      // Moderation must never interrupt media.
    }
  });

  // Unmuting clears it: being muted once is history, not a standing rule.
  useEffect(() => {
    if (isMicrophoneEnabled) setMutedBy(null);
  }, [isMicrophoneEnabled]);

  if (!mutedBy) return null;

  return (
    <StageBanner stopped icon={<MicMutedIcon />}>
      <span className="flex-1">{t('{name} muted you. Unmute when you need to speak.', { name: mutedBy })}</span>
      <Button type="button" variant="outline" size="sm" onClick={() => setMutedBy(null)}>
        {t('Dismiss')}
      </Button>
    </StageBanner>
  );
}

/**
 * Who is here, and how many of them are waiting to speak.
 *
 * The hand count rides on this button because the People panel is shut most of
 * the time: a badge on a tile answers "who", and this answers "is anybody
 * waiting" without the host opening anything. It is absent rather than zero —
 * a standing `0` beside a hand is furniture people stop seeing, which is
 * exactly the thing that must not happen to this one.
 */
/**
 * What a screen reader hears that a sighted person sees on the stage: who
 * came, who left, whose hand went up. One polite live region, one sentence
 * at a time; the first render is the baseline so joining does not read the
 * whole room aloud. People, not devices: a second tab of somebody present is
 * silent, the same fold `peopleRows` makes.
 */
function MeetingAnnouncer() {
  const remote = useRemoteParticipants();
  const hands = useRaisedHands();
  const [message, setMessage] = useState('');
  const seen = useRef<Map<string, string> | null>(null);
  const raised = useRef<Set<string> | null>(null);

  useEffect(() => {
    const now = new Map<string, string>();
    for (const participant of remote) {
      const key = personKey(participant.identity);
      if (!now.has(key)) now.set(key, participantDisplayName(participant));
    }
    const before = seen.current;
    seen.current = now;
    if (!before) return;
    const lines: string[] = [];
    for (const [key, name] of now) if (!before.has(key)) lines.push(`${name} joined`);
    for (const [key, name] of before) if (!now.has(key)) lines.push(`${name} left`);
    if (lines.length > 0) setMessage(lines.join('. '));
  }, [remote]);

  useEffect(() => {
    const now = new Set(hands.filter((hand) => !hand.isLocal).map((hand) => personKey(hand.identity)));
    const before = raised.current;
    raised.current = now;
    if (!before) return;
    const newly = hands.filter((hand) => !hand.isLocal && !before.has(personKey(hand.identity)));
    if (newly.length === 1 && newly[0]) setMessage(t('{newly} raised a hand', { newly: participantDisplayName(newly[0]) }));
    else if (newly.length > 1) setMessage(t('{newly} hands raised', { newly: newly.length }));
  }, [hands]);

  return <div className="sr-only" role="status" aria-live="polite">{message}</div>;
}

function PeopleButton({ people, showPeople, onToggle, buttonRef }: {
  people: number;
  showPeople: boolean;
  onToggle: () => void;
  buttonRef?: RefObject<HTMLButtonElement | null>;
}) {
  const hands = useRaisedHands();
  return (
    <ControlButton
      ref={buttonRef}
      icon={<MeetingPeopleIcon />}
      label={t('People')}
      aria-pressed={showPeople}
      onClick={onToggle}
    >
      <span className="absolute top-1 right-[5px] inline-flex items-center gap-0.5">
        <span className={cn(CONTROL_BADGE, 'bg-[rgb(var(--muted-rgb)/0.22)]')} aria-label={participantLabel(people)}>{people}</span>
        {hands.length > 0 && (
          // Accent, not the count's grey: this is the one number on the bar
          // that asks for something. Absent rather than 0, so it never
          // becomes furniture.
          <span
            className={cn(CONTROL_BADGE, 'gap-[3px] bg-[color-mix(in_srgb,var(--accent)_30%,transparent)] text-foreground [&_svg]:size-[11px]')}
            aria-label={handLabel(hands.length)}
          >
            <HandIcon raised />
            {hands.length}
          </span>
        )}
      </span>
    </ControlButton>
  );
}

function handLabel(count: number): string {
  return plural(count, { one: '{count} hand raised', other: '{count} hands raised' });
}

/** No microphone glyph ships with the components package; this is the one. */
function MicMutedIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M11 5V4a3 3 0 0 0-5.9-.7l1.6 1.6V4a1.3 1.3 0 0 1 2.6 0v3l1.7 1.7c0-.2 0-.4 0-.7V5Z" />
      <path d="M8 11.3A3.3 3.3 0 0 1 4.7 8H3.3a4.7 4.7 0 0 0 4 4.6V14h1.4v-1.4c.5-.1 1-.2 1.4-.4l-1-1a3.3 3.3 0 0 1-1.1.1Z" />
      <path d="M5 8V6.4l3.4 3.4A2 2 0 0 1 5 8Z" />
      <path d="M2.5 2.2 1.6 3.1l10.9 10.9.9-.9L2.5 2.2Z" />
    </svg>
  );
}

/**
 * Mic, camera, background, share, hide-self — the Mac app's control order,
 * left-aligned under the stage. Chat and settings sit on the far right because
 * they open panels rather than change what you publish. Device selection stays
 * in Settings; the toolbar only exposes the reliable mute/camera toggles.
 */
function MeetingControls({
  initialEffect,
  selfHidden,
  onShowSelf,
  onReact,
  peopleCount: people,
  showPeople,
  onTogglePeople,
  peopleButton,
  writeHand,
  hasScreenShare,
  screenShareLayout,
  onScreenShareLayoutChange,
  onLeave,
}: {
  initialEffect: BackgroundEffectChoice;
  onLeave?: () => void;
  selfHidden: boolean;
  onShowSelf: () => void;
  onReact: (emoji: ReactionEmoji) => void;
  peopleCount: number;
  showPeople: boolean;
  onTogglePeople: () => void;
  peopleButton?: RefObject<HTMLButtonElement | null>;
  writeHand: (raised: boolean) => Promise<void>;
  hasScreenShare: boolean;
  screenShareLayout: ScreenShareLayoutChoice;
  onScreenShareLayoutChange: (choice: ScreenShareLayoutChoice) => void;
}) {
  const layoutContext = useMaybeLayoutContext();
  // After joining, the keyboard is on the first control rather than nowhere
  //. Once: a re-render must not steal focus from a panel.
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (document.activeElement && document.activeElement !== document.body) return;
    bar.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
  }, []);
  const unreadMessages = layoutContext?.widget.state?.unreadMessages ?? 0;
  // Keep toggle state and the microphone choice in the same persistent
  // choices store used by prejoin, so what you pick mid-call is what the next
  // join starts with.
  const {
    saveAudioInputEnabled,
    saveAudioInputDeviceId,
    saveVideoInputEnabled,
    saveVideoInputDeviceId,
  } = usePersistentUserChoices();

  return (
    // One row under the stage, left-aligned, as on the Mac. `relative z-1`
    // is load-bearing: the bar owns its band whatever the stage above it
    // overflows (issue #1). Under 760 wide the row centres and stays one row.
    <div
      className="relative z-1 flex flex-wrap items-stretch gap-2.5 border-t border-border bg-background px-6 py-2.5 max-[760px]:justify-center max-[760px]:gap-1.5 max-[760px]:px-3 max-[760px]:py-2"
      ref={bar}
    >
      <AudioMenu
        onEnabledChange={saveAudioInputEnabled}
        saveAudioInputDeviceId={saveAudioInputDeviceId}
      />
      <CameraMenu
        initialEffect={initialEffect}
        selfHidden={selfHidden}
        onShowSelf={onShowSelf}
        onEnabledChange={saveVideoInputEnabled}
        saveVideoInputDeviceId={saveVideoInputDeviceId}
      />
      {supportsScreenShare && <ScreenShareButton />}
      {hasScreenShare && (
        // shadcn: the meeting bar’s layout tile, the one bare select (docs/DESIGN.md)
        <label className="inline-flex min-h-16 min-w-28 flex-col justify-center gap-[3px] rounded-md border border-[rgb(var(--muted-rgb)/0.28)] bg-muted px-2.5 py-1.5 text-[11px] font-medium text-foreground hover-lift hover-edge max-[760px]:min-h-12 max-[760px]:min-w-0 max-[760px]:flex-row max-[760px]:items-center max-[760px]:gap-1 max-[760px]:px-[7px] max-[760px]:py-[5px]">
          <span>{t('Layout')}</span>
          <select
            className="min-h-[34px] w-full min-w-0 cursor-pointer appearance-none border-0 bg-transparent p-0 font-[inherit] text-inherit focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] max-[760px]:max-w-28"
            aria-label={t('Screen share layout')}
            value={screenShareLayout}
            onChange={(event) => onScreenShareLayoutChange(event.currentTarget.value as ScreenShareLayoutChoice)}
          >
            <option value="automatic">{t('Automatic')}</option>
            <option value="overlay">{t('Over the share')}</option>
            <option value="rail">{t('Beside or below')}</option>
          </select>
        </label>
      )}
      <ReactionControl onSend={onReact} writeHand={writeHand} />
      <div className="ml-auto flex items-center gap-2.5 max-[760px]:ml-0">
        <PeopleButton people={people} showPeople={showPeople} onToggle={onTogglePeople} buttonRef={peopleButton} />
        <ControlButton
          icon={<CallChatIcon className="m-1 size-4" />}
          label={t('Chat')}
          aria-pressed={layoutContext?.widget.state?.showChat ?? false}
          aria-label={
            unreadMessages > 0
              ? plural(unreadMessages, { one: t('Chat, {count} unread message'), other: t('Chat, {count} unread messages') })
              : t('Chat')
          }
          onClick={() => layoutContext?.widget.dispatch?.({ msg: 'toggle_chat' })}
        >
          {unreadMessages > 0 && (
            <Badge
              className="absolute -top-1.5 -right-1.5 h-[18px] min-w-[18px] rounded-full border-0 bg-foreground px-1 text-[11px] leading-[18px] font-semibold text-background ring-2 ring-background"
              aria-hidden="true"
            >
              {unreadMessages < 10 ? unreadMessages : '9+'}
            </Badge>
          )}
        </ControlButton>
        <ControlButton
          icon={<CallSettingsIcon className="m-1 size-4" />}
          label={t('Settings')}
          onClick={() => layoutContext?.widget.dispatch?.({ msg: 'toggle_settings' })}
        />
        {onLeave && <LeaveButton onLeave={onLeave} />}
      </div>
    </div>
  );
}

/**
 * LiveKit's toggle wiring for one local track, for a shadcn Button:
 * `aria-pressed`, pending, and the click that flips the track. LiveKit's
 * own button class stays behind. `onUserChange` hears only a click, not a
 * change the room made (a moderation mute), so what is saved for the next
 * join is what the person chose.
 */
function useUserTrackToggle(
  source: Track.Source.Microphone | Track.Source.Camera,
  onUserChange: (enabled: boolean) => void,
) {
  const onChange = useCallback((enabled: boolean, isUserInitiated: boolean) => {
    if (isUserInitiated) onUserChange(enabled);
  }, [onUserChange]);
  const { buttonProps, enabled } = useTrackToggle({ source, onChange });
  const { className: _liveKitClass, ...props } = buttonProps;
  return { props, enabled };
}

/** Share screen, with system audio, and the browser tab itself offered too. */
function ScreenShareButton() {
  const { buttonProps, enabled } = useTrackToggle({
    source: Track.Source.ScreenShare,
    captureOptions: { audio: true, selfBrowserSurface: 'include' },
  });
  const { className: _liveKitClass, ...props } = buttonProps;
  return (
    <ControlButton
      {...props}
      icon={enabled ? <ScreenShareStopIcon className="m-1 size-4" /> : <ScreenShareIcon className="m-1 size-4" />}
      label={t('Share screen')}
    />
  );
}

/**
 * Camera toggle with the initial background effect applied to the published
 * track. Device selection and background settings live in Settings; the
 * toolbar keeps the reliable camera toggle and a small recovery action when
 * the self-view has been hidden.
 */
/**
 * Mute, plus the chevron that picks where audio comes in and goes out. A
 * headset is a microphone and a speaker at once, so both lists sit behind the
 * one chevron — the Mac's mute chevron and the prejoin card do the same, and
 * Settings stays the long way round.
 *
 * The menu is a Popover (DeviceMenuContent) that portals out of the
 * ControlGroup, so the group's clipping cannot hide it.
 */
function AudioMenu({ onEnabledChange, saveAudioInputDeviceId }: {
  onEnabledChange: (enabled: boolean) => void;
  saveAudioInputDeviceId: (deviceId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [openSection, setOpenSection] = useState<'microphone' | 'speaker' | null>(null);
  const toggleSection = useCallback((id: string) => {
    setOpenSection((current) => (current === id ? null : (id as 'microphone' | 'speaker')));
  }, []);
  const room = useRoomContext();
  const speakerSupported = supportsAudioOutputSelection();
  const audioDevices = useMediaDevices({ kind: 'audioinput' });
  const speakerDevices = useMediaDevices({ kind: 'audiooutput' });
  const micLabel = activeDeviceLabel(audioDevices, room.getActiveDevice('audioinput'), t('Microphone'));
  const { props: microphone, enabled: micEnabled } = useUserTrackToggle(Track.Source.Microphone, onEnabledChange);
  const speakerLabel = activeDeviceLabel(speakerDevices, room.getActiveDevice('audiooutput'), t('Speaker'));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <ControlGroup>
          <GroupedControlButton
            {...microphone}
            icon={<CallMicIcon on={micEnabled} className="m-1 size-4" />}
            label={t('Microphone')}
          />
          <Tip label={t('Audio options')}>
            <PopoverTrigger asChild>
              <ControlMenuButton aria-label={t('Audio options')} />
            </PopoverTrigger>
          </Tip>
        </ControlGroup>
      </PopoverAnchor>
<DeviceMenuContent>
          <DeviceSection label={t('Microphone')} summary={micLabel} open={openSection === 'microphone'} onOpenChange={() => toggleSection('microphone')}>
            <DeviceList
              kind="audioinput"
              onActiveDeviceChange={(deviceId) => {
                saveAudioInputDeviceId(deviceId || 'default');
                setOpen(false);
              }}
            />
          </DeviceSection>
          {speakerSupported && (
            <>
              <Separator className="my-1" />
              <DeviceSection label={t('Speaker')} summary={speakerLabel} open={openSection === 'speaker'} onOpenChange={() => toggleSection('speaker')}>
                <DeviceList
                  kind="audiooutput"
                  onActiveDeviceChange={(deviceId) => {
                    saveMeetMediaPreferences({ audioOutputDeviceId: deviceId || 'default' });
                    applySpatialAudioOutput(deviceId || 'default');
                    setOpen(false);
                  }}
                />
              </DeviceSection>
            </>
          )}
        </DeviceMenuContent>
</Popover>
  );
}

/** The name of the device the room is using, or the kind when the browser has not said. */
function activeDeviceLabel(devices: MediaDeviceInfo[], activeId: string | undefined, fallback: string): string {
  const exact = activeId ? devices.find((device) => device.deviceId === activeId) : undefined;
  if (exact?.label) return exact.label;
  const preferred = devices.find((device) => device.deviceId === 'default') ?? devices[0];
  return preferred?.label || fallback;
}

/**
 * Camera, plus the chevron that picks which camera and what stands behind
 * you. The device list and the background effects are each a row that
 * expands, so the panel stays a menu and not a dump; the Mac's camera chevron
 * and the prejoin card carry the same two.
 */
function CameraMenu({ initialEffect, selfHidden, onShowSelf, onEnabledChange, saveVideoInputDeviceId }: {
  initialEffect: BackgroundEffectChoice;
  selfHidden: boolean;
  onShowSelf: () => void;
  onEnabledChange: (enabled: boolean) => void;
  saveVideoInputDeviceId: (deviceId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [openSection, setOpenSection] = useState<'camera' | 'background' | null>(null);
  const toggleSection = useCallback((id: string) => {
    setOpenSection((current) => (current === id ? null : (id as 'camera' | 'background')));
  }, []);
  const room = useRoomContext();
  const getTrack = useCallback(() => roomCameraTrack(room), [room]);
  const videoDevices = useMediaDevices({ kind: 'videoinput' });
  const camLabel = activeDeviceLabel(videoDevices, room.getActiveDevice('videoinput'), t('Camera'));
  const { props: camera, enabled: cameraEnabled } = useUserTrackToggle(Track.Source.Camera, onEnabledChange);
  const { choice, pending, error, change, setError } = useBackgroundEffect(getTrack);
  useCameraWatchdog(getTrack, setError);
  const appliedInitial = useRef(false);

  // Apply the prejoin choice once the published camera track is ready.
  useEffect(() => {
    if (appliedInitial.current) return;
    if (initialEffect.mode === 'none') {
      appliedInitial.current = true;
      return;
    }

    let cancelled = false;
    let attempts = 0;

    const tryApply = () => {
      const track = getTrack();
      if (!track) {
        if (attempts >= 40 || cancelled) return;
        attempts += 1;
        window.setTimeout(tryApply, 250);
        return;
      }
      appliedInitial.current = true;
      void applyBackgroundEffect(track, initialEffect).catch((reason) => {
        if (cancelled) return;
        setError(backgroundEffectErrorMessage(reason));
        setBackgroundEffectChoice();
      });
    };

    tryApply();
    return () => {
      cancelled = true;
    };
  }, [getTrack, initialEffect, setError]);

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverAnchor asChild>
          <ControlGroup>
            <GroupedControlButton
              {...camera}
              icon={<CallCameraIcon on={cameraEnabled} className="m-1 size-4" />}
              label={t('Camera')}
            />
            <Tip label={t('Camera options')}>
              <PopoverTrigger asChild>
                <ControlMenuButton aria-label={t('Camera options')} />
              </PopoverTrigger>
            </Tip>
          </ControlGroup>
        </PopoverAnchor>
<DeviceMenuContent>
            <DeviceSection label={t('Camera')} summary={camLabel} open={openSection === 'camera'} onOpenChange={() => toggleSection('camera')}>
              <DeviceList
                kind="videoinput"
                onActiveDeviceChange={(deviceId) => {
                  saveVideoInputDeviceId(deviceId || 'default');
                  setOpen(false);
                }}
              />
            </DeviceSection>
            <Separator className="my-1" />
            <DeviceSection label={t('Background')} summary={backgroundEffectSummary(choice)} open={openSection === 'background'} onOpenChange={() => toggleSection('background')}>
              <BackgroundEffectButtons
                choice={choice}
                pending={pending}
                error={error}
                onChange={(next) => void change(next)}
                onError={setError}
                clearable
              />
            </DeviceSection>
          </DeviceMenuContent>
</Popover>
      {selfHidden && (
        <ControlButton icon={<HideSelfIcon hidden />} label={t('Show me')} onClick={onShowSelf} />
      )}
    </>
  );
}

function HideSelfIcon({ hidden }: { hidden: boolean }) {
  // eye when hidden (Show me); eye.slash when visible (Hide me) — matches Mac SF Symbols.
  if (hidden) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path
          d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
        <circle cx="8" cy="8" r="2.1" fill="none" stroke="currentColor" strokeWidth="1.4" />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2.1" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M3 13.5 13 2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function CopyLinkIcon({ copied }: { copied: boolean }) {
  // doc.on.doc / checkmark — matches Mac SF Symbols on CopyableURLRow.
  if (copied) {
    return (
      <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path
          d="M3.5 8.5 6.5 11.5 12.5 4.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect
        x="5.5"
        y="5.5"
        width="7"
        height="8"
        rx="1.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path
        d="M3.5 10.5V3.7A1.2 1.2 0 0 1 4.7 2.5h5.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CopyableRoomURL({ roomSlug }: { roomSlug: string }) {
  const [copied, setCopied] = useState(false);
  const href = roomPermalink(roomSlug);
  const display = href.replace(/^https:\/\//u, '');

  async function copy() {
    try {
      await navigator.clipboard.writeText(href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard can be blocked; leave the visible URL for manual copy.
    }
  }

  return (
    <div className="mr-auto inline-flex min-w-0 items-center gap-2">
      <span className="text-xs text-[rgb(var(--muted-rgb)/0.68)] max-[640px]:hidden">{display}</span>
      <Tip label={copied ? t('Copied') : t('Copy link')}><Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className={cn('text-[rgb(var(--muted-rgb)/0.88)] hover:text-foreground', copied && 'text-foreground')}
        onClick={() => void copy()}
        aria-label={copied ? t('Copied') : t('Copy link')}
      >
        <CopyLinkIcon copied={copied} />
      </Button></Tip>
    </div>
  );
}

function MeetingDuration({ startedAtMs }: { startedAtMs?: number }) {
  const fallbackStart = useRef(Date.now());
  const startMs = startedAtMs ?? fallbackStart.current;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <span className={cn(TRANSCRIPT_META, 'flex-none tracking-[0.04em] tabular-nums')} aria-live="off">
      {formatMeetingDuration(now - startMs)}
    </span>
  );
}

const CONNECTION_LABEL: Record<ConnectionQuality, string> = {
  [ConnectionQuality.Excellent]: t('Excellent'),
  [ConnectionQuality.Good]: t('Good'),
  [ConnectionQuality.Poor]: t('Poor'),
  [ConnectionQuality.Lost]: t('Lost'),
  [ConnectionQuality.Unknown]: t('Measuring'),
};

function ConnectionReadout() {
  // The participant is explicit on purpose: this readout lives in the
  // transcript header, outside any participant context, and the hook throws
  // rather than defaulting when it cannot find one.
  const { localParticipant } = useLocalParticipant();
  const { quality } = useConnectionQualityIndicator({ participant: localParticipant });
  return (
    <span
      className={cn(
        TRANSCRIPT_META,
        (quality === ConnectionQuality.Poor || quality === ConnectionQuality.Lost) && 'text-destructive',
      )}
    >
      Connection · {CONNECTION_LABEL[quality] ?? t('Measuring')}
    </span>
  );
}

type CaptionSegment = {
  id: string;
  speaker_name: string;
  language: TranscriptLanguage;
  text: string;
  is_final: boolean;
};

function isTrustedCaptionPublisher(identity: string | undefined): boolean {
  if (!identity) return false;
  return isWorkspaceMemberEmail(identity) && !identity.toLowerCase().startsWith('guest:');
}

/**
 * The Mac's transcript panel, mirrored: the same meta line (participants,
 * connection, duration) over the captions the host Mac publishes. Nothing here
 * is recorded browser-side — these are the segments the owner already
 * finalized.
 *
 * Captions start collapsed: most calls do not need them on screen, and the
 * panel costs stage height on every laptop. The meta line stays — participants,
 * connection, and duration are meeting status, not transcript. Segments keep
 * arriving while collapsed, so expanding shows the recent ones immediately
 * rather than starting from an empty panel.
 */
function TranscriptPanel({ startedAtMs }: { startedAtMs?: number }) {
  const participants = useParticipants();
  const [segments, setSegments] = useState<CaptionSegment[]>([]);
  const [expanded, setExpanded] = useState(
    () => readStored(StorageKeys.transcriptPanel) === 'expanded',
  );
  // 500 lines scroll. The panel follows the newest line unless
  // the reader has scrolled up to reread, the same rule as a thread.
  const body = useRef<HTMLDivElement>(null);
  const followsLatest = useRef(true);
  useEffect(() => {
    const element = body.current;
    if (!element || !expanded || !followsLatest.current) return;
    element.scrollTop = element.scrollHeight;
  }, [segments, expanded]);

  function toggle() {
    setExpanded((current) => {
      const next = !current;
      writeStored(StorageKeys.transcriptPanel, next ? 'expanded' : 'collapsed');
      return next;
    });
  }

  useDataChannel(CAPTION_DATA_TOPIC, (message) => {
    if (!isTrustedCaptionPublisher(message.from?.identity)) return;
    try {
      const decoded = JSON.parse(new TextDecoder().decode(message.payload)) as {
        version: number;
        segment: CaptionSegment;
      };
      if (decoded.version !== 1 || !decoded.segment?.id) return;
      setSegments((current) => {
        const withoutPrevious = current.filter((segment) => segment.id !== decoded.segment.id);
        return [...withoutPrevious, decoded.segment].slice(-LIVE_TRANSCRIPT_HISTORY_LINES);
      });
    } catch {
      // Captions must never interrupt media.
    }
  });

  return (
    // The Mac's transcript panel: the meta line, then the captions. `relative
    // z-1` for the control bar's reason: the rows under the stage own their
    // band, so nothing on the stage paints into the transcript.
    <section className="relative z-1 flex flex-col gap-2 border-t border-border bg-[var(--surface-sunken)] px-6 pt-3 pb-4 max-[640px]:px-3">
      <header className="flex flex-wrap items-center gap-3">
        {/* The heading is the disclosure, so collapsing the captions costs no
            second button in a control row that is already full. */}
        <h2 className="m-0 text-sm font-semibold">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-ml-2 h-auto gap-1.5 px-2 py-1 font-semibold has-[>svg]:px-2"
            aria-expanded={expanded}
            aria-controls="transcript-body"
            onClick={toggle}
          >
            <DisclosureIcon expanded={expanded} />
            {t('Live transcript')}
          </Button>
        </h2>
        <span className={TRANSCRIPT_META}>{participantLabel(peopleCount(participants))}</span>
        <ConnectionReadout />
        <MeetingDuration startedAtMs={startedAtMs} />
      </header>
      <div
        ref={body}
        // `transcript-body` marks the captions as selectable text (styles.css).
        className={cn('transcript-body max-h-[22vh] min-h-11 gap-1.5 overflow-y-auto max-[640px]:max-h-[18vh]', expanded && 'grid')}
        id="transcript-body"
        hidden={!expanded}
        aria-live="polite"
        aria-label={t('Live captions')}
        onScroll={() => {
          const element = body.current;
          if (element) followsLatest.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
        }}
      >
        {segments.length === 0 ? (
          <p className="m-0 text-sm text-[rgb(var(--muted-rgb)/0.7)]">
            {t('Captions appear here once the host Mac has heard a full sentence.')}
          </p>
        ) : (
          segments.map((segment) => (
            <CaptionLine key={segment.id} speaker={segment.speaker_name} text={segment.text} final={segment.is_final} />
          ))
        )}
      </div>
    </section>
  );
}

function DisclosureIcon({ expanded }: { expanded: boolean }) {
  // chevron.right / chevron.down — matches the Mac disclosure triangle.
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      className={cn('size-2.5 flex-none transition-transform duration-150 ease-in-out', expanded && 'rotate-90')}
    >
      <path
        d="M5.5 3 10.5 8 5.5 13"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The transcript header's meta line: people, connection, duration. */
const TRANSCRIPT_META = 'text-xs text-[rgb(var(--muted-rgb)/0.85)]';

function participantLabel(count: number): string {
  return plural(count, { one: '{count} participant', other: '{count} participants' });
}

/** People, not connections: two devices of one person are one participant. */
function peopleCount(participants: { identity: string }[]): number {
  return new Set(participants.map((participant) => personKey(participant.identity))).size;
}

type PersonRow = {
  key: string;
  name: string;
  isYou: boolean;
  isHost: boolean;
  devices: number;
  microphoneOn: boolean;
  cameraOn: boolean;
  sharing: boolean;
  speaking: boolean;
  /** When their hand went up, or null. Null sorts last; see `peopleRows`. */
  handRaisedAt: number | null;
  recording: boolean;
  onBehalfOf: string | null;
  /** Let in by an event registration link, not by the host (docs/SESSIONS.md §7). */
  registered: boolean;
};

/**
 * One row per person, the same collapse `mergeDeviceTiles` does for the stage:
 * the owner on a Mac and a phone is one line that says "2 devices", with the
 * microphone counted on whichever device has it open.
 */
function peopleRows(
  participants: ReturnType<typeof useParticipants>,
  screenShares: TrackReferenceOrPlaceholder[],
): PersonRow[] {
  const sharing = new Set(screenShares.map((track) => personKey(track.participant.identity)));
  const rows = new Map<string, PersonRow>();
  for (const participant of participants) {
    const key = personKey(participant.identity);
    const existing = rows.get(key);
    if (existing) {
      existing.devices += 1;
      existing.isYou ||= participant.isLocal;
      existing.microphoneOn ||= participant.isMicrophoneEnabled;
      existing.cameraOn ||= participant.isCameraEnabled;
      existing.speaking ||= participant.isSpeaking;
      const consent = participantConsent(participant);
      existing.recording ||= consent.recording;
      existing.onBehalfOf ||= consent.onBehalfOf;
      existing.registered ||= consent.registered;
      // One person on two devices raised one hand: the earliest raise wins,
      // so a queue does not reorder itself when somebody opens a second tab.
      existing.handRaisedAt = earliestHand(existing.handRaisedAt, handOf(participant));
      existing.isHost ||= isHostDevice(participant);
      continue;
    }
    const consent = participantConsent(participant);
    rows.set(key, {
      key,
      name: participantDisplayName(participant),
      isYou: participant.isLocal,
      isHost: isHostDevice(participant),
      devices: 1,
      microphoneOn: participant.isMicrophoneEnabled,
      cameraOn: participant.isCameraEnabled,
      sharing: sharing.has(key),
      speaking: participant.isSpeaking,
      handRaisedAt: handOf(participant),
      recording: consent.recording,
      onBehalfOf: consent.onBehalfOf,
      registered: consent.registered,
    });
  }
  // You first, then the host, then everyone else by name — the order the Mac
  // rail and the iOS sheet already use.
  // Hands first, oldest raise at the top: with the panel open, the question
  // is who to go to next, and that is a queue rather than a roster. You and the
  // host keep their places among everyone else once no hand is up.
  return [...rows.values()].sort((a, b) => {
    if ((a.handRaisedAt !== null) !== (b.handRaisedAt !== null)) return a.handRaisedAt !== null ? -1 : 1;
    if (a.handRaisedAt !== null && b.handRaisedAt !== null) return a.handRaisedAt - b.handRaisedAt;
    if (a.isYou !== b.isYou) return a.isYou ? -1 : 1;
    if (a.isHost !== b.isHost) return a.isHost ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** The device that hosts carries the Worker's `host` attribute. */
function isHostDevice(participant: { attributes?: Record<string, string> }): boolean {
  return participant.attributes?.[HOST_ATTRIBUTE] === '1';
}

function participantConsent(participant: { metadata?: string }): { recording: boolean; onBehalfOf: string | null; registered: boolean } {
  if (!participant.metadata) return { recording: false, onBehalfOf: null, registered: false };
  try {
    const metadata = JSON.parse(participant.metadata) as { recording?: unknown; on_behalf_of?: unknown; registered?: unknown };
    return {
      recording: metadata.recording === true,
      onBehalfOf: typeof metadata.on_behalf_of === 'string' ? metadata.on_behalf_of : null,
      registered: metadata.registered === true,
    };
  } catch {
    return { recording: false, onBehalfOf: null, registered: false };
  }
}

/** This device's hand, ignoring one left up long enough to be forgotten. */
function handOf(participant: { attributes?: Record<string, string> }): number | null {
  const at = handRaisedAt(participant.attributes?.[HAND_ATTRIBUTE]);
  return at !== null && Date.now() - at < HAND_STALE_AFTER_MS ? at : null;
}

function earliestHand(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

/**
 * **People** — who is in this meeting. Read-only on the web: admit, mute and
 * remove stay with the device that hosts, so the panel names people and
 * says what each one is doing, nothing more. Floats where Chat does; one
 * panel at a time is a stage problem, not a rule, so both may be open.
 */
function PeoplePanel({ participants, screenShares, onClose }: {
  participants: ReturnType<typeof useParticipants>;
  screenShares: TrackReferenceOrPlaceholder[];
  onClose: () => void;
}) {
  const rows = useMemo(() => peopleRows(participants, screenShares), [participants, screenShares]);
  // The panel takes the keyboard when it opens and gives it back on Escape,
  // so it behaves like the dialog it is.
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);
  return (
    // Floats where Chat does. A second panel is a stage problem, not a rule,
    // so the two may sit side by side.
    <Card
      role="complementary"
      aria-label={t('People in this meeting')}
      className="absolute right-6 bottom-4 z-4 max-h-[min(480px,calc(100%-32px))] min-h-0 w-[min(320px,calc(100%-32px))] gap-0 overflow-hidden rounded-[14px] bg-[color-mix(in_srgb,var(--surface-sunken)_92%,transparent)] py-0 shadow-[0_18px_40px_rgba(0,0,0,0.45)] backdrop-blur-[18px] duration-150 animate-in fade-in-0 slide-in-from-bottom-2 motion-reduce:animate-none"
    >
      <header className="flex items-center justify-between gap-3 border-b px-3.5 pt-3 pb-2.5">
        <h2 className="m-0 flex items-baseline gap-2 text-sm font-semibold">
          {t('People')} <span className="text-xs font-medium text-muted-foreground">{rows.length}</span>
        </h2>
        <Button ref={close} type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={onClose}>
          {t('Close')}
        </Button>
      </header>
      <ItemGroup className="overflow-auto py-1.5">
        {rows.map((row) => (
          <Item key={row.key} role="listitem" size="sm" className="flex-nowrap gap-3 rounded-none px-3.5 py-2 text-[13px]">
            <ItemMedia>
              <IdentityAvatar email={row.key} name={row.name} avatarUpdatedAt={null} />
            </ItemMedia>
            <ItemContent className="min-w-0">
              {/* Whoever the SFU scores as talking, in the accent the tile ring uses. */}
              <ItemTitle className={cn('w-auto flex-wrap items-baseline gap-1.5 font-normal', row.speaking && 'text-[var(--accent-mark)]')}>
                {row.name}
                {row.isYou && <small className={PEOPLE_TAG}>{t('You')}</small>}
                {row.isHost && <small className={PEOPLE_TAG}>{t('Host')}</small>}
                {row.devices > 1 && <small className={PEOPLE_TAG}>{row.devices} devices</small>}
                {row.registered && <small className={PEOPLE_TAG}>{t('Registered')}</small>}
                {row.recording && <small className={PEOPLE_TAG} title={row.onBehalfOf ? t('Sent by {person}', { person: row.onBehalfOf }) : undefined}>{t('Recording')}{row.onBehalfOf ? ` · ${t('Sent by {person}', { person: row.onBehalfOf })}` : ''}</small>}
              </ItemTitle>
            </ItemContent>
            <ItemActions className="text-muted-foreground">
              {row.handRaisedAt !== null && (
                // The accent the bar's hand count uses, so a queue reads the same here.
                <span className="text-[var(--accent-mark)]" title={t('Hand raised')}><HandIcon raised /></span>
              )}
              {row.sharing && <span title={t('Sharing their screen')}><ScreenShareIcon /></span>}
              <span
                className={cn(!row.microphoneOn && PEOPLE_OFF)}
                title={row.microphoneOn ? t('Microphone on') : t('Microphone off')}
              >
                <MicIcon on={row.microphoneOn} />
              </span>
              <span
                className={cn(!row.cameraOn && PEOPLE_OFF)}
                title={row.cameraOn ? t('Camera on') : t('Camera off')}
              >
                <CameraIcon on={row.cameraOn} />
              </span>
            </ItemActions>
          </Item>
        ))}
      </ItemGroup>
    </Card>
  );
}

const PEOPLE_TAG = 'text-[11px] text-muted-foreground';
const PEOPLE_OFF = 'text-[rgb(var(--muted-rgb)/0.5)]';

