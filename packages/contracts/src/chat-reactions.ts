import { z } from 'zod';
// Reactions on in-meeting chat messages. Zod-free, like `reactions.ts`, so a
// browser can import the topic and the palette without pulling schema code
// into the bundle.

import { REACTION_EMOJI, type ReactionEmoji } from './reactions';

/**
 * A reaction on one chat message, on its own LiveKit data topic.
 *
 * **Why not the room's existing `reactions.v1`.** That one is a moment: an
 * emoji flies up the screen and is gone, so it goes out lossy and a client that
 * missed it has missed nothing. A reaction on a message is *state* — it stays
 * on the message until it is taken off — so it goes out reliable, and a client
 * that dropped one would show a tally that is quietly wrong for the rest of the
 * meeting.
 *
 * **Why not a participant attribute, the way a raised hand is.** A hand is one
 * bit per person; this is one bit per person *per message*, and the message
 * list is unbounded. More to the point, in-meeting chat is not replayed to
 * anyone who joins late — they never see the message, so there is nothing for
 * them to be missing a tally on. The reactions live exactly as long as the
 * messages do, which is the whole meeting for the people who were there.
 *
 * Attribution comes from the publishing participant, never from the payload:
 * there is nowhere in it to put somebody else's name.
 */
export const CHAT_REACTION_DATA_TOPIC = 'chat-reactions.v1';

/**
 * The same four as the flying reactions.
 *
 * One palette, for the same reason that one is a fixed list: an open string
 * field on a topic every client renders is a broadcast channel with no
 * composer. And a second, different set of emoji in the same meeting would be
 * a thing to learn rather than a thing to use.
 *
 * The native clients read the same palette through the generated `MeetingReaction`.
 */
export const CHAT_REACTION_EMOJI = REACTION_EMOJI;
export type ChatReactionEmoji = ReactionEmoji;

/** Per-sender floor between toggles, so a held key cannot flood the topic. */
export const CHAT_REACTION_MIN_INTERVAL_MS = 120;

/**
 * How many distinct emoji one person may have on one message.
 *
 * Not a limit anybody will meet by hand — four is the whole palette — but the
 * receiver applies what it is told, and a sender that stopped following the
 * rules should not be able to grow another client's map without bound.
 */
export const CHAT_REACTION_MAX_PER_MESSAGE = REACTION_EMOJI.length;

/** The wire body. `on` is false when the reaction is being taken off again. */
export const chatReactionPacketSchema = z.object({
  version: z.literal(1),
  /** The chat message the reaction is on. */
  message_id: z.string(),
  emoji: z.enum(CHAT_REACTION_EMOJI),
  /** True to add, false to take back. */
  on: z.boolean(),
});
export type ChatReactionPacket = z.infer<typeof chatReactionPacketSchema>;

/**
 * A packet, or null for anything this client should not act on.
 *
 * Everything about the shape is checked here rather than at the call site: a
 * data topic is the one place a guest's bytes reach every other client, so
 * "unrecognized" and "malformed" have to end the same way — ignored, silently,
 * with the meeting unaffected.
 *
 * Takes the JSON rather than the bytes, and `writeChatReaction` returns it:
 * this package is the contract for what a packet *says*, and every client
 * already has its own way to turn that into bytes. It also keeps `TextEncoder`
 * out of a module that compiles for both a browser and a Worker.
 */
export function readChatReaction(json: string): ChatReactionPacket | null {
  try {
    const decoded = JSON.parse(json) as Partial<ChatReactionPacket>;
    if (decoded.version !== 1) return null;
    if (typeof decoded.message_id !== 'string' || decoded.message_id === '') return null;
    // A message id is a LiveKit stream id; anything long enough to be a payload
    // in its own right is not one, and would be a way to grow every client's map.
    if (decoded.message_id.length > 128) return null;
    if (typeof decoded.on !== 'boolean') return null;
    const emoji = CHAT_REACTION_EMOJI.find((candidate) => candidate === decoded.emoji);
    if (!emoji) return null;
    return { version: 1, message_id: decoded.message_id, emoji, on: decoded.on };
  } catch {
    return null;
  }
}

export function writeChatReaction(packet: Omit<ChatReactionPacket, 'version'>): string {
  return JSON.stringify({ version: 1, ...packet } satisfies ChatReactionPacket);
}

/**
 * Who has which emoji on which message, and the two moves that change it.
 *
 * Kept as identities rather than counts so a toggle is idempotent: the same
 * packet twice — a redelivery, or a client that lost track — leaves the tally
 * where it was, which a bare number could not do.
 */
export type ChatReactionTally = Map<string, Map<ChatReactionEmoji, Set<string>>>;

export function applyChatReaction(
  tally: ChatReactionTally,
  identity: string,
  packet: ChatReactionPacket,
): ChatReactionTally {
  const next: ChatReactionTally = new Map(tally);
  const byEmoji = new Map(next.get(packet.message_id) ?? []);
  const reactors = new Set(byEmoji.get(packet.emoji) ?? []);

  if (packet.on) {
    if (!byEmoji.has(packet.emoji) && byEmoji.size >= CHAT_REACTION_MAX_PER_MESSAGE) return tally;
    reactors.add(identity);
  } else {
    reactors.delete(identity);
  }

  // An emoji nobody has is not an empty pill, it is no pill — and a message
  // nobody reacted to should not keep a row in the map for the rest of the call.
  if (reactors.size === 0) byEmoji.delete(packet.emoji);
  else byEmoji.set(packet.emoji, reactors);
  if (byEmoji.size === 0) next.delete(packet.message_id);
  else next.set(packet.message_id, byEmoji);
  return next;
}
