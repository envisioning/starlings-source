// In-meeting emoji reactions. Zod-free so browsers can import the topic and the
// palette without pulling schema code into the bundle; `index.ts` builds the
// validating schema on top of these.

/**
 * Ephemeral LiveKit data topic for emoji reactions. Published by any
 * participant, rendered as a short animation, and stored nowhere — a reaction
 * that lands after the moment has passed is worse than none, so these go out
 * lossy and unbuffered, and a client that joins late has simply missed them.
 *
 * Every reaction is captioned with whoever sent it, and that name comes from
 * the publishing participant rather than from the packet: the payload below
 * has nowhere to put someone else's name, so attribution is as forgeable as
 * the identity LiveKit issued — which is to say not.
 */
export const REACTION_DATA_TOPIC = 'reactions.v1';

/**
 * The whole palette, on every client.
 *
 * A fixed list rather than free-form text on purpose: guests may publish data
 * for ordinary features like chat, and an open string field on a topic every
 * client renders in a large font across the meeting would be a broadcast
 * channel with no composer, no history, and no attribution. An enum can only
 * ever animate one of four pictures.
 *
 * Four, and the same four as the chat quick row: thumbs up, heart,
 * laugh, celebrate. Applause and mind-blown went — applause said nothing
 * thumbs up did not, and every client draws these as icons, not glyphs
 * (AGENTS.md invariant 25), so a palette is a set of icons somebody has to
 * be able to tell apart at a glance.
 *
 * The web quick-reaction menu reads this list; the generator writes the
 * Swift `MeetingReaction` from it (`Sources/Generated/ReactionsRegistry.swift`).
 */
export const REACTION_EMOJI = ['👍', '❤️', '😂', '🎉'] as const;

export type ReactionEmoji = (typeof REACTION_EMOJI)[number];

/**
 * What each reaction is called, for menus, tooltips and icon-only controls.
 * The retired ones are still on stored messages, so they keep a
 * name; anything else reads as a custom reaction.
 */
export const REACTION_LABELS: Record<ReactionEmoji, string> = {
  '👍': 'Thumbs up',
  '❤️': 'Heart',
  '😂': 'Laugh',
  '🎉': 'Celebrate',
};
export const RETIRED_REACTION_LABELS: Record<string, string> = {
  '👏': 'Applause',
  '🤯': 'Mind blown',
  '👀': 'Eyes',
  '🙏': 'Thanks',
};
export const CUSTOM_REACTION_LABEL = 'Custom reaction';

/** Per-sender floor between reactions, so one participant cannot fill a screen. */
export const REACTION_MIN_INTERVAL_MS = 350;

/** How long one emoji takes to cross the viewport, and the jitter around it. */
export const REACTION_FLIGHT_MS = 2600;
export const REACTION_FLIGHT_JITTER_MS = 600;

/** Ceiling on simultaneously animating emoji, whoever sent them. */
export const REACTION_MAX_ONSCREEN = 40;
