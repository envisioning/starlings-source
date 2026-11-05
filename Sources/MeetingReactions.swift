import Foundation

/// In-meeting reactions. The palette, its order and its names are
/// `packages/contracts/src/reactions.ts` (Generated/ReactionsRegistry.swift).
///
/// Ephemeral by design: published lossy on their own LiveKit data topic,
/// animated for a couple of seconds, and stored nowhere. Nothing about a
/// reaction reaches the control plane, so none of it lands in the meeting
/// record, the transcript, or the summary.
///
/// Four, and the chat quick row reads the same list. Applause and
/// mind-blown were retired: every surface draws these as icons, and four
/// distinct icons is what a glance holds.
extension MeetingReaction {
    /// Native presentation for the wire value. The raw value remains part of
    /// the protocol; authored UI uses a semantic symbol instead of rendering
    /// that value as a glyph.
    var systemSymbolName: String {
        switch self {
        case .thumbsUp: "hand.thumbsup.fill"
        case .party: "party.popper.fill"
        case .heart: "heart.fill"
        // Not the `.fill` variant: a filled face is a solid disc with the
        // eyes and mouth cut out, and at flyer size the outline pass fills
        // those cut-outs in — over video it reads as a circle, not a face.
        // The stroked face keeps its features at every size and weight.
        case .laugh: "face.smiling"
        }
    }

    static func systemSymbolName(for rawValue: String) -> String {
        if let reaction = MeetingReaction(rawValue: rawValue) {
            return reaction.systemSymbolName
        }
        // Retired from the palette but still on stored messages.
        switch rawValue {
        case "👏", "🙏": return "hands.clap.fill"
        case "🤯": return "brain.head.profile"
        case "👀": return "eye.fill"
        default: return "face.smiling"
        }
    }

    static func accessibilityName(for rawValue: String) -> String {
        if let reaction = MeetingReaction(rawValue: rawValue) {
            return reaction.accessibilityName
        }
        return retiredNames[rawValue] ?? customName
    }

    /// `REACTION_DATA_TOPIC`.
    static let topic = ContractConstants.reactionDataTopic
    // The rate limit, flight timing and ceiling are generated (Generated/ReactionsRegistry.swift).
}

/// Wire body for `reactions.v1` — the same JSON the browser publishes.
struct ReactionMessage: Codable, Sendable {
    let version: Int
    let emoji: String

    init(_ reaction: MeetingReaction) {
        version = 1
        emoji = reaction.rawValue
    }

    /// The reaction this packet names, or nil for anything outside the palette.
    var reaction: MeetingReaction? {
        guard version == 1 else { return nil }
        return MeetingReaction(rawValue: emoji)
    }
}
