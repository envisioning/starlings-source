import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { useDataChannel, useLocalParticipant, useParticipants } from '@livekit/components-react';
import {
  CHAT_REACTION_DATA_TOPIC,
  CHAT_REACTION_EMOJI,
  CHAT_REACTION_MIN_INTERVAL_MS,
  applyChatReaction,
  readChatReaction,
  writeChatReaction,
  type ChatReactionEmoji,
  type ChatReactionTally,
} from '@starlings/contracts/chat-reactions';
import { Button } from '@/ui/button';
import { cn } from '@/lib/utils';
import { participantDisplayName } from './MeetParticipantTile';
import { ReactionSymbol, reactionLabel } from './action-icons';
import { t } from './i18n';

/**
 * Reactions on in-meeting chat messages.
 *
 * A reaction on a message is state, not a moment: it stays on the message
 * until it is taken off, so it travels reliably on its own topic rather than
 * lossy alongside the emoji that fly up the screen. The reasoning, and why
 * this is not a participant attribute the way a raised hand is, lives in
 * `packages/contracts/src/chat-reactions.ts`.
 *
 * The tally lives in a context above the stage, not in the chat panel: the
 * data-channel subscription must run for the whole call, and one
 * subscription serves every row (meeting-chat.tsx).
 */

interface ChatReactions {
  tally: ChatReactionTally;
  /** The local participant's identity, which is what "mine" means on a pill. */
  me: string;
  /** Display names for a set of identities, for the pill's tooltip. */
  namesOf: (identities: Set<string>) => string[];
  toggle: (messageID: string, emoji: ChatReactionEmoji) => void;
}

const ChatReactionContext = createContext<ChatReactions | null>(null);

export function ChatReactionsProvider({ children }: { children: React.ReactNode }) {
  const { localParticipant } = useLocalParticipant();
  const participants = useParticipants();
  const [tally, setTally] = useState<ChatReactionTally>(() => new Map());
  const lastSentAt = useRef(0);

  useDataChannel(CHAT_REACTION_DATA_TOPIC, (message) => {
    // Sender-published, and the payload has nowhere to put somebody else's
    // name — so `from` is the whole of the attribution, and a packet without
    // one is a packet with no reactor.
    if (!message.from) return;
    const packet = readChatReaction(new TextDecoder().decode(message.payload));
    if (!packet) return;
    const identity = message.from.identity;
    setTally((current) => applyChatReaction(current, identity, packet));
  });

  const me = localParticipant.identity;

  const namesOf = useCallback((identities: Set<string>) => {
    const byIdentity = new Map(participants.map((one) => [one.identity, one]));
    return [...identities].map((identity) => {
      if (identity === me) return 'You';
      const participant = byIdentity.get(identity);
      return participant ? participantDisplayName(participant) : identity;
    });
  }, [participants, me]);

  const toggle = useCallback((messageID: string, emoji: ChatReactionEmoji) => {
    const now = Date.now();
    if (now - lastSentAt.current < CHAT_REACTION_MIN_INTERVAL_MS) return;
    lastSentAt.current = now;
    // Read from the map rather than from a local flag: the pill draws what the
    // map says, so deciding the direction anywhere else would let the two
    // disagree after a packet crossed with a click.
    const on = !(tally.get(messageID)?.get(emoji)?.has(me) ?? false);
    const packet = { message_id: messageID, emoji, on };
    // LiveKit does not echo data to its publisher, so the sender applies its
    // own toggle — the same way its own chat message is added locally.
    setTally((current) => applyChatReaction(current, me, { version: 1, ...packet }));
    void localParticipant.publishData(new TextEncoder().encode(writeChatReaction(packet)), {
      topic: CHAT_REACTION_DATA_TOPIC,
      // Reliable, unlike a flying reaction: a dropped packet here would leave
      // one screen showing a tally that stays wrong for the rest of the call.
      reliable: true,
    });
  }, [tally, me, localParticipant]);

  const value = useMemo<ChatReactions>(
    () => ({ tally, me, namesOf, toggle }),
    [tally, me, namesOf, toggle],
  );
  return <ChatReactionContext.Provider value={value}>{children}</ChatReactionContext.Provider>;
}


/*
 * A pill: shadcn Button, round. Mine is tinted in the accent. The add
 * button stays faint until its row is hovered or holds focus (a "+" under
 * every message at full contrast reads as more chrome than chat); nothing
 * hovers on a phone, so there it is always shown.
 */
const pillClass =
  'h-auto gap-1 rounded-full border border-transparent bg-[color:var(--control-fill)] px-1.5 py-px text-[0.85em] leading-snug font-normal text-muted-foreground hover-lift';
const minePillClass =
  'aria-pressed:border-[color-mix(in_srgb,var(--accent)_60%,transparent)] aria-pressed:bg-[color:color-mix(in_srgb,var(--accent)_18%,transparent)] aria-pressed:text-foreground';
const addPillClass =
  'opacity-0 transition-opacity group-hover/entry:opacity-100 group-focus-within/entry:opacity-100 aria-expanded:opacity-100 [@media(hover:none)]:opacity-100';

/**
 * The pills under one chat message, and the way to add one.
 *
 * Drawn as nothing at all when nobody has reacted and the picker is shut: a
 * row of six grey emoji under every message would be more chrome than chat.
 * The palette opens inline in the row, not floating over it: the list
 * scrolls and clips, so a floating palette on the top message was cut in half.
 */
export function ChatMessageReactions({ messageID }: { messageID: string }) {
  const reactions = useContext(ChatReactionContext);
  const [picking, setPicking] = useState(false);
  if (!reactions) return null;
  const { tally, me, toggle } = reactions;
  const onThisMessage = tally.get(messageID);

  return (
    <span className="relative flex flex-wrap items-center gap-1">
      {[...(onThisMessage?.entries() ?? [])].map(([emoji, reactors]) => {
        const mine = reactors.has(me);
        return (
          <Button
            key={emoji}
            type="button"
            variant={null}
            size={null}
            className={cn(pillClass, minePillClass)}
            aria-pressed={mine}
            onClick={() => toggle(messageID, emoji)}
          >
            <ReactionSymbol emoji={emoji} size={14} />
            <span className="tabular-nums">{reactors.size}</span>
          </Button>
        );
      })}
      <Button
        type="button"
        variant={null}
        size={null}
        className={cn(pillClass, addPillClass)}
        aria-expanded={picking}
        aria-label={t('React to this message')}
        onClick={() => setPicking((open) => !open)}
      >
        <ReactionSymbol emoji="" size={14} />
      </Button>
      {picking && (
        <span
          className="inline-flex gap-0.5 rounded-full border bg-[var(--surface-raised)] px-1 py-0.5"
          role="group"
          aria-label={t('Reactions')}
        >
          {CHAT_REACTION_EMOJI.map((emoji) => (
            <Button
              key={emoji}
              type="button"
              variant="ghost"
              size="icon-xs"
              className="rounded-full"
              aria-label={reactionLabel(emoji)}
              onClick={() => { toggle(messageID, emoji); setPicking(false); }}
            >
              <ReactionSymbol emoji={emoji} size={16} />
            </Button>
          ))}
        </span>
      )}
    </span>
  );
}
