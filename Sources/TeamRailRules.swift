import Foundation

/// The order of Team's PEOPLE and AGENTS blocks, and which conversations trail them,
/// decided once in `packages/contracts/src/team-rail.ts`. The conversation kind is generated
/// from it (`pnpm registries:gen`); the rules are the Swift mirror, which
/// `fixtures/team-rail.json` pins (`TeamRailFixtureTests`).
///
/// Whoever you have a conversation with comes first, latest message first; then everybody
/// else, in the order the server gave. Unread does not jump the queue.
struct TeamRailDirect: Equatable, Sendable {
    /// `TeamRailRules.directKind` for a direct or group conversation; anything else is not one.
    let kind: String
    /// A group has more than one other person. It has no row of its own.
    let isGroup: Bool
    let peerEmail: String?
    /// Milliseconds since the epoch; nil when nothing has been said.
    let lastMessageAt: Double?

    fileprivate var isOneToOne: Bool { kind == TeamRailRules.directKind && !isGroup }
}

enum TeamRailRules {
    // `directKind` is generated from the TypeScript module: Sources/Generated/TeamRailRegistry.swift.

    /// The roster's emails in rail order: people you have talked with, latest message first,
    /// then the rest as they came.
    static func order(emails: [String], directs: [TeamRailDirect]) -> [String] {
        var latest: [String: Double] = [:]
        for direct in directs where direct.isOneToOne {
            guard let email = direct.peerEmail, let at = direct.lastMessageAt else { continue }
            if let known = latest[email], known >= at { continue }
            latest[email] = at
        }
        let talked = emails
            .filter { latest[$0] != nil }
            .sorted { (latest[$0] ?? 0) > (latest[$1] ?? 0) }
        let rest = emails.filter { latest[$0] == nil }
        return talked + rest
    }

    /// A conversation whose other side is not on the roster and is not you: it trails PEOPLE.
    static func isStray(_ direct: TeamRailDirect, rosterEmails: Set<String>, selfEmail: String?) -> Bool {
        guard direct.isOneToOne, let email = direct.peerEmail else { return false }
        return email != selfEmail && !rosterEmails.contains(email)
    }
}

extension TeamRailDirect {
    init(_ thread: ThreadSummary) {
        self.init(
            kind: thread.kind == .dm ? TeamRailRules.directKind : "other",
            isGroup: thread.isGroup,
            peerEmail: thread.peerEmail,
            lastMessageAt: thread.lastMessageAt.map { $0.timeIntervalSince1970 * 1000 }
        )
    }
}
