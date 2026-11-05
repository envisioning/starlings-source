import Foundation

/// Raised hands, mirroring `packages/contracts/src/hands.ts`.
///
/// The opposite shape to `MeetingReaction` beside it, and deliberately so. A
/// reaction is an event: published lossy on a data topic, animated for a couple
/// of seconds, and gone, so a client that joined a moment later has simply
/// missed it. A hand is **state** — it stays up until it is lowered, and the
/// question it answers is "who has one up right now", which no ephemeral topic
/// can answer for anybody who joined, reconnected or reopened the app after it
/// went up.
///
/// So it lives in a LiveKit participant attribute, which syncs to every client
/// including late joiners and survives a reconnect for free.
///
/// **Neither of these clients writes that attribute.** LiveKit gates every
/// self-service attribute and metadata write behind one grant,
/// `canUpdateOwnMetadata`, which this app keeps shut so a participant cannot
/// rewrite the `owner` stamped into their metadata at
/// mint. Raising a hand goes through the control plane, which already knows who
/// is asking and writes the attribute with an admin grant. See
/// `services/control-plane/src/livekit.ts`.
enum MeetingHand {
    /// `HAND_ATTRIBUTE`.
    static let attribute = "hand"

    /// `HAND_LOWERED` — LiveKit reads an empty value as cleared, so "lowered"
    /// and "never raised" are the same state, which is what they are.
    static let lowered = ""

    /// `HAND_STALE_AFTER_MS`. A hand left up this long is somebody who forgot,
    /// not somebody waiting; past it a client stops counting one in the host's
    /// badge. Nothing lowers it — no hand goes down behind its owner's back —
    /// but a queue that never empties is a queue the host learns to ignore.
    static let staleAfter: TimeInterval = 60 * 60

    /// When this hand went up, or nil if it is down.
    ///
    /// Tolerant on purpose: a value this cannot parse reads as a hand that is
    /// down. A missed hand is a missed question; a throw inside a view update
    /// is a broken meeting.
    static func raisedAt(_ value: String?) -> Date? {
        guard let value, let milliseconds = Double(value), milliseconds > 0 else { return nil }
        return Date(timeIntervalSince1970: milliseconds / 1000)
    }

    /// Whether these attributes say the hand is up, and recently enough to count.
    static func isRaised(_ attributes: [String: String], now: Date = Date()) -> Bool {
        guard let at = raisedAt(attributes[attribute]) else { return false }
        return now.timeIntervalSince(at) < staleAfter
    }
}

/// One person with their hand up, and when they raised it.
///
/// Ordered by the raise rather than by name: the host's question with a queue
/// in front of them is who to go to next, and that is the order people actually
/// asked in. Carrying the moment in the attribute is what makes that free.
struct RaisedHand: Equatable, Identifiable, Sendable {
    let identity: String
    let name: String
    let raisedAt: Date
    /// Yours. Carried on the row rather than compared by id at each call site,
    /// because a rail's local row holds a placeholder id and not the LiveKit
    /// identity — asking the queue is the only reliable answer.
    let isLocal: Bool

    var id: String { identity }
}

extension Array where Element == RaisedHand {
    /// Oldest raise first.
    var inQueueOrder: [RaisedHand] {
        sorted { $0.raisedAt < $1.raisedAt }
    }
}
