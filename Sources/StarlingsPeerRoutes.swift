import Foundation
import StarlingsContracts

/// The peers and presence routes, each named once for the Mac and
/// the phone: the roster, a wave and a call, the statuses a person sets about
/// themselves, the owner beat and a colleague's picture. `MeetingControlAPI`
/// and `StarlingsAPI` send them. The meeting beat is a room route.
enum StarlingsPeerRoutes {
    /// Who else is around. Members only: there is no unauthenticated form of
    /// this call and there must never be one. A client that keeps the
    /// snapshot paints the roster's identity from it, never who is around
    /// (docs/CACHING.md §Never cached).
    static let peers = StarlingsRoute<PeerRoster>(
        method: "GET", path: ["peers"],
        operation: String(localized: "Couldn’t load your team"),
        snapshotKey: StarlingsSnapshotKey.peers
    )

    /// Wave at a colleague. No push and no APNs: one row that their next
    /// roster poll reads, which expires on its own. Never proof that somebody
    /// was reached.
    static func ring(peerEmail: String) -> StarlingsRoute<Acknowledgement> {
        StarlingsRoute(
            method: "POST", path: ["peers", "ring"], body: PeerRingRequest(peerEmail: peerEmail),
            operation: String(localized: "Couldn’t wave at them")
        )
    }

    /// Answered, dismissed, or simply seen: either way it stops being pending.
    static let clearRing = StarlingsRoute<Acknowledgement>(
        method: "POST", path: ["peers", "ring", "clear"], body: StarlingsEmptyBody(),
        operation: String(localized: "Couldn’t clear that")
    )

    /// Ask somebody to open their room and talk now. The same row and the
    /// same 45-second life as a wave; only a call has something to accept.
    static func call(peerEmail: String) -> StarlingsRoute<Acknowledgement> {
        StarlingsRoute(
            method: "POST", path: ["peers", "call"], body: PeerCallRequest(peerEmail: peerEmail),
            operation: String(localized: "Couldn’t call them")
        )
    }

    /// Unavailable (`dnd_until` at the Worker). `until` is absolute; nil
    /// turns it off. There is no open-ended form.
    static func doNotDisturb(until: Date?) -> StarlingsRoute<PeerDoNotDisturbResponse> {
        StarlingsRoute(
            method: "POST", path: ["peers", "dnd"],
            body: PeerDoNotDisturbRequest(until: until.map { Int($0.timeIntervalSince1970 * 1000) }),
            operation: String(localized: "Couldn’t change your status")
        )
    }

    /// What the person says about themselves beside what their devices prove.
    /// Focused requires `until` and nothing else takes one; the Worker
    /// refuses any other shape.
    static func intent(_ intent: PeerIntent?, until: Date?) -> StarlingsRoute<PeerIntentResponse> {
        StarlingsRoute(
            method: "POST", path: ["peers", "intent"],
            body: PeerIntentRequest(intent: intent, until: .ifSome(until.map { Int($0.timeIntervalSince1970 * 1000) })),
            operation: String(localized: "Couldn’t change your status")
        )
    }

    /// Appear offline, or stop. Sticky at the Worker.
    static func appearOffline(_ invisible: Bool) -> StarlingsRoute<PeerAppearOfflineResponse> {
        StarlingsRoute(
            method: "POST", path: ["peers", "appear-offline"], body: PeerAppearOfflineRequest(invisible: invisible),
            operation: String(localized: "Couldn’t change your visibility")
        )
    }

    /// "This device has Starlings open." Best-effort: a missed beat costs one
    /// status. The device's time zone rides every beat, so a colleague's row
    /// can say what time it is where they are, unless they pinned one.
    static func heartbeat(client: PeerHeartbeatRequestClient) -> StarlingsRoute<Acknowledgement> {
        StarlingsRoute(
            method: "POST", path: ["owner", "heartbeat"],
            body: PeerHeartbeatRequest(client: client, timezone: TimeZone.current.identifier),
            operation: String(localized: "Couldn’t check in")
        )
    }

    /// One colleague's picture, member-gated like the roster. `version` is
    /// their `avatarUpdatedAt`, so an address means the same bytes forever,
    /// which is what lets the URL cache answer it. A 404 is the ordinary
    /// answer for somebody without a picture.
    static func avatar(email: String, version: Date) -> StarlingsRoute<StarlingsNoAnswer> {
        StarlingsRoute(
            method: "GET", path: ["avatar"],
            query: AvatarQuery(email: email, v: String(Int(version.timeIntervalSince1970 * 1000))).queryItems,
            operation: String(localized: "Couldn’t load that picture"),
            accept: "image/*",
            cachesAnswer: true
        )
    }
}
