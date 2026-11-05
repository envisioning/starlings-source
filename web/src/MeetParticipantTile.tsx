import { Tip } from './Tip';
import { participantInitials } from './participant-initials';
import { useCallback, useContext } from 'react';
import { ConnectionQuality, Track } from 'livekit-client';
import {
  AudioTrack,
  ConnectionQualityIndicator,
  ParticipantName,
  TrackMutedIndicator,
  VideoTrack,
  isTrackReference,
  useEnsureTrackRef,
  useFeatureContext,
  useIsEncrypted,
  useMaybeLayoutContext,
  useConnectionQualityIndicator,
  useParticipantTile,
  type ParticipantTileProps,
  type TrackReferenceOrPlaceholder,
} from '@livekit/components-react';
import { CallLockIcon, ScreenShareIcon } from './action-icons';
import { isLocalCameraTile, personKey, SelfDockContext, useFaceCenteredCamera } from './stage-layout';
import { TileHandBadge } from './meeting-hands';
import { Button } from '@/ui/button';
import { cn } from '@/lib/utils';
import { PLATE, TILE, TILE_SHARE, TILE_SPEAKING } from './meeting-control';
import { t } from './i18n';

/**
 * One tile on the stage: LiveKit's tile state (`useParticipantTile`) in Meet's
 * own frame. No shadcn video tile exists, so the frame is a Meet
 * shape on theme tokens. The camera-off placeholder is this person's initials
 * in a circle instead of the library's anonymous silhouette — the same
 * treatment the Mac app's tiles use.
 *
 * The placeholder is an opaque layer shown while the publisher's camera is
 * muted, so a muted camera covers the last decoded frame rather than freezing
 * on it. That is true for your own tile and everyone else's: mute state is the
 * publisher's, not a local guess.
 *
 * LiveKit's own `ParticipantTile` also draws an unlabeled expand control.
 * The stage has no pin (a share takes focus on its own), so this tile leaves
 * it out.
 */
export type MeetParticipantTileProps = Omit<ParticipantTileProps, 'children'> & {
  /** Keep small screen-share rail thumbnails visually clear, without removing their accessible status. */
  compactInShareRail?: boolean;
};

function participantConsent(participant: { metadata?: string }): { recording: boolean; onBehalfOf: string | null } {
  if (!participant.metadata) return { recording: false, onBehalfOf: null };
  try {
    const metadata = JSON.parse(participant.metadata) as { recording?: unknown; on_behalf_of?: unknown };
    return {
      recording: metadata.recording === true,
      onBehalfOf: typeof metadata.on_behalf_of === 'string' ? metadata.on_behalf_of : null,
    };
  } catch {
    return { recording: false, onBehalfOf: null };
  }
}

