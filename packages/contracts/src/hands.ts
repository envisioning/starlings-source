// Raised hands. Zod-free so browsers can import the key and the grammar
// without pulling schema code into the bundle, the same way `reactions.ts`
// keeps its topic and palette importable.

/**
 * The LiveKit participant attribute a raised hand lives in.
 *
 * An attribute rather than a data topic, because a hand is **state**, not an
 * event. A reaction flies across the screen and is gone, so a data topic
 * suits it: a client that joined late has simply missed it. A hand stays up
 * until it is lowered, and the host's actual question is "who has one up right
 * now" — which a topic cannot answer for anyone who joined, reconnected, or
 * refreshed after the hand went up. Attributes sync to everyone including late
 * joiners, and survive a reconnect for free.
 *
 * Mirrored by `Sources/MeetingHands.swift` for the Mac and iOS clients.
 */
export const HAND_ATTRIBUTE = 'hand';

/**
 * The other attribute the Worker writes: `'1'` on the device that hosts (it
 * admits guests and takes the notes), cleared when it stops. Every
 * client reads it for the Host badge. Mirrored by `HostAttribute` in
 * `Sources/ContractsExtensions.swift`.
 */
export const HOST_ATTRIBUTE = 'host';

/**
 * When the hand went up, as epoch milliseconds in a decimal string, because
 * LiveKit attribute values are strings.
 *
 * A timestamp rather than `"true"` so the host gets the queue in the order
 * people actually raised, without a second channel to carry order in. Lowered
 * is the empty string rather than a `"false"`: LiveKit treats an empty value as
 * cleared, so "lowered" and "never raised" are the same state, which is what
 * they are.
 */
export const HAND_LOWERED = '';

/** Serialize a raise. Exported so all three clients agree on the format. */
export function handRaisedValue(atMs: number = Date.now()): string {
  return String(Math.floor(atMs));
}

/**
 * When this hand went up, or null if it is down.
 *
 * Tolerant on purpose: the value crosses a wire and is written by the control
 * plane, but a client reading a value it cannot parse should treat the hand as
 * down rather than throw inside a render. A hand that fails to draw is a
 * missed question; a render that throws is a broken meeting.
 */
export function handRaisedAt(value: string | undefined | null): number | null {
  if (!value) return null;
  const at = Number.parseInt(value, 10);
  if (!Number.isFinite(at) || at <= 0) return null;
  return at;
}

/** Whether this participant's attributes say their hand is up. */
export function isHandRaised(attributes: Record<string, string> | undefined): boolean {
  return handRaisedAt(attributes?.[HAND_ATTRIBUTE]) !== null;
}

/**
 * Longest a hand stays up on its own.
 *
 * Not a rule the server enforces — nothing lowers a hand behind somebody's
 * back — but the point past which a client stops counting one in the host's
 * badge. A hand left up for an hour is somebody who forgot, and a queue that
 * remembers it forever is a queue the host stops trusting.
 */
export const HAND_STALE_AFTER_MS = 60 * 60 * 1000;
