import Foundation
import UserNotifications

/// Local notifications for an INBOX row that somebody else made: a guest
/// who booked, a calendar invitation, a company that filled in /interest, a task Core proposed,
/// a task or issue that landed on you, a reply on a document, a new CRM
/// touch. Shared by the Mac and the phone; each hands in its own
/// authorization ask.
///
/// Not every source is an event. Unread talk is `MessageNotices`' already;
/// a Quick Note is your own; overdue becomes true at midnight. Those three
/// never fire here, and Settings › Work › Inbox stays the one switch: a
/// source turned off has no row, so nothing to announce.
///
/// **These fire only while Meet is running**, like every notice in Meet:
/// no APNs, no push payload. A row that arrives while the app is quit is
/// waiting in INBOX the next time you open it. Do not describe this as push
/// in user-facing copy.
enum InboxNotices {
    static let categoryIdentifier = "MEET_INBOX"
    static let keyKey = "inboxKey"
    /// A guest row on intake: the conversation a click opens, and its title.
    static let threadIDKey = "inboxThreadID"
    static let threadTitleKey = "inboxThreadTitle"
    private static let identifierPrefix = "meet.inbox."

    /// What to announce, given what has already been seen.
    ///
    /// A key absent from `seen` on the first observation is **recorded, not
    /// announced**: the first read after launch (a cached snapshot, or the
    /// first poll) would otherwise fire a banner per old row, which is a
    /// notification about history. Mirrors `MessageNotices.plan`.
    static func plan(
        items: [WorkInboxItem],
        seen: Set<String>,
        isFirstObservation: Bool
    ) -> (notices: [InboxNotice], seen: Set<String>) {
        var notices: [InboxNotice] = []
        let keys = Set(items.map(\.id))
        if !isFirstObservation {
            var fromEmail: [WorkInboxItem] = []
            for item in items where !seen.contains(item.id) && item.notifiesLocally {
                if case .forwarded = item {
                    fromEmail.append(item)
                } else {
                    notices.append(InboxNotice(key: item.id, title: item.glanceTitle, body: item.glanceDetail, threadID: item.glanceThreadID))
                }
            }
            if let notice = emailNotice(fromEmail) { notices.append(notice) }
        }
        return (notices, keys)
    }

    /// Events from one forwarded mail land together, so they are one banner:
    /// "2 events from your email", their titles underneath.
    private static func emailNotice(_ items: [WorkInboxItem]) -> InboxNotice? {
        guard let first = items.first else { return nil }
        if items.count == 1 {
            return InboxNotice(key: first.id, title: String(localized: "Event from your email"), body: first.glanceTitle)
        }
        return InboxNotice(
            key: first.id,
            title: String(localized: "\(items.count) events from your email"),
            body: items.map(\.glanceTitle).joined(separator: ", ")
        )
    }

    static var category: UNNotificationCategory {
        UNNotificationCategory(identifier: categoryIdentifier, actions: [], intentIdentifiers: [], options: [])
    }

    /// Deliver immediately: the row has already happened. `authorize` is the
    /// platform's own ask (`StarlingsNotices` on the Mac, `MeetingNotices` on iOS).
    static func deliver(_ notices: [InboxNotice], authorize: () async -> Bool) async {
        guard !notices.isEmpty, await authorize() else { return }
        let center = UNUserNotificationCenter.current()
        for notice in notices {
            let content = UNMutableNotificationContent()
            content.title = notice.title
            content.body = notice.body
            content.sound = .default
            content.categoryIdentifier = categoryIdentifier
            // One group for the whole inbox, the way a mail app stacks its badge.
            content.threadIdentifier = identifierPrefix + "inbox"
            var info: [String: String] = [keyKey: notice.key]
            if let threadID = notice.threadID {
                info[threadIDKey] = threadID
                info[threadTitleKey] = notice.title
            }
            content.userInfo = info
            try? await center.add(UNNotificationRequest(
                identifier: identifierPrefix + notice.key,
                content: content,
                trigger: nil
            ))
        }
    }
}

/// One "something landed in INBOX" banner, decided before any
/// `UserNotifications` type exists, so `plan` is unit-testable.
struct InboxNotice: Equatable, Sendable {
    let key: String
    let title: String
    let body: String
    /// Set for a guest row on intake: the click opens that conversation.
    var threadID: String? = nil
}

extension WorkInboxItem {
    /// Whether a new row of this source is announced. The three that are
    /// not: talk (`MessageNotices`) and your own note. An event from email is
    /// announced: the mail was yours, but the event is read from it later.
    var notifiesLocally: Bool {
        switch self {
        case .booking, .invitation, .forwarded, .interest, .submission, .commercial, .task, .card, .followUp, .comment, .sales, .decision, .guest: true
        // Questions keep existing chat notifications until focus coordination (#775).
        case .talk, .note, .question: false
        }
    }
}
