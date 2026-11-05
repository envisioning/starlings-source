import { useCallback, useState } from 'react';
import {
  useLocalParticipant,
  useParticipantAttribute,
  useParticipants,
} from '@livekit/components-react';
import type { Participant } from 'livekit-client';
import { HAND_ATTRIBUTE, HAND_STALE_AFTER_MS, handRaisedAt } from '@starlings/contracts/hands';
import { apiFetch } from './api';
import { t } from './i18n';

/**
 * Raising a hand, and seeing who has one up.
 *
 * A hand is **state**, unlike a reaction: a reaction flies across the screen
 * and is gone, so `meeting-reactions.tsx` sends it lossy on a data topic and a
 * late joiner has simply missed it. A hand stays up until it is lowered, and
 * the host's real question is "who has one up *right now*" — which a topic
 * cannot answer for anybody who joined, refreshed or reconnected after it went
 * up. So it lives in a LiveKit participant attribute, which syncs to everyone
 * including late joiners and survives a reconnect for free.
 *
 * The browser does not write that attribute. LiveKit gates every self-service
 * attribute write behind one grant, `canUpdateOwnMetadata`, and this app keeps
 * it shut so a guest cannot rewrite the `owner` stamped
 * into their metadata at mint. So the hand goes up through the control plane,
 * which already knows who is asking and writes the attribute with an admin
 * grant. See `services/control-plane/src/livekit.ts`.
 */

/** How a guest asks. The meeting's own token says who they are. */
export function handWriter(roomSlug: string, meetingID: string, artifactToken: string) {
  return async (raised: boolean) => {
    await apiFetch(
      `/rooms/${encodeURIComponent(roomSlug)}/meetings/${encodeURIComponent(meetingID)}/hand`,
      {
        method: 'POST',
        body: { raised },
        token: artifactToken,
        fallbackError: raised ? t('Couldn’t raise your hand.') : t('Couldn’t lower your hand.'),
      },
    );
  };
}

/**
 * A hand left up for an hour is somebody who forgot, not somebody waiting.
 * Counting it would leave the host with a queue that never empties and a badge
 * they learn to ignore.
 */
function isCurrentlyRaised(participant: Participant): boolean {
  const at = handRaisedAt(participant.attributes?.[HAND_ATTRIBUTE]);
  return at !== null && Date.now() - at < HAND_STALE_AFTER_MS;
}

/** Whether this one participant's hand is up, live. */
export function useHandRaised(participant: Participant): boolean {
  const value = useParticipantAttribute(HAND_ATTRIBUTE, { participant });
  const at = handRaisedAt(value);
  return at !== null && Date.now() - at < HAND_STALE_AFTER_MS;
}

/**
 * Everyone with a hand up, oldest raise first.
 *
 * The order is the whole reason a raise carries a timestamp rather than a
 * `"true"`: a queue that answers people in the order they asked needs no second
 * channel to carry that in.
 */
export function useRaisedHands(): Participant[] {
  const participants = useParticipants();
  return participants
    .filter(isCurrentlyRaised)
    .sort((left, right) => {
      const a = handRaisedAt(left.attributes?.[HAND_ATTRIBUTE]) ?? 0;
      const b = handRaisedAt(right.attributes?.[HAND_ATTRIBUTE]) ?? 0;
      return a - b;
    });
}

/**
 * Your own hand, and the control that toggles it.
 *
 * The button reflects what the room actually says rather than what was last
 * clicked: the attribute is the truth, so a raise that the control plane
 * refused leaves the button down, and a host lowering every hand puts this one
 * down too without the browser being told separately.
 */
export function useOwnHand(write: (raised: boolean) => Promise<void>) {
  const { localParticipant } = useLocalParticipant();
  const raised = useHandRaised(localParticipant);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const toggle = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      await write(!raised);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t change your hand.'));
    } finally {
      setBusy(false);
    }
  }, [write, raised]);

  return { raised, busy, error, toggle };
}

/**
 * The glyph, on the control, the tile badge and the People pill.
 *
 * Always upright. The first version tipped the hand on its side for the lowered
 * state, on the theory that two states should differ in silhouette — but a hand
 * lying on its side does not read as "lowered", it reads as an icon that failed
 * to load straight. The state is already carried by `aria-pressed` on the
 * button, by the word beside it, and by the badge simply not being drawn.
 *
 * `raised` still selects a treatment, because the badge on a tile wants a solid
 * shape and a control that is off wants a lighter one — but the geometry is the
 * same drawing either way, which is the whole point.
 */
export function HandIcon({ raised }: { raised?: boolean }) {
  // Fingers open, wrist at the bottom. One path, drawn filled when the hand is
  // up and outlined when it is not.
  const hand = 'M7.3 1.5a.8.8 0 0 1 1.6 0v5h.6V2.6a.8.8 0 0 1 1.6 0v4.3h.6V4.2a.8.8 0 0 1 1.6 0v5.3c0 2.5-1.8 4.5-4.3 4.5-1.5 0-2.6-.6-3.4-1.7L3 9.2a.9.9 0 0 1 1.4-1.1l1.3 1.5V3a.8.8 0 0 1 1.6 0v3.5h.6Z';
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d={hand}
        fill={raised ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth={raised ? 0 : 1.2}
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * The badge on a raised hand's tile.
 *
 * A badge answers "who", which is the thing a host is looking at the stage to
 * find out. The count beside the People button answers "is anyone waiting"
 * while the panel is shut — the two together are what make a hand visible
 * whether or not that person's tile is on screen.
 */
export function TileHandBadge({ participant }: { participant: Participant }) {
  const raised = useHandRaised(participant);
  if (!raised) return null;
  return (
    // Top-left: the one corner of a tile nothing else claims. Above the video
    // and below the name plate, so a raised hand stays legible.
    <div
      className="absolute top-1 left-1 z-2 flex size-[26px] items-center justify-center rounded-full bg-[var(--accent)] text-[var(--on-accent)] shadow-[0_2px_8px_rgb(0_0_0/35%)]"
      role="img"
      aria-label={t('Hand raised')}
      data-tile-hand
    >
      <HandIcon raised />
    </div>
  );
}
