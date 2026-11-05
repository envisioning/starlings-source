import { Tip } from './Tip';
import { useCallback, useRef, useState } from 'react';
import {
  REACTION_DATA_TOPIC,
  REACTION_EMOJI,
  REACTION_FLIGHT_JITTER_MS,
  REACTION_FLIGHT_MS,
  REACTION_MAX_ONSCREEN,
  REACTION_MIN_INTERVAL_MS,
  type ReactionEmoji,
} from '@starlings/contracts/reactions';
import { useDataChannel, useLocalParticipant } from '@livekit/components-react';
import { participantDisplayName } from './MeetParticipantTile';
import { ReactionIcon, ReactionSymbol, reactionLabel } from './action-icons';
import { HandIcon, useOwnHand } from './meeting-hands';
import { ControlButton, pressedClass } from './meeting-control';
import { Button } from '@/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import { Separator } from '@/ui/separator';
import { t } from './i18n';

/** One emoji in flight. Everything random about it is decided once, at birth. */
interface Floater {
  key: number;
  emoji: ReactionEmoji;
  /** Who sent it. Captions the emoji all the way up. */
  sender: string;
  /** Viewport position to launch from, as a percentage. */
  left: number;
  /** Horizontal drift over the flight, in viewport width percent. */
  drift: number;
  /** Tilt, in degrees. */
  rotate: number;
  scale: number;
  durationMs: number;
}

let nextFloaterKey = 0;

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function makeFloater(emoji: ReactionEmoji, sender: string): Floater {
  return {
    key: (nextFloaterKey += 1),
    emoji,
    sender,
    // Launch across the middle of the screen rather than the full width, so
    // emoji do not graze the window edges on the way up.
    left: randomBetween(12, 88),
    drift: randomBetween(-6, 6),
    rotate: randomBetween(-18, 18),
    scale: randomBetween(0.85, 1.2),
    durationMs: REACTION_FLIGHT_MS + randomBetween(0, REACTION_FLIGHT_JITTER_MS),
  };
}

/**
 * Send and receive reactions on `reactions.v1`.
 *
 * Reactions are fire-and-forget: published lossy, never acknowledged, never
 * stored. The sender's own emoji is added locally because LiveKit does not echo
 * data back to its publisher.
 */
export function useMeetingReactions() {
  const { localParticipant } = useLocalParticipant();
  const [floaters, setFloaters] = useState<Floater[]>([]);
  const lastSentAt = useRef(0);

  const add = useCallback((emoji: ReactionEmoji, sender: string) => {
    setFloaters((current) => {
      const next = current.length >= REACTION_MAX_ONSCREEN
        ? current.slice(current.length - REACTION_MAX_ONSCREEN + 1)
        : current;
      return [...next, makeFloater(emoji, sender)];
    });
  }, []);

  const remove = useCallback((key: number) => {
    setFloaters((current) => current.filter((floater) => floater.key !== key));
  }, []);

  useDataChannel(REACTION_DATA_TOPIC, (message) => {
    // Sender-published, so unlike moderation a packet without `from` is the
    // odd one out — and it is also the whole of the attribution, since the
    // payload carries no name that a guest could put someone else's on.
    if (!message.from) return;
    try {
      const decoded = JSON.parse(new TextDecoder().decode(message.payload)) as {
        version?: number;
        emoji?: string;
      };
      if (decoded.version !== 1) return;
      const emoji = REACTION_EMOJI.find((candidate) => candidate === decoded.emoji);
      if (!emoji) return;
      add(emoji, participantDisplayName(message.from));
    } catch {
      // A malformed reaction is not worth a line in the console, let alone a
      // notice — the meeting is unaffected.
    }
  });

  const send = useCallback((emoji: ReactionEmoji) => {
    const now = Date.now();
    if (now - lastSentAt.current < REACTION_MIN_INTERVAL_MS) return;
    lastSentAt.current = now;
    // Captioned with the same name everyone else's copy will carry, rather
    // than a "you" only this screen would show.
    add(emoji, participantDisplayName(localParticipant));
    const payload = new TextEncoder().encode(JSON.stringify({ version: 1, emoji }));
    // Lossy: a dropped reaction is a non-event, and reliable delivery would
    // queue them up to arrive in a clump after a bad network moment.
    void localParticipant.publishData(payload, {
      topic: REACTION_DATA_TOPIC,
      reliable: false,
    });
  }, [add, localParticipant]);

  return { floaters, send, remove };
}

/**
 * The emoji themselves, flying bottom-to-top across the whole window, each
 * captioned with whoever sent it.
 *
 * Fixed to the viewport rather than parented to the stage: a reaction is a
 * reaction to the meeting, not to one tile, and crossing the full height is
 * what makes it read as celebratory rather than as a badge.
 *
 * Still `aria-hidden`, names and all: forty emoji crossing a screen is a mood,
 * not a transcript, and reading each one out would bury everything else a
 * screen reader has to say about the meeting.
 */
