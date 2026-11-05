import { describe, expect, it } from 'vitest';
import {
  CHAT_REACTION_EMOJI,
  applyChatReaction,
  readChatReaction,
  writeChatReaction,
  type ChatReactionTally,
} from '@starlings/contracts/chat-reactions';

/**
 * Reactions on in-meeting chat travel on a data topic, which means every
 * client applies bytes any participant can publish. Two properties matter:
 * nothing outside the shape gets applied at all, and applying the same packet
 * twice leaves the tally exactly where it was — that is what makes the toggle
 * survive a redelivery or a client that lost track.
 *
 * `Sources/ChatReactions.swift` mirrors this; the tests are here because this
 * is where the contract lives.
 */

const [thumbsUp, party] = CHAT_REACTION_EMOJI;
const empty = (): ChatReactionTally => new Map();

function reactorsOn(tally: ChatReactionTally, messageID: string, emoji: string): string[] {
  return [...(tally.get(messageID)?.get(emoji as never) ?? [])];
}

describe('what a client will act on', () => {
  it('round-trips a packet it wrote itself', () => {
    expect(readChatReaction(writeChatReaction({ message_id: 'TX_1', emoji: thumbsUp!, on: true }))).toEqual({
      version: 1, message_id: 'TX_1', emoji: thumbsUp, on: true,
    });
  });

  it('drops everything it cannot vouch for, without distinguishing why', () => {
    // A topic any guest can publish on: malformed and unrecognized have to end
    // the same way, or the difference becomes something to probe.
    const bad = [
      '',
      'not json',
      JSON.stringify({ version: 2, message_id: 'TX_1', emoji: thumbsUp, on: true }),
      JSON.stringify({ version: 1, message_id: '', emoji: thumbsUp, on: true }),
      JSON.stringify({ version: 1, emoji: thumbsUp, on: true }),
      JSON.stringify({ version: 1, message_id: 'TX_1', emoji: '🦆', on: true }),
      JSON.stringify({ version: 1, message_id: 'TX_1', emoji: thumbsUp, on: 'yes' }),
      // A message id long enough to be a payload of its own is not a stream id,
      // and would be a way to grow every client's map.
      JSON.stringify({ version: 1, message_id: 'x'.repeat(129), emoji: thumbsUp, on: true }),
    ];
    for (const raw of bad) {
      expect(readChatReaction(raw), raw.slice(0, 40)).toBeNull();
    }
  });
});

describe('the tally', () => {
  const on = (emoji: string) => ({ version: 1 as const, message_id: 'TX_1', emoji: emoji as never, on: true });
  const off = (emoji: string) => ({ ...on(emoji), on: false });

  it('counts people, not packets', () => {
    let tally = empty();
    tally = applyChatReaction(tally, 'rosa', on(thumbsUp!));
    tally = applyChatReaction(tally, 'rosa', on(thumbsUp!));
    tally = applyChatReaction(tally, 'ada', on(thumbsUp!));
    expect(reactorsOn(tally, 'TX_1', thumbsUp!).sort()).toEqual(['ada', 'rosa']);
  });

  it('takes one person off without taking the pill away from everyone', () => {
    let tally = empty();
    tally = applyChatReaction(tally, 'rosa', on(thumbsUp!));
    tally = applyChatReaction(tally, 'ada', on(thumbsUp!));
    tally = applyChatReaction(tally, 'rosa', off(thumbsUp!));
    expect(reactorsOn(tally, 'TX_1', thumbsUp!)).toEqual(['ada']);
  });

  it('forgets an emoji nobody has, and a message nobody reacted to', () => {
    // An emoji with no reactors is not an empty pill, it is no pill — and a
    // map that keeps a row per message for the rest of the call grows for the
    // rest of the call.
    let tally = empty();
    tally = applyChatReaction(tally, 'rosa', on(party!));
    tally = applyChatReaction(tally, 'rosa', off(party!));
    expect(tally.has('TX_1')).toBe(false);
  });

  it('is a no-op for taking off what was never on', () => {
    const tally = applyChatReaction(empty(), 'rosa', off(thumbsUp!));
    expect(tally.size).toBe(0);
  });

  it('refuses to grow past the palette on one message', () => {
    // The palette is the ceiling by construction, so this only bites a sender
    // that stopped following the rules — which is exactly who it is for.
    let tally = empty();
    for (const emoji of CHAT_REACTION_EMOJI) {
      tally = applyChatReaction(tally, 'rosa', on(emoji));
    }
    expect(tally.get('TX_1')?.size).toBe(CHAT_REACTION_EMOJI.length);
    const overflowing = applyChatReaction(tally, 'rosa', on('🦆'));
    expect(overflowing.get('TX_1')?.size).toBe(CHAT_REACTION_EMOJI.length);
  });
});
