import Foundation

/// In-call chat message shared with the browser LiveKit Components chat prefab.
struct MeetingChatMessage: Equatable, Identifiable, Sendable {
    /// LiveKit Components text-stream topic (`DataTopic.CHAT`).
    static let topic = "lk.chat"
    /// Legacy data-packet topic still published by the web client for older peers.
    static let legacyTopic = "lk-chat-topic"

    let id: String
    let timestamp: Date
    let text: String
    let senderIdentity: String
    let senderName: String
    let isLocal: Bool

    /// Diagnostic dumps are data to copy, not authored conversation. Keep the
    /// marker in one place so the Mac never turns their headings and URLs into
    /// chat formatting.
    var isDebugReport: Bool {
        Self.isDebugReport(text)
    }

    static func isDebugReport(_ text: String) -> Bool {
        text.hasPrefix("Starlings web debug report\n") || text.hasPrefix("Starlings Mac debug report\n")
    }
}

/// The in-room chat has no server-side read receipt: unread is local state for
/// the live session. Keeping the comparison here gives native surfaces the
/// same rule — only newly arrived messages from somebody else count, never a
/// local echo or a repeated published value.
enum MeetingChatUnread {
    static func newlyReceivedRemoteMessageCount(
        previous: [MeetingChatMessage],
        current: [MeetingChatMessage]
    ) -> Int {
        let previousIDs = Set(previous.map(\.id))
        return current.reduce(into: 0) { count, message in
            if !message.isLocal, !previousIDs.contains(message.id) {
                count += 1
            }
        }
    }
}

/// Wire body for `lk-chat-topic` packets — same JSON shape LiveKit Components encodes.
struct LegacyChatWireMessage: Codable, Equatable, Sendable {
    let id: String
    let timestamp: Int64
    let message: String
    /// When true, receivers that already consume `lk.chat` text streams should ignore this packet.
    let ignoreLegacy: Bool?

    enum CodingKeys: String, CodingKey {
        case id
        case timestamp
        case message
        case ignoreLegacy
    }
}
