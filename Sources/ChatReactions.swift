import Foundation

/// Reactions on in-meeting chat messages, mirroring
/// `packages/contracts/src/chat-reactions.ts`.
///
/// A reaction on a message is **state**, unlike the emoji that fly up the
/// screen: it stays on the message until it is taken off. So it travels on its
/// own topic, reliably — a dropped packet would leave one client showing a
/// tally that is quietly wrong for the rest of the call, which a lossy topic
/// makes likely rather than possible.
///
/// It is not a participant attribute the way a raised hand is, for two
/// reasons. A hand is one bit per person; this is one bit per person *per
/// message*, and the message list is unbounded. And in-meeting chat is not
/// replayed to anyone who joins late — they never see the message, so there is
/// nothing for them to be missing a tally on. Reactions live exactly as long
/// as the messages do.
///
/// Nothing here reaches the control plane: a chat reaction is not in the
/// meeting record, the transcript, or the summary.
enum ChatReaction {
    /// `CHAT_REACTION_DATA_TOPIC`.
    static let topic = ContractConstants.chatReactionDataTopic

    // `minimumInterval` is `CHAT_REACTION_MIN_INTERVAL_MS` (Generated/ReactionsRegistry.swift).

    /// How many distinct emoji one person may put on one message. Not a limit
    /// anybody meets by hand — four is the whole palette — but a receiver
    /// applies what it is told, and a sender that stopped following the rules
    /// should not be able to grow another client's map without bound.
    static let maximumPerMessage = MeetingReaction.allCases.count

    /// The palette, which is the room's palette. A second, different set of
    /// emoji in the same meeting would be a thing to learn rather than a thing
    /// to use.
    static let emoji = MeetingReaction.allCases
}

/// Wire body for `chat-reactions.v1` — the same JSON the browser publishes.
/// One reaction on one chat message, as the data topic carries it: the
/// generated `ChatReactionPacket`. `emoji` is the palette entry's own string.
typealias ChatReactionMessage = ChatReactionPacket

extension ChatReactionPacket {
    init(messageID: String, reaction: MeetingReaction, on: Bool) {
        self.init(version: 1, messageID: messageID, emoji: reaction.rawValue, on: on)
    }

    /// The palette entry, or nil for a packet this build will not vouch for:
    /// a version it does not speak, an empty or oversized message id, or an
    /// emoji it does not draw. Malformed and unrecognized end the same way,
    /// or the difference becomes something to probe on a topic any guest can
    /// publish to.
    var reaction: MeetingReaction? {
        guard version == 1, !messageID.isEmpty, messageID.count <= 128 else { return nil }
        return MeetingReaction(rawValue: emoji)
    }
}

/// Who has which emoji on which message.
///
/// Identities rather than counts, so a toggle is idempotent: the same packet
/// twice — a redelivery, or a client that lost track — leaves the tally where
/// it was, which a bare number could not do.
struct ChatReactionTally: Equatable, Sendable {
    private var byMessage: [String: [MeetingReaction: Set<String>]] = [:]

    init() {}

    /// The emoji on one message, in the palette's own order so two clients
    /// showing the same message show the same row.
    func reactions(on messageID: String) -> [ChatReactionCount] {
        guard let onMessage = byMessage[messageID] else { return [] }
        return ChatReaction.emoji.compactMap { reaction in
            guard let reactors = onMessage[reaction], !reactors.isEmpty else { return nil }
            return ChatReactionCount(reaction: reaction, reactors: reactors)
        }
    }

    func isEmpty(on messageID: String) -> Bool {
        byMessage[messageID] == nil
    }

    func contains(_ identity: String, reaction: MeetingReaction, on messageID: String) -> Bool {
        byMessage[messageID]?[reaction]?.contains(identity) ?? false
    }

    /// Apply one packet. Returns whether anything actually changed, so a client
    /// can skip a redraw it does not need.
    @discardableResult
    mutating func apply(_ packet: ChatReactionMessage, from identity: String) -> Bool {
        guard let reaction = packet.reaction else { return false }
        var onMessage = byMessage[packet.messageID] ?? [:]
        if packet.on, onMessage[reaction] == nil, onMessage.count >= ChatReaction.maximumPerMessage {
            return false
        }
        var reactors = onMessage[reaction] ?? []
        let before = reactors
        if packet.on { reactors.insert(identity) } else { reactors.remove(identity) }
        guard reactors != before else { return false }

        // An emoji nobody has is not an empty pill, it is no pill — and a
        // message nobody reacted to should not keep a row for the rest of the
        // call.
        if reactors.isEmpty { onMessage.removeValue(forKey: reaction) } else { onMessage[reaction] = reactors }
        if onMessage.isEmpty { byMessage.removeValue(forKey: packet.messageID) } else { byMessage[packet.messageID] = onMessage }
        return true
    }
}

/// One emoji on one message, and everybody who put it there.
///
/// A named type rather than a tuple because SwiftUI lists want an identity,
/// and the emoji is one: a message never carries the same emoji twice.
struct ChatReactionCount: Identifiable, Equatable, Sendable {
    let reaction: MeetingReaction
    let reactors: Set<String>

    var id: MeetingReaction { reaction }
    var count: Int { reactors.count }
}
