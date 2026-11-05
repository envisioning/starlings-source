import Foundation

/// One meeting as every glanceable surface reads it: the Lock
/// Screen and Dynamic Island activity, the Home Screen widget, the watch's
/// Smart Stack mirror and its complication. One information architecture,
/// top to bottom, dropped from the bottom as room runs out:
///
/// 1. The state word: `NOW` while it is on, the config's `UPCOMING` before.
/// 2. The title, then the calendar.
/// 3. The one number: minutes to the start, or minutes left.
/// 4. The one action: Join where there is a link, the meeting in the app
///    where there is not. Never two.
/// 5. Who, where there is room.
///
/// This is the data; a surface draws it. Nothing here decides which meeting
/// is the one — `MeetingFocus` does, and the two builders below take its
/// answer. Foundation only, so the watch targets read it too.
struct StarlingsGlance: Equatable, Sendable {
    /// `NOW` / `UPCOMING`, the word Home puts over the hero (`UpcomingPlan.heroLabel`).
    let state: String
    let title: String
    /// The calendar's name; empty when the feed gave none.
    let calendar: String
    let start: Date
    let end: Date
    let isAllDay: Bool
    let isVideo: Bool
    /// Where a tap that means "join" goes. Nil for a meeting with no link.
    let launchURL: URL?
    /// Where a tap goes when there is no link: the meeting, in the app.
    let eventURL: URL?
    /// The other people, by first name, in the feed's order.
    let attendees: [String]

    /// The URL scheme every glance surface writes: `starlings://` since
    ///. The phone app registers it beside `legacyEventScheme`.
    static let eventScheme = ContractConstants.nativeLinkScheme
    /// `meet://`, written before the rename. Installed widgets, scheduled
    /// notifications and running Live Activities still carry it, so the app
    /// keeps reading it for at least two App Store releases.
    static let legacyEventScheme = ContractConstants.legacyNativeLinkScheme
    /// Both schemes the app opens.
    static let eventSchemes: Set<String> = [eventScheme, legacyEventScheme]

    static func eventURL(for reference: String) -> URL? {
        var components = URLComponents()
        components.scheme = eventScheme
        components.host = "event"
        components.path = "/" + reference
        return components.url
    }

    /// The one action's destination: Join, else the meeting in the app.
    var tapURL: URL? { launchURL ?? eventURL }

    func hasStarted(at now: Date) -> Bool { start <= now }

    /// What the number counts to: the start, then the end. Nil for an
    /// all-day row, which has no minute to count.
    func countdownTarget(at now: Date) -> Date? {
        if isAllDay { return nil }
        return hasStarted(at: now) ? end : start
    }

    /// The number, rounded the way Home rounds: "12m", "2h 15m", "now".
    /// Never seconds. A surface with a timeline draws this and re-renders on
    /// `AgendaFile.entryDates`; one without draws `countdownTarget` through
    /// the system's minute format.
    func countdownText(at now: Date) -> String? {
        countdownTarget(at: now).map { StarlingsDateFormatting.compactDuration(until: $0, from: now) }
    }

    /// How long before the start a glyph-first surface swaps its mark for
    /// the number (the watch's circular complication).
    static let countdownLead: TimeInterval = 10 * 60

    /// True from `countdownLead` before the start until the end. Never for
    /// an all-day row.
    func isImminent(at now: Date) -> Bool {
        !isAllDay && now >= start.addingTimeInterval(-Self.countdownLead) && now < end
    }

    /// "to go" before the start, "left" after: the word beside the number.
    func countdownUnit(at now: Date) -> String { hasStarted(at: now) ? "left" : String(localized: "to go") }

    /// "Starts 14:00" or "Ends 15:00", the clock the number is counting to.
    func clockLine(at now: Date) -> String {
        let started = hasStarted(at: now)
        let time = StarlingsDateFormatting.time(started ? end : start)
        return started ? String(localized: "Ends \(time)") : String(localized: "Starts \(time)")
    }

    /// The who line: up to two first names, then how many more. Empty when
    /// the feed named nobody, so a surface can leave the line out.
    var who: String {
        Self.whoLine(attendees)
    }

    static func whoLine(_ names: [String]) -> String {
        let named = names.filter { !$0.isEmpty }
        guard !named.isEmpty else { return "" }
        let shown = named.prefix(2).joined(separator: ", ")
        let more = named.count - min(named.count, 2)
        return more > 0 ? "\(shown) +\(more)" : shown
    }

    /// A first name from a display name, or the address's local part when
    /// the feed gave no name — a who line is names, never addresses.
    static func firstName(_ name: String, email: String) -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if let first = trimmed.split(separator: " ").first, !first.isEmpty { return String(first) }
        return String(email.prefix { $0 != "@" })
    }

    /// The phone's widget and the watch: a meeting the plan chose as focus.
    init(meeting: WatchBridgeSnapshot.Meeting, plan: UpcomingPlan<WatchBridgeSnapshot.Meeting>) {
        state = plan.heroLabel
        title = meeting.title
        calendar = meeting.calendarName
        start = meeting.start
        end = meeting.end
        isAllDay = meeting.isAllDay
        isVideo = meeting.isVideo
        launchURL = meeting.launchURL.flatMap(URL.init(string:))
        eventURL = Self.eventURL(for: meeting.id)
        attendees = meeting.attendees ?? []
    }

    /// The Live Activity: its archived state, at the clock the system renders with.
    init(
        title: String,
        calendar: String,
        start: Date,
        end: Date,
        isVideo: Bool,
        launchURL: URL?,
        eventReference: String,
        attendees: [String],
        hasStarted: Bool
    ) {
        state = hasStarted ? String(localized: "NOW") : UpcomingConfiguration.current.sectionTitle
        self.title = title
        self.calendar = calendar
        self.start = start
        self.end = end
        isAllDay = false
        self.isVideo = isVideo
        self.launchURL = launchURL
        eventURL = Self.eventURL(for: eventReference)
        self.attendees = attendees
    }
}