export function MeetParticipantTile({
  trackRef,
  compactInShareRail = false,
  className,
  onParticipantClick,
  disableSpeakingIndicator,
  ...props
}: MeetParticipantTileProps) {
  const tile = useEnsureTrackRef(trackRef);
  const isShare = tile.source === Track.Source.ScreenShare;
  const isEncrypted = useIsEncrypted(tile.participant);
  const consent = participantConsent(tile.participant);
  const autoManageSubscription = useFeatureContext()?.autoSubscription;
  const layoutContext = useMaybeLayoutContext();
  const { quality } = useConnectionQualityIndicator({ participant: tile.participant });
  const isCamera = isTrackReference(tile) && tile.source === Track.Source.Camera;
  const faceCenteredCamera = useFaceCenteredCamera(isCamera);
  // Only the docked self tile gets this: the context is set while it is in
  // the grid and null otherwise (stage-layout.ts).
  const floatSelf = useContext(SelfDockContext);
  const undock = floatSelf && isLocalCameraTile(tile) ? floatSelf : null;

  // Dropping a subscription pulls the rug out from under the focused share,
  // so release the focus rather than keep a track that stopped arriving.
  const handleSubscribe = useCallback(
    (subscribed: boolean) => {
      if (subscribed || !layoutContext?.pin.dispatch) return;
      if (layoutContext.pin.state?.some((pinned) => isSameTrack(tile, pinned))) {
        layoutContext.pin.dispatch({ msg: 'clear_pin' });
      }
    },
    [tile, layoutContext],
  );

  const { elementProps } = useParticipantTile<HTMLDivElement>({
    trackRef: tile,
    onParticipantClick,
    disableSpeakingIndicator,
    htmlProps: props,
  });
  const state = elementProps as Record<string, unknown>;
  const speaking = state['data-lk-speaking'] === true;
  const videoMuted = state['data-lk-video-muted'] === true;
  const mirrored = tile.participant.isLocal && isCamera && state['data-lk-facing-mode'] === 'user';

  return (
    <div
      {...elementProps}
      className={cn(TILE, isShare ? TILE_SHARE : speaking && TILE_SPEAKING, className)}
      // Spatial audio reads where this person's face is from the DOM
      // (`spatial-audio.tsx`). A share has no voice; the local tile is the
      // listener.
      data-meet-person={
        tile.source === Track.Source.Camera && !tile.participant.isLocal
          ? personKey(tile.participant.identity)
          : undefined
      }
    >
      {isTrackReference(tile) && (
        tile.publication?.kind === 'video'
        || tile.source === Track.Source.Camera
        || tile.source === Track.Source.ScreenShare
      ) ? (
        <VideoTrack
          trackRef={tile}
          ref={isCamera ? faceCenteredCamera.videoRef : undefined}
          className={cn(
            // Cover by default; a portrait frame and a share fit whole.
            'size-full bg-black object-cover object-center data-[lk-orientation=portrait]:object-contain',
            isShare && 'bg-[var(--surface-raised)] object-contain',
            // The face anchor drifts `object-position`; ease it, not jump.
            isCamera && 'transition-[object-position] duration-[450ms] ease-in-out motion-reduce:transition-none',
            mirrored && '-scale-x-100',
          )}
          style={isCamera ? { objectPosition: faceCenteredCamera.objectPosition } : undefined}
          onSubscriptionStatusChanged={handleSubscribe}
          manageSubscription={autoManageSubscription}
        />
      ) : (
        isTrackReference(tile) && (
          <AudioTrack trackRef={tile} onSubscriptionStatusChanged={handleSubscribe} />
        )
      )}
      <div
        className={cn(
          'pointer-events-none absolute inset-0 flex items-center justify-center rounded-[8px] bg-background opacity-0 transition-opacity duration-200 ease-in-out',
          videoMuted && tile.source === Track.Source.Camera && 'opacity-100',
        )}
      >
        <ParticipantAvatar name={participantDisplayName(tile.participant)} />
      </div>
      {/* A hand is state, so it rides on the tile for as long as it is up —
          see meeting-hands.tsx. Not on a share: a screen has no hand. */}
      {!isShare && (
        <TileHandBadge participant={tile.participant} />
      )}
      <div className="absolute right-1 bottom-1 left-1 flex items-center justify-between gap-2 leading-none" data-tile-meta>
        {tile.source === Track.Source.Camera ? (
          <div className={PLATE}>
            {isEncrypted && <CallLockIcon style={{ marginRight: '0.25rem' }} />}
            <TrackMutedIndicator
              trackRef={{ participant: tile.participant, source: Track.Source.Microphone }}
              show="muted"
              className="relative me-1 size-4 opacity-50"
            />
            <ParticipantName participant={tile.participant} className={cn('text-sm', compactInShareRail && 'sr-only')} />
          </div>
        ) : (
          // "<Name>'s screen", in the same ring as the tile, answers "whose
          // screen is this?" in one glance.
          <div className={cn(PLATE, 'border border-solid border-[rgb(var(--ink-rgb)/0.6)] [&_svg]:fill-current')}>
            <ScreenShareIcon style={{ marginRight: '0.25rem' }} />
            <ParticipantName participant={tile.participant} className="text-sm">{t('’s screen')}</ParticipantName>
          </div>
        )}
        {consent.recording && tile.source === Track.Source.Camera && (
          <span
            className="mt-1 inline-flex items-center gap-[5px] rounded-[4px] bg-[rgba(29,29,29,0.9)] px-1.5 py-[3px] text-[11px] font-[650] text-destructive [&_svg]:size-3"
            title={consent.onBehalfOf ? t('Recording · sent by {person}', { person: consent.onBehalfOf }) : t('Recording notetaker')}
            aria-label={consent.onBehalfOf ? t('Recording · sent by {person}', { person: consent.onBehalfOf }) : t('Recording notetaker')}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5" fill="currentColor" /></svg>
            {t('Recording')}
          </span>
        )}
      </div>
      {undock && (
        // The docked self tile's one control: float again. Shown on hover or
        // focus, as on the floating tile (MeetingExperience.tsx).
        <div className="absolute top-1.5 right-1.5 z-1 flex gap-1 opacity-0 transition-opacity duration-150 group-[:hover]/tile:opacity-100 focus-within:opacity-100">
          <Tip label={t('Float — lift your tile back over the stage')}><Button
            type="button"
            variant="ghost"
            className="size-[22px] rounded-full bg-black/45 p-0 text-white hover:text-white [&_svg:not([class*='size-'])]:size-3"
            aria-label={t('Float — lift your tile back over the stage')}
            onClick={(event) => { event.stopPropagation(); undock(); }}
          >
            <FloatIcon />
          </Button></Tip>
        </div>
      )}
      {/* Bottom-right, inside the frame, the full state in its label. It
          shows on hover, and on its own when the link is poor or lost. */}
      <ConnectionQualityIndicator
        className={cn(
          'pointer-events-none absolute right-2 bottom-2 z-2 flex size-6 items-center justify-center rounded-[6px] bg-black/68 p-1 text-[var(--on-media)] opacity-0 transition-opacity duration-200 group-[:hover]/tile:opacity-100 [&_svg]:size-4',
          (quality === ConnectionQuality.Poor || quality === ConnectionQuality.Lost) && 'text-destructive opacity-100',
          compactInShareRail && '!opacity-0',
        )}
        participant={tile.participant}
        aria-label={t('Connection quality: {quality}', { quality: connectionQualityLabel(quality) })}
        title={t('Connection quality: {quality}', { quality: connectionQualityLabel(quality) })}
      />
    </div>
  );
}