/* SVG strokes have no text outline. Four zero-blur shadows draw the
   opposite-ink keyline without changing the symbol's shape. */
const REACTION_KEYLINE = {
  filter: [
    'drop-shadow(1px 0 0 var(--reaction-outline))',
    'drop-shadow(-1px 0 0 var(--reaction-outline))',
    'drop-shadow(0 1px 0 var(--reaction-outline))',
    'drop-shadow(0 -1px 0 var(--reaction-outline))',
  ].join(' '),
};

export function ReactionOverlay({ floaters, onDone }: {
  floaters: Floater[];
  onDone: (key: number) => void;
}) {
  return (
    // Fixed to the viewport, not the stage: a reaction is aimed at the
    // meeting, and the full-height climb reads as a cheer, not a badge.
    <div className="pointer-events-none fixed inset-0 z-30 overflow-hidden" aria-hidden="true">
      {floaters.map((floater) => (
        <span
          key={floater.key}
          // Centred on its launch point: the keyframes carry the -50%. With
          // reduced motion it holds still near the bottom and fades.
          className="absolute -bottom-20 flex flex-col items-center gap-[3px] leading-none select-none will-change-[transform,opacity] animate-[reaction-rise_var(--reaction-duration,2600ms)_ease-out_forwards] motion-reduce:bottom-24 motion-reduce:animate-[reaction-hold_1600ms_ease-out_forwards]"
          style={{
            left: `${floater.left}%`,
            '--reaction-drift': `${floater.drift}vw`,
            '--reaction-rotate': `${floater.rotate}deg`,
            '--reaction-scale': floater.scale,
            '--reaction-duration': `${floater.durationMs}ms`,
          } as React.CSSProperties}
          // Nothing inside animates, so this only ever fires for the flight.
          onAnimationEnd={() => onDone(floater.key)}
        >
          <span className="inline-flex leading-none text-[var(--reaction-foreground)]" style={REACTION_KEYLINE}>
            <ReactionSymbol emoji={floater.emoji} size={120} />
          </span>
          {floater.sender && (
            // The name crosses the video, so it carries its own contrast.
            <span className="max-w-[14ch] truncate rounded-full bg-[rgba(11,11,11,0.62)] px-2 py-[3px] text-xs font-semibold text-[var(--on-media)]">
              {floater.sender}
            </span>
          )}
        </span>
      ))}
    </div>
  );
}

/**
 * The palette, as buttons, for the control row under the stage — plus your
 * own raised hand.
 *
 * Raise hand lives in this tray rather than as its own toolbar button because
 * it answers the same need reactions do, from two directions: both are ways
 * of saying something without taking the floor. It gets its own slot ahead of
 * a divider because, unlike a reaction, it persists — the button reflects
 * whether your hand is actually up, not just what was last clicked.
 */
export function ReactionControl({ onSend, writeHand }: {
  onSend: (emoji: ReactionEmoji) => void;
  writeHand: (raised: boolean) => Promise<void>;
}) {
  // A Popover: click-away and Escape close it, and Escape hands focus back
  // to the React button.
  const { raised, busy, error, toggle } = useOwnHand(writeHand);
  const handLabel = error || (raised
    ? t('Lower your hand')
    : t('Raise your hand — it stays up until you lower it'));

  return (
    <Popover>
      <PopoverTrigger asChild>
        <ControlButton icon={<ReactionIcon />} label={t('React')}>
          {raised && (
            <span className="absolute top-1 right-[5px] inline-flex text-[var(--accent-mark)] [&_svg]:size-3.5" aria-label={t('Hand raised')}>
              <HandIcon raised />
            </span>
          )}
        </ControlButton>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        className="flex w-auto items-center gap-1 p-1.5"
        role="group"
        aria-label={t('Send a reaction or raise your hand')}
      >
        <Tip label={handLabel}>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={pressedClass}
            aria-pressed={raised}
            aria-label={handLabel}
            disabled={busy}
            onClick={() => void toggle()}
          >
            <HandIcon raised={raised} />
          </Button>
        </Tip>
        <Separator orientation="vertical" className="mx-0.5 data-[orientation=vertical]:h-6" />
        {REACTION_EMOJI.map((emoji) => (
          <Button
            key={emoji}
            type="button"
            variant="ghost"
            size="icon"
            className="active:scale-[0.92] [&_svg:not([class*='size-'])]:size-6"
            aria-label={t('React with {emoji}', { emoji: reactionLabel(emoji) })}
            // The tray stays open: reacting twice is the normal case.
            onClick={() => onSend(emoji)}
          >
            <ReactionSymbol emoji={emoji} size={24} />
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
