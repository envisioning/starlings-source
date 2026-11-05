import Foundation
import StarlingsContracts

/// What the phone tells the watch. One value, replaced whole, carried by
/// `WCSession.updateApplicationContext` — the watch always holds the latest
/// and never a backlog. Both targets compile this file; it is the contract.
///
/// The watch cannot sign in, so the phone lends it the **access token only**.
/// The refresh token stays on the phone: it is single-use and per device
/// (`MobileOwnerSessionStore`), and two devices spending one would sign the
/// phone out. When the token dies the watch shows "Open Starlings on your phone"
/// and waits for the next snapshot, which the phone sends on every renewal.
struct WatchBridgeSnapshot: Codable, Equatable, Sendable {
    struct Session: Codable, Equatable, Sendable {
        let accessToken: String
        let ownerName: String
        let apiEndpoint: String
        /// Whose session this is. The watch files each queued note under it,
        /// so a note dictated before a sign-out goes to the same owner and
        /// never to the next one. Nil from a phone older than the field.
        var ownerEmail: String? = nil
        /// The workspace the phone is signed in to, so the wrist can say
        /// which one. Nil from a phone older than the field.
        var workspaceName: String? = nil
    }

    /// The little the wrist and the widgets need of a calendar event.
    /// `isVideo` is what the Live Activity's eligibility rule reads; the face
    /// shows both kinds. `launchURL` is where a tap on the phone widget goes.
    /// `calendarID`, `isAllDay` and `isDemoted` are what `MeetingFocus` needs
    /// to place the event, so the phone widget runs the same rule as Home.
    struct Meeting: Codable, Equatable, Identifiable, Sendable {
        let id: String
        let title: String
        let start: Date
        let end: Date
        let calendarName: String
        let isVideo: Bool
        let launchURL: String?
        let calendarID: String?
        let isAllDay: Bool
        let isDemoted: Bool
        /// The other people, by first name, for a glance surface with room
        /// for a "who" line. Nil from a phone older than the field.
        var attendees: [String]? = nil
    }

    /// One of today's tasks for the Today's work widget: what
    /// Home's WORK card lists, already planned by `WorkItems.focus` on the phone: the late and due-today rows.
    /// Title, subject and a day — never notes, never a token.
    struct WorkRow: Codable, Equatable, Identifiable, Sendable {
        let id: String
        let title: String
        let subjectTitle: String?
        let subjectKind: String?
        let subjectID: String?
        let due: Date?
        let overdue: Bool

        /// Home's count line: "2 overdue · 1 due today". Empty for no rows.
        static func summary(_ rows: [WorkRow]) -> String {
            let overdue = rows.filter(\.overdue).count
            let dueToday = rows.count - overdue
            return [
                overdue > 0 ? String(localized: "\(overdue) overdue") : nil,
                dueToday > 0 ? String(localized: "\(dueToday) due today") : nil,
            ].compactMap { $0 }.joined(separator: " · ")
        }
    }

    /// What the phone writes for its widgets: the raw feed and the owner's
    /// Upcoming preferences, so the widget derives the same plan Home does,
    /// and today's work rows, planned once on the phone.
    struct Agenda: Codable, Equatable, Sendable {
        let meetings: [Meeting]
        let preferences: UpcomingPreferencesWire
        /// Nil from a phone older than the field; the work widget draws nothing.
        var work: [WorkRow]? = nil

        static let empty = Agenda(meetings: [], preferences: .defaults)
    }

    /// Nil means signed out. The watch clears its own copy on receipt.
    let session: Session?
    /// The next few, already ordered, already filtered to what is upcoming.
    let meetings: [Meeting]
    let sentAt: Date
    /// Today's work, the rows the phone's Today's work widget draws. Nil from
    /// a phone older than the field.
    var work: [WorkRow]? = nil

    static let empty = WatchBridgeSnapshot(session: nil, meetings: [], sentAt: .distantPast)

    /// The one key in the application-context dictionary.
    static let contextKey = "snapshot"
    /// The one message the watch sends back: its lent token was refused, so
    /// the phone renews if it must and sends the snapshot again.
    static let sessionRequestKey = "sessionRequest"
    /// The Today's work widget's kind, so the work store can reload it alone.
    static let todayWorkWidgetKind = "\(ContractConstants.nativeAppBundleID).today-work"
    static let todayAgendaWidgetKind = "\(ContractConstants.nativeAppBundleID).today-agenda"
    /// Where a watch complication tap goes in the watch app.
    static let watchScheme = "meetwatch"
    static let watchWorkURL = URL(string: "meetwatch://work")!

    /// The widgets read the meetings from here, not from the app: a WidgetKit
    /// extension has no `WCSession` and no session. Same group on the phone
    /// app, its widget extension, and both watch bundles; each device has its
    /// own container.
    static let appGroup = ContractConstants.nativeAppGroup
    static let agendaFile = "agenda.json"

    func encodedContext() throws -> [String: Any] {
        [Self.contextKey: try JSONEncoder().encode(self)]
    }

    static func decode(context: [String: Any]) -> WatchBridgeSnapshot? {
        guard let data = context[contextKey] as? Data else { return nil }
        return try? JSONDecoder().decode(WatchBridgeSnapshot.self, from: data)
    }
}

/// The bridge shape as the event `MeetingFocus` places. One conformance for
/// the phone widgets, the watch complication and the app's launch action, so
/// none of them keeps a rule of its own about which meeting is next.
extension WatchBridgeSnapshot.Meeting: UpcomingEvent {
    var upcomingID: String { id }
    var upcomingCalendarID: String? { calendarID }
    var upcomingTitle: String { title }
    var upcomingStart: Date? { start }
    var upcomingEnd: Date? { end }
    var upcomingIsAllDay: Bool { isAllDay }
    var upcomingIsDemoted: Bool { isDemoted }
}