function connectionQualityLabel(quality: ConnectionQuality): string {
  switch (quality) {
    case ConnectionQuality.Excellent: return 'Excellent';
    case ConnectionQuality.Good: return 'Good';
    case ConnectionQuality.Poor: return 'Poor';
    case ConnectionQuality.Lost: return 'Lost';
    default: return t('Measuring');
  }
}

/**
 * Initials in a circle, sized by the tile through the SVG viewBox. The name is
 * already announced by `ParticipantName` in the tile metadata, so this is
 * decoration as far as assistive tech is concerned.
 */
function ParticipantAvatar({ name }: { name: string }) {
  return (
    // Sized by the tile through the viewBox, so the circle and the initials
    // scale together from a rail thumbnail to a full-stage tile.
    <svg className="h-[46%] max-h-32 w-auto max-w-[46%]" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <circle cx="50" cy="50" r="49" className="fill-[var(--surface-raised)] stroke-[rgb(var(--veil-rgb)/0.14)]" strokeWidth={1.5} />
      <text
        x="50"
        y="50"
        dy=".35em"
        textAnchor="middle"
        className="fill-foreground text-[34px] font-semibold tracking-[0.02em]"
      >
        {participantInitials(name)}
      </text>
    </svg>
  );
}

/** Track references are recreated on every render, so compare by identity. */
export function isSameTrack(
  a: TrackReferenceOrPlaceholder,
  b: TrackReferenceOrPlaceholder | undefined,
): boolean {
  if (!b) return false;
  if (a.participant.identity !== b.participant.identity) return false;
  if (a.source !== b.source) return false;
  return a.publication?.trackSid === b.publication?.trackSid;
}

/**
 * Guest identities are opaque (`guest:<token>`); never show the prefix.
 *
 * Structural rather than `Participant`-typed so a local and a remote
 * participant reach it the same way — tiles, reactions, and anything else that
 * has to name somebody label them identically.
 */
export function participantDisplayName(
  participant: { name?: string; identity: string },
): string {
  const name = participant.name?.trim();
  if (name) return name;
  return participant.identity.replace(/^guest:/u, '');
}

export { participantInitials } from './participant-initials';

/** A frame with a small square lifted out of it: this tile floats again. */
function FloatIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path d="M2 4v6h6" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 2h5v5H5z" fill="currentColor" />
    </svg>
  );
}
