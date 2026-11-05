import Foundation
import UserNotifications

extension CalendarEventSummary: MeetingAlertEvent {
    var alertLaunchURL: URL? { launchURL.isEmpty ? nil : URL(string: launchURL) }
}

/// The meeting warning on the Mac, 1:1 with `MeetingNotices` on
/// the phone: the same plan (`MeetingAlertPlan`), the same lead
/// (`MeetingAlertSettings.leadMinutes`, device-local), the same words.
///
/// Scheduled in advance and rewritten whole on every calendar refresh, so the
/// last refresh bounds coverage: a meeting created elsewhere after that has no
/// warning until the next one. **Fires only while Meet is running**, like
/// every other notice here — see `StarlingsNotices`. Not push; do not write "push".
enum MeetingWarningNotices {
    static let categoryIdentifier = "MEET_MEETING"
    static let joinAction = "MEET_MEETING_JOIN"
    static let eventIDKey = "eventID"
    private static let identifierPrefix = "meet.meeting."

    /// Registered with every other category by `StarlingsNotices.registerCategories`.
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

    /// Rewrite the pending set to exactly match `meetings`. Idempotent: safe on
    /// every refresh, every wake, every settings change.
    static func synchronize(meetings: [CalendarEventSummary], now: Date = Date()) async {
        await cancelAll()
        guard MeetingAlertSettings.enabled else { return }
        let notices = MeetingAlertPlan.plan(meetings: meetings, now: now, lead: MeetingAlertSettings.noticeLead)
        // Asked at the first meeting that needs it, not at launch — the prompt
        // then arrives with obvious context.
        guard !notices.isEmpty, await StarlingsNotices.requestAuthorization() else { return }

        let center = UNUserNotificationCenter.current()
        for notice in notices {
            let content = UNMutableNotificationContent()
            content.title = notice.title
            content.body = MeetingAlertPlan.body(for: notice)
            content.sound = .default
            content.categoryIdentifier = categoryIdentifier
            content.interruptionLevel = .active
            content.threadIdentifier = identifierPrefix
            content.userInfo = [eventIDKey: notice.eventID]
            try? await center.add(UNNotificationRequest(
                identifier: identifierPrefix + notice.eventID,
                content: content,
                // An absolute delay, not a wall-clock time: crossing a time
                // zone must not move the warning.
                trigger: UNTimeIntervalNotificationTrigger(
                    timeInterval: max(1, notice.fireAt.timeIntervalSince(now)),
                    repeats: false
                )
            ))
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
