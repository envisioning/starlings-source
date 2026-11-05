import AppKit
import UserNotifications

/// Local notifications for a message that reaches you: every message in a
/// direct or group conversation, and a channel message only when it
/// `@mentions` you — unless `MessageNotificationPreferences` widens channels
/// to every message. See `ThreadSummary.shouldNotifyLocally`.
///
/// **These fire only while Meet is running.** Same ceiling as `StarlingsNotices`:
/// no APNs registration and no push payload, so a message that arrives while
/// Meet is quit is not announced — it is simply waiting, unread, the next
/// time you open it. Do not describe this as push in user-facing copy.
///
/// **Does not suppress the conversation you already have open.** iOS's
/// equivalent (`MessageNotices` there) is fed the pane currently on screen;
/// nothing on the Mac side yet tells this watch which `ThreadPaneView` a
/// window is showing, so this can occasionally repeat a banner for a
/// conversation you are already reading. Wiring that through is future work,
/// not a correctness bug — worst case is one extra banner, never a missed one.
enum MessageNotices {
    static let categoryIdentifier = "MEET_MESSAGE"
    static let threadIDKey = "threadID"
    private static let identifierPrefix = "meet.message."
    /// How far before the last poll a never-seen thread's newest message may
    /// be and still count as new. The poll time is this device's clock and
    /// the message time is the control plane's; a minute covers ordinary
    /// skew without turning an old conversation into news.
    static let newThreadClockAllowance: TimeInterval = 60

    /// What to announce, given what has already been seen.
    ///
    /// `previousObservation` is when the last poll was made, or `nil` when
    /// this is the first poll since launch. The first poll **records and
    /// announces nothing**: it would otherwise fire a banner for every
    /// conversation with an old unread message in it, which is a notification
    /// about history rather than about anything that just happened.
    ///
    /// After that, a message is announced when it is newer than what was
    /// seen for its thread — or, for a thread this watch has never seen (a
    /// conversation that did not exist at the last poll: a new lead channel,
    /// a first DM), when it was written after the last poll. A conversation
    /// that merely *appears* with history in it — being added to a group
    /// that has been talking for a week — stays quiet, because its newest
    /// message predates the last poll. `newThreadClockAllowance` absorbs
    /// skew between this device's clock (the poll time) and the control
    /// plane's (the message time).
    ///
    /// Mirrors `MessageNotices.plan` on the other Apple client so a message
    /// notifies — or does not — for the identical reason on Mac and iPhone.
    static func plan(
        threads: [ThreadSummary],
        seen: [String: Date],
        activeThreadID: String?,
        previousObservation: Date?,
        notifyOnAllChannelMessages: Bool
    ) -> (notices: [MessageNotice], seen: [String: Date]) {
        var updated = seen
        var notices: [MessageNotice] = []

        for thread in threads {
            guard let lastMessageAt = thread.lastMessageAt else { continue }
            let previous = seen[thread.id]
            updated[thread.id] = lastMessageAt

            // The conversation on screen announces itself by showing the
            // message; a banner over it is noise.
            guard thread.id != activeThreadID else { continue }
            guard thread.shouldNotifyLocally(notifyOnAllChannelMessages: notifyOnAllChannelMessages) else { continue }
            guard let previousObservation else { continue }
            if let previous {
                guard lastMessageAt > previous else { continue }
            } else {
                guard lastMessageAt > previousObservation.addingTimeInterval(-newThreadClockAllowance) else { continue }
            }

            notices.append(MessageNotice(
                threadID: thread.id,
                title: thread.title,
                body: thread.lastMessagePreview ?? String(localized: "New message"),
                sentAt: lastMessageAt
            ))
        }
        return (notices, updated)
    }

    static var category: UNNotificationCategory {
        UNNotificationCategory(
            identifier: categoryIdentifier,
            actions: [],
            intentIdentifiers: [],
            options: []
        )
    }

    /// Deliver immediately. `trigger: nil` is what makes a local notification
    /// arrive now rather than on a schedule — the message has already happened.
    static func deliver(_ notices: [MessageNotice]) async {
        guard !notices.isEmpty, await StarlingsNotices.requestAuthorization() else { return }
        let center = UNUserNotificationCenter.current()

        for notice in notices {
            let content = UNMutableNotificationContent()
            content.title = notice.title
            content.body = notice.body
            content.sound = .default
            content.categoryIdentifier = categoryIdentifier
            // Group a conversation's banners together, the way Messages does.
            content.threadIdentifier = identifierPrefix + notice.threadID
            content.userInfo = [threadIDKey: notice.threadID]
            try? await center.add(UNNotificationRequest(
                identifier: identifierPrefix + notice.threadID + "." + String(Int(notice.sentAt.timeIntervalSince1970)),
                content: content,
                trigger: nil
            ))
        }
    }
}

/// One "somebody wrote to you" banner, decided before any `UserNotifications`
/// type exists — so the rule in `plan` is unit-testable and each request is
/// built fresh at the moment it is handed to the notification centre. Same
/// shape as the iOS type of the same name, deliberately.
struct MessageNotice: Equatable, Sendable {
    let threadID: String
    let title: String
    let body: String
    let sentAt: Date
}
