import Foundation
import UserNotifications

/// One "somebody asked for you" banner, decided before any `UserNotifications`
/// type exists — so the rule is unit-testable and each request is built fresh
/// at the moment it is handed to the notification centre. Same shape as
/// `MessageNotices`, deliberately.
struct RingNotice: Equatable, Sendable {
    /// Caller and creation time. A ring sits in the roster for its whole
    /// forty-five seconds, so without a key every poll would announce the same
    /// person again.
    let key: String
    let callerName: String
    let roomSlug: String?
    let joinURL: String?
    var isCall: Bool = false
    /// Your own Claude asking: the same banner-then-answer-in-Team
    /// shape as a call, under its own copy.
    var isAgentAsk: Bool = false
}

/// Local notifications for a Ring from Team.
///
/// **These fire only while the app is running.** There is no APNs registration
/// and no push payload, so a ring that arrives while Meet is closed is not
/// announced — and it will have expired long before the app is opened again.
/// That is the honest ceiling of this app's notification infrastructure, and
/// closing it means APNs, a device-token table, and a Worker that sends on
/// write. Do not describe this as push in user-facing copy.
enum RingNotices {
    static let categoryIdentifier = "MEET_RING"
    static let callCategoryIdentifier = "MEET_CALL"
    static var callCategory: UNNotificationCategory {
        UNNotificationCategory(identifier: callCategoryIdentifier, actions: [], intentIdentifiers: [], options: [])
    }
    static let joinAction = "MEET_RING_JOIN"
    private static let identifier = "meet.ring"

    static var category: UNNotificationCategory {
        UNNotificationCategory(
            identifier: categoryIdentifier,
            actions: [
                UNNotificationAction(identifier: joinAction, title: String(localized: "Join"), options: [.foreground]),
            ],
            intentIdentifiers: [],
            options: []
        )
    }

    /// What to announce, given what has already been announced. Pure.
    static func plan(
        ring: PeerRing?,
        announced: String?,
        webOrigin: String
    ) -> (notice: RingNotice?, announced: String?) {
        guard let ring else { return (nil, nil) }
        let key = "\(ring.callerEmail)#\(Int(ring.createdAt.timeIntervalSince1970))"
        guard key != announced else { return (nil, announced) }
        return (
            RingNotice(
                key: key,
                callerName: ring.callerDisplayName,
                roomSlug: ring.roomSlug,
                joinURL: (ring.kind == .wave ? ring.roomSlug : nil).map {
                    MeetingInvite.absoluteURL(
                        slug: $0,
                        webOrigin: MeetingInvite.shareOrigin(configuredWebOrigin: webOrigin)
                    )
                },
                isCall: ring.kind == .call,
                isAgentAsk: ring.kind == .agentStart
            ),
            key
        )
    }

    /// Deliver immediately. `trigger: nil` is what makes a local notification
    /// arrive now rather than on a schedule — somebody wanted you just now.
    static func deliver(_ notice: RingNotice) async {
        guard await MeetingNotices.requestAuthorization() else { return }
        let content = UNMutableNotificationContent()
        if notice.isAgentAsk {
            content.title = String(localized: "\(notice.callerName) asks to open your room")
            content.body = String(localized: "Open Team to answer: Open room or Not now.")
        } else {
            content.title = notice.isCall ? String(localized: "\(notice.callerName) wants to talk") : String(localized: "\(notice.callerName) waved at you")
            content.body = notice.isCall ? String(localized: "Open Team to answer: Open room or Not now.") : notice.roomSlug.map { String(localized: "Asked for you · their room is \($0)") } ?? String(localized: "Asked for you in Team")
        }
        content.sound = .default
        content.categoryIdentifier = (notice.isCall || notice.isAgentAsk) ? callCategoryIdentifier : categoryIdentifier
        if let joinURL = notice.joinURL {
            content.userInfo = [MeetingNotices.launchURLKey: joinURL]
            content.targetContentIdentifier = joinURL
        }
        // One identifier for every ring: a second caller replaces the banner
        // rather than stacking it, which matches the roster — it carries one.
        try? await UNUserNotificationCenter.current().add(UNNotificationRequest(
            identifier: identifier,
            content: content,
            trigger: nil
        ))
    }

    /// The ring expired, was answered, or was dismissed on another device.
    static func withdraw() {
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [identifier])
    }
}

/// Every category this app answers for, registered in one call.
///
/// `setNotificationCategories` **replaces** the whole set rather than adding to
/// it, so registering them one file at a time meant the last writer silently
/// stripped the others' action buttons.
enum MobileNotices {
    @MainActor
    static func registerCategories() {
        UNUserNotificationCenter.current().setNotificationCategories([
            MeetingNotices.category,
            MessageNotices.category,
            RingNotices.category,
            RingNotices.callCategory,
            KnockNotices.category,
            InboxNotices.category,
        ])
    }
}
