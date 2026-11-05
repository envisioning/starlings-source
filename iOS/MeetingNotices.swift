import Foundation
import UserNotifications

extension MobileCalendarEvent: MeetingAlertEvent {
    var alertLaunchURL: URL? { conferenceLink }
}

/// The meeting warning, at the lead the person chose (`MeetingAlertSettings`).
///
/// iOS never wakes an app on a schedule to look at a calendar, so the alert
/// cannot be decided at fire time — every upcoming meeting gets its notification
/// scheduled in advance, and the whole set is rewritten each time the feed
/// refreshes. That makes the last app launch, not the last calendar change, the
/// thing that bounds coverage: a meeting created elsewhere after you last opened
/// Meet has no alert until the app runs again. Closing that gap needs APNs.
enum MeetingNotices {
    private static let identifierPrefix = "meet.meeting."
    static let categoryIdentifier = "MEET_MEETING"
    static let launchURLKey = "launchURL"

    /// Registered together with every other category by `MobileNotices` —
    /// `setNotificationCategories` replaces the set, so no file may call it
    /// alone.
    static var category: UNNotificationCategory {
        UNNotificationCategory(
            identifier: categoryIdentifier,
            actions: [
                UNNotificationAction(identifier: "MEET_JOIN", title: String(localized: "Join"), options: [.foreground]),
            ],
            intentIdentifiers: [],
            options: []
        )
    }

    /// Ask on the first refresh that actually has something to warn about,
    /// rather than at launch — the prompt then arrives with obvious context.
    @discardableResult
    static func requestAuthorization() async -> Bool {
        let center = UNUserNotificationCenter.current()
        switch await center.notificationSettings().authorizationStatus {
        case .notDetermined:
            return (try? await center.requestAuthorization(options: [.alert, .sound])) ?? false
        case .denied:
            return false
        default:
            return true
        }
    }

    /// Rewrite the pending set to exactly match `meetings`. Idempotent, so it is
    /// safe on every refresh, every foreground, and every clock change.
    static func synchronize(meetings: [MobileCalendarEvent], now: Date = Date()) async {
        await cancelAll()
        guard MeetingAlertSettings.enabled else { return }
        let notices = MeetingAlertPlan.plan(meetings: meetings, now: now, lead: MeetingAlertSettings.noticeLead)
        guard !notices.isEmpty, await requestAuthorization() else { return }

        let center = UNUserNotificationCenter.current()
        for notice in notices {
            let content = UNMutableNotificationContent()
            content.title = notice.title
            content.body = MeetingAlertPlan.body(for: notice)
            content.sound = .default
            content.categoryIdentifier = categoryIdentifier
            // `.timeSensitive` would break through Focus, which is exactly when
            // this matters — but it needs the time-sensitive entitlement on the
            // App ID, so it is a deliberate follow-up rather than a silent
            // change to what the app is provisioned for.
            content.interruptionLevel = .active
            content.threadIdentifier = identifierPrefix
            if let url = notice.launchURL {
                content.userInfo = [launchURLKey: url.absoluteString]
                content.targetContentIdentifier = url.absoluteString
            }
            try? await center.add(
                UNNotificationRequest(
                    identifier: identifierPrefix + notice.eventID,
                    content: content,
                    // An absolute delay, not a wall-clock time: crossing a time
                    // zone must not move the warning.
                    trigger: UNTimeIntervalNotificationTrigger(
                        timeInterval: max(1, notice.fireAt.timeIntervalSince(now)),
                        repeats: false
                    )
                )
            )
        }
    }

    /// Drop every pending warning — sign-out, or the setting switched off.
    static func cancelAll() async {
        let center = UNUserNotificationCenter.current()
        let ours = await center.pendingNotificationRequests()
            .map(\.identifier)
            .filter { $0.hasPrefix(identifierPrefix) }
        center.removePendingNotificationRequests(withIdentifiers: ours)
    }

}

/// "That meeting is not filed", once, when a hosted meeting ends
/// uncategorized.
///
/// The artifact is already on its way to Core as `uncategorized`; nothing here
/// changes that. The nudge exists because the filing sheet lives on the call
/// screen, and the moment the call ends is the last moment the host still
/// remembers what the meeting was. No actions: filing needs the Core subject
/// search, which is a screen, not a button. Dismissing is "later".
enum UnfiledMeetingNotice {
    private static let identifier = "meet.unfiled"

    static func deliverIfUnfiled(
        api: StarlingsAPI,
        credentials: MobileOwnerCredentials,
        room: String,
        meetingID: String
    ) async {
        // Best effort, like every CRM read. No category means no nudge — a
        // wrong nudge after every meeting would train the host to dismiss it.
        guard let category = try? await api.meetingCategory(
            credentials: credentials,
            room: room,
            meetingID: meetingID
        ), category.meetingKind == .uncategorized else { return }
        guard await MeetingNotices.requestAuthorization() else { return }
        let content = UNMutableNotificationContent()
        content.title = String(localized: "Meeting not filed")
        content.body = "It was saved without a subject"
        content.sound = nil
        content.interruptionLevel = .passive
        try? await UNUserNotificationCenter.current().add(UNNotificationRequest(
            identifier: identifier,
            content: content,
            trigger: nil
        ))
    }
}
