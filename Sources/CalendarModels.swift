import Foundation

/// Platform-neutral so the Mac and iOS calendars share one colour table.
/// `nsColor` / `contrastingText` live in CalendarAppKitChrome.swift;
/// `swiftUIColor` / `contrastingInk` in MobileCalendarChrome.swift.
struct StarlingsRGBColor: Codable, Equatable, Sendable {
    var red: Double
    var green: Double
    var blue: Double

    /// Perceived brightness, for deciding whether ink on this colour is dark.
    var luminance: Double {
        0.2126 * red + 0.7152 * green + 0.0722 * blue
    }

    static func hex(_ value: String) -> StarlingsRGBColor? {
        var hex = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if hex.hasPrefix("#") { hex.removeFirst() }
        guard hex.count == 6, let packed = UInt32(hex, radix: 16) else { return nil }
        return StarlingsRGBColor(
            red: Double((packed >> 16) & 0xFF) / 255,
            green: Double((packed >> 8) & 0xFF) / 255,
            blue: Double(packed & 0xFF) / 255
        )
    }

    static let palette: [StarlingsRGBColor] = [
        StarlingsRGBColor(red: 0.22, green: 0.47, blue: 0.90),
        StarlingsRGBColor(red: 0.83, green: 0.18, blue: 0.18),
        StarlingsRGBColor(red: 0.15, green: 0.55, blue: 0.38),
        StarlingsRGBColor(red: 0.61, green: 0.35, blue: 0.71),
        StarlingsRGBColor(red: 0.90, green: 0.49, blue: 0.13),
        StarlingsRGBColor(red: 0.18, green: 0.66, blue: 0.66),
        StarlingsRGBColor(red: 0.75, green: 0.22, blue: 0.47),
        StarlingsRGBColor(red: 0.40, green: 0.45, blue: 0.53),
    ]

    static func fallback(at index: Int) -> StarlingsRGBColor {
        palette[abs(index) % palette.count]
    }
}

struct StarlingsCalendar: Identifiable, Codable, Equatable, Sendable {
    enum Source: String, Codable, Hashable, Sendable {
        case google
        case eventKit
        case subscription
    }

    let id: String
    let source: Source
    let rawID: String
    let title: String
    let groupTitle: String
    let isWritable: Bool
    let color: StarlingsRGBColor
    /// The Google account this calendar came from. Nil for EventKit and
    /// subscribed feeds, and for a Google list cached to disk before the field
    /// existed — both read as not Envisioning, which is the safe answer.
    var accountEmail: String? = nil

    static func googleID(_ raw: String) -> String { CalendarKeys.google(raw) }

    /// Filing puts an event on the workspace's record. Only an event on a
    /// calendar of a member Google account can be filed; a personal Gmail,
    /// iCloud, or a subscribed feed never shows the control.
    var isMemberAccount: Bool {
        source == .google && CalendarAttendeeSummary.isMemberAddress(accountEmail ?? "")
    }
    static func eventKitID(_ raw: String) -> String { "ek:\(raw)" }
    static func subscriptionID(_ raw: String) -> String { CalendarKeys.subscription(raw) }

    /// Group heading for every subscribed (.ics) feed, regardless of what the
    /// feed itself is titled — they are not an account, and must never read as
    /// one.
    /// A group identity persisted with the cached calendar list, so it must
    /// read the same after a language change. Displayed as is.
    static let subscriptionGroupTitle = String(localized: "Subscribed")

    /// A writable calendar can still carry a company-defined meaning. This is
    /// intentionally orthogonal to `source`: "Envisioning Internal" remains a
    /// real Google calendar (and keeps every edit path), while its rows borrow
    /// the visual language of the company layers.
    var role: CalendarSemanticRole { role(in: .active) }

    /// The role on `workspace`. Tests pass a workspace, so the answer does not
    /// depend on the workspace this Mac has active.
    func role(in workspace: StarlingsWorkspace) -> CalendarSemanticRole {
        CalendarSemanticRole(calendarTitle: title, source: source, workspace: workspace)
    }

    /// Shared calendars are writable containers, but they are not destinations
    /// for re-homing an existing event. Creating an event there remains valid.
    var canBeMoveTarget: Bool { canBeMoveTarget(in: .active) }

    func canBeMoveTarget(in workspace: StarlingsWorkspace) -> Bool {
        isWritable && role(in: workspace).canReceiveMovedEvents
    }

    var displayColor: StarlingsRGBColor { displayColor(in: .active) }

    func displayColor(in workspace: StarlingsWorkspace) -> StarlingsRGBColor {
        role(in: workspace) == .globalInterest ? CalendarLayerPalette.globalInterest : color
    }

    /// How a calendar is named in a preference that travels between devices.
    ///
    /// `id` cannot do this job. An EventKit calendar's identifier is a UUID the
    /// system minted on *this* device, so the same iCloud calendar has one id on
    /// the Mac and a different one on the phone — switching a calendar off here
    /// would switch nothing off there. Account and title are the same words on
    /// both, so that is what gets stored. Google ids are already global.
    var visibilityKey: String {
        switch source {
        case .google: return Self.googleID(rawID)
        case .eventKit: return Self.eventKitVisibilityKey(account: groupTitle, title: title)
        case .subscription: return Self.subscriptionID(rawID)
        }
    }

    static func eventKitVisibilityKey(account: String, title: String) -> String {
        CalendarKeys.eventKit(account: account, title: title)
    }

    /// A whole account switched off — kept as its own key rather than as one key
    /// per calendar, so a calendar added to a muted account later stays muted.
    static func accountVisibilityKey(_ group: String) -> String {
        if group == subscriptionGroupTitle { return CalendarKeys.subscribedAccount }
        return CalendarKeys.account(group)
    }

    /// Account groups in a stable reading order: Google first because it is the
    /// work account, local last because it is the least interesting, and the
    /// real account names in between — however many there turn out to be.
    static func orderedGroups(of calendars: [StarlingsCalendar]) -> [String] {
        var seen = Set<String>()
        var groups: [String] = []
        for calendar in calendars where seen.insert(calendar.groupTitle).inserted {
            groups.append(calendar.groupTitle)
        }
        return groups.sorted { left, right in
            func rank(_ group: String) -> Int {
                if group == "Google" { return 0 }
                // "On My Mac" / "On My iPhone" / "On My iPad" — EventKit's local
                // store, whatever this device calls it.
                if group.hasPrefix("On My ") { return 3 }
                // Subscribed feeds are not an account and read last, next to the
                // device's own store but after it — they are further still from
                // something you signed into.
                if group == subscriptionGroupTitle { return 4 }
                return 2
            }
            if rank(left) != rank(right) { return rank(left) < rank(right) }
            return left.localizedCaseInsensitiveCompare(right) == .orderedAscending
        }
    }
}

/// Which calendars are in the app at all — owner-wide, unlike
/// `CalendarWorkspace`'s hidden/shown state, which only decides what is drawn
/// today. Disabling a calendar here keeps it out of the sidebar, out of every
/// fetch, and off the list of places a new event can be filed.
///
/// Kept in its own `UserDefaults` keys, separate from the existing
/// `"meet.calendar.hiddenKeys"` — hiding and disabling are different
/// questions, asked in different places, and must never answer for each
/// other.
enum CalendarSourcePreferences {
    static let didChange = Notification.Name("MeetCalendarSourcePreferencesDidChange")
    static let upcomingDidChange = Notification.Name("MeetUpcomingPreferencesDidChange")

    private enum Key {
        static let disabled = "meet.calendar.disabledKeys"
        static let seenLocal = "meet.calendar.seenLocalKeys"
        static let includesLocalCalendars = "meet.calendar.includesLocalCalendars"
        static let googleConnectionAssertedAt = "meet.calendar.googleConnectionAssertedAt"
    }

    /// `didChange` userInfo flag: this change is a Google connect, so the
    /// listener should read again once KV has had time to catch up.
    static let googleConnectionAssertedKey = "googleConnectionAsserted"

    /// How long a connect just made outranks what `/calendar/status` says.
    ///
    /// The Worker keeps calendar tokens in KV, which is eventually consistent
    /// and caches "no such key" for up to a minute — and the app reads the
    /// status right before opening Google, so the miss is cached at the exact
    /// moment the token is written. For a while after connecting, a "not
    /// connected" answer is that stale cache, not the truth; the exchange
    /// response is. Stored in defaults rather than on a workspace because the
    /// Settings window and the Calendar window each hold their own.
    static let googleConnectionGrace: TimeInterval = 90

    static func assertGoogleConnected(defaults: UserDefaults = .standard, now: Date = Date()) {
        defaults.set(now.timeIntervalSince1970, forKey: Key.googleConnectionAssertedAt)
    }

    static func clearGoogleConnectionAssertion(defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: Key.googleConnectionAssertedAt)
    }

    static func googleConnectionRecentlyAsserted(defaults: UserDefaults = .standard, now: Date = Date()) -> Bool {
        let stamp = defaults.double(forKey: Key.googleConnectionAssertedAt)
        guard stamp > 0 else { return false }
        let elapsed = now.timeIntervalSince1970 - stamp
        return elapsed >= 0 && elapsed < googleConnectionGrace
    }

    /// EventKit is opt-in. Reading this must not ask for Calendar permission;
    /// the first explicit switch-on is what may trigger the system prompt.
    static func includesLocalCalendars(defaults: UserDefaults = .standard) -> Bool {
        defaults.bool(forKey: Key.includesLocalCalendars)
    }

    static func setIncludesLocalCalendars(_ included: Bool, defaults: UserDefaults = .standard) {
        defaults.set(included, forKey: Key.includesLocalCalendars)
        NotificationCenter.default.post(name: didChange, object: nil)
    }

    /// Calendars switched off, by `StarlingsCalendar.visibilityKey` or
    /// `StarlingsCalendar.accountVisibilityKey`.
    static func disabled(defaults: UserDefaults = .standard) -> Set<String> {
        Set(defaults.stringArray(forKey: Key.disabled) ?? [])
    }

    static func setDisabled(_ keys: Set<String>, defaults: UserDefaults = .standard) {
        defaults.set(Array(keys).sorted(), forKey: Key.disabled)
        NotificationCenter.default.post(name: didChange, object: nil)
    }

    /// Whether a local (EventKit) calendar list has ever been reported. Empty
    /// does not count — access may simply not be granted yet, and the real
    /// list, when it arrives, must not arrive entirely switched off.
    static func hasSeededLocal(defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: Key.seenLocal) != nil
    }

    /// The local calendars this app has already had its say about. The first
    /// paint reads only these: a calendar that has appeared since the last
    /// launch has not been through `adoptLocal` yet, and must not flash on
    /// screen before that has decided whether it belongs.
    static func knownLocal(defaults: UserDefaults = .standard) -> Set<String> {
        Set(defaults.stringArray(forKey: Key.seenLocal) ?? [])
    }

    /// Marks calendars as no longer new, without switching anything on or off.
    /// Used after a calendar is explicitly re-enabled, so it is not reported
    /// as "new" again the next time the local list is read.
    static func markLocalKnown(_ keys: Set<String>, defaults: UserDefaults = .standard) {
        // An empty EventKit result usually means permission is still unknown,
        // not that the device has no calendars. Do not turn that observation
        // into a seeded empty list.
        guard !keys.isEmpty else { return }
        let seen = Set(defaults.stringArray(forKey: Key.seenLocal) ?? [])
        defaults.set(Array(seen.union(keys)).sorted(), forKey: Key.seenLocal)
    }

    /// Folds a freshly-read local calendar list into what has been seen
    /// before, and returns only the keys that are new.
    ///
    /// The first list a Mac ever hands over is adopted whole — nothing that
    /// was already there may be switched off behind the owner — so the first
    /// call always returns `[]` and simply records the list as seen. Only
    /// calendars that turn up on a later call are new, and it is the caller's
    /// choice what a new calendar starts as.
    static func adoptLocal(keys: Set<String>, defaults: UserDefaults = .standard) -> [String] {
        guard hasSeededLocal(defaults: defaults) else {
            markLocalKnown(keys, defaults: defaults)
            return []
        }
        let seen = Set(defaults.stringArray(forKey: Key.seenLocal) ?? [])
        let fresh = keys.subtracting(seen)
        markLocalKnown(keys, defaults: defaults)
        return fresh.sorted()
    }
}

struct StarlingsCalendarEvent: Identifiable, Codable, Equatable, Sendable {
    /// `var` for one reason: the grid draws a ⌘-drag ghost as a copy of the
    /// dragged event under a throwaway id, so both can be on screen at once.
    var id: String
    let calendarID: String
    let rawEventID: String
    let title: String
    var start: Date
    var end: Date
    let isAllDay: Bool
    let isWritable: Bool
    let isRecurring: Bool
    let joinURL: String
    let roomSlug: String
    let attendeeEmails: [String]
    /// The same people with their reply, name and whether one is you — what
    /// the editor's invite list draws and what the card's guest mark reads.
    /// Empty for events cached before this field existed; `attendeeEmails`
    /// stays the list of record for the write path.
    var attendees: [CalendarAttendeeSummary] = []
    let source: StarlingsCalendar.Source
    /// Series id for a Google recurring instance. Empty for one-off events and
    /// for EventKit, which addresses a series through `EKSpan` instead.
    var recurringEventID: String = ""
    /// Free-text notes. Carried so an edit round-trip cannot silently drop them.
    var notes: String = ""
    /// Location as stored by the source. Kept distinct from `joinURL` so a
    /// physical room is not overwritten by a conference link.
    var location: String = ""
    /// IANA zone the event was made in, when its source says. Lets a tile
    /// write `12:05 – 14:05 (10:05 GMT)` for an event made elsewhere.
    var startTimeZone: String? = nil
    /// Explicit travel duration from calendar metadata, in whole minutes.
    var travelTimeMinutes: Int? = nil
    /// The owner's reply, when the owner is on the guest list.
    var myResponse: CalendarRSVP?
    /// Owner-wide "not for me" state. The event stays on the calendar but is
    /// not eligible for Next, alerts, or the Live Activity.
    var isDemoted: Bool = false
    /// Company-global context carried by an editable Google calendar.
    var calendarRole: CalendarSemanticRole = .ordinary
    /// The project or lead this event is about, from the owner-wide map keyed
    /// by `demotionKey`. A room started from the event is filed under it.
    var subject: CrmSubject? = nil

    /// Everything but `attendees`, which stays out of the on-disk snapshot: a
    /// cached event paints with its emails and gets the rich list on the
    /// next live read, and the snapshot written before the field existed
    /// still decodes.
    enum CodingKeys: String, CodingKey {
        case id, calendarID, rawEventID, title, start, end, isAllDay, isWritable, isRecurring
        case joinURL, roomSlug, attendeeEmails, source, recurringEventID, notes, location, startTimeZone
        case travelTimeMinutes, myResponse, isDemoted, calendarRole, subject
    }

    /// The guest mark on the card: `nil` while the owner is alone, or until a
    /// cached event gets its rich list on the next live read.
    var attendance: CalendarAttendance? { CalendarAttendance.of(attendees) }

    /// Calendar movement changes the event's home. Rescheduling within the
    /// current calendar is a separate operation and remains allowed for
    /// writable Internal events.
    var canMoveBetweenCalendars: Bool {
        isWritable && source != .subscription && calendarRole.canMoveEventsOut
    }

    /// Opaque, title-free identity stored in owner preferences. Google's
    /// combined calendar/event id is stable across devices; subscription UIDs
    /// usually are too. EventKit is best-effort on the same device because
    /// Apple does not promise cross-device event identifiers.
    var demotionKey: String {
        switch source {
        case .google:
            return CalendarKeys.eventDemotion(isSubscription: false, eventID: "\(String(calendarID.dropFirst(2))):\(rawEventID)")
        case .eventKit:
            return "event:\(id)"
        case .subscription:
            return "event:\(id)"
        }
    }

    /// EventKit exposes participant status but has no public API to change it,
    /// so replies can only be sent for Google events.
    var canRespond: Bool {
        source == .google && myResponse != nil && !rawEventID.isEmpty
    }

    var displayTitle: String {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? String(localized: "New Event") : trimmed
    }

    /// Google rows arrive with a normalized platform; EventKit and `.ics` rows
    /// only have their location. Keep one provider answer for every native
    /// calendar surface, including Upcoming and the day/week/month grids.
    var meetingPlatform: CalendarMeetingPlatform {
        CalendarMeetingPlatform.inferred(
            joinURL: joinURL,
            location: location,
            roomSlug: roomSlug
        )
    }

    var isVideoMeeting: Bool {
        meetingPlatform != .none && !joinURL.isEmpty
    }

    /// An event remains current until its end, including an event that started
    /// earlier today or crosses midnight.
    var isPast: Bool { isPast(at: .now) }

    func isPast(at now: Date) -> Bool {
        end <= now
    }

    func withSchedule(start: Date, end: Date) -> StarlingsCalendarEvent {
        var moved = self
        moved.start = start
        moved.end = end
        return moved
    }

    func withID(_ id: String) -> StarlingsCalendarEvent {
        var copy = self
        copy.id = id
        return copy
    }
}

/// Semantic meaning of an editable calendar, separate from transport and
/// permissions. Exact-name recognition is the bootstrap contract; the role is
/// also carried on the wire so every surface renders the same answer.
/// The values are the contract's (`CalendarSemanticRole`, generated); what each
/// one means to a surface lives here.
extension CalendarSemanticRole {
    /// The calendar’s real name in Google, matched as data. Never localized.
    static let globalInterestCalendarTitle = "\(ContractConstants.orgName) Internal"

    /// Only on the build's own workspace (Envisioning): no other workspace
    /// inherits Envisioning's company calendar by its title.
    init(calendarTitle: String, source: StarlingsCalendar.Source, workspace: StarlingsWorkspace = .active) {
        if source == .google,
           workspace.isBuiltIn,
           calendarTitle.trimmingCharacters(in: .whitespacesAndNewlines)
            .caseInsensitiveCompare(Self.globalInterestCalendarTitle) == .orderedSame {
            self = .globalInterest
        } else {
            self = .ordinary
        }
    }

    var title: String {
        switch self {
        case .globalInterest: return String(localized: "Global interest")
        default: return String(localized: "Calendar")
        }
    }

    /// The shared company calendar is editable, but its events have a stable
    /// home and it is not a generic destination for moving personal events.
    var isShared: Bool {
        self == .globalInterest
    }

    var canMoveEventsOut: Bool {
        !isShared
    }

    var canReceiveMovedEvents: Bool {
        !isShared
    }

    /// No `symbolName` here on purpose. Global interest is Envisioning's own
    /// context, so every surface marks it with the Starlings glyph — `StarlingsBrand
    /// .glyphImage` on the Mac, `StarlingsGlyphMark` on the phone — rather than with a
    /// system symbol that says "special" without saying whose.
}

/// Local cache for owner-wide event demotions. It gives every window on this
/// device the new answer immediately; `CalendarWorkspace` mirrors it to the
/// control plane for the owner's other devices.
enum CalendarEventPreferences {
    private static let demotedKey = "meet.calendar.demotedEventKeys"

    static func demoted(defaults: UserDefaults = .standard) -> Set<String> {
        Set(defaults.stringArray(forKey: demotedKey) ?? [])
    }

    static func setDemoted(_ keys: Set<String>, defaults: UserDefaults = .standard) {
        defaults.set(Array(keys).sorted(), forKey: demotedKey)
        NotificationCenter.default.post(name: CalendarSourcePreferences.didChange, object: nil)
    }
}

/// The owner's own reply to an invitation. `nil` on an event means there is
/// nothing to answer: not an invitee, or an event nobody invited anyone to.
enum CalendarRSVP: String, Codable, Equatable, Sendable {
    case accepted
    case declined
    case tentative
    case needsAction

    var label: String {
        switch self {
        case .accepted: return String(localized: "Accepted")
        case .declined: return String(localized: "Declined")
        case .tentative: return String(localized: "Tentative")
        case .needsAction: return String(localized: "Pending")
        }
    }
    // What can be sent back is `CalendarRSVP.answers` (CalendarValuesRegistry,
    // generated); `needsAction` is a state, not an answer.
}

/// How much of the calendar the workspace is showing.
enum CalendarViewMode: String, CaseIterable, Sendable {
    case day
    case week
    case month

    var label: String {
        switch self {
        case .day: return "Day"
        case .week: return "Week"
        case .month: return "Month"
        }
    }

    /// The digit this mode binds, under ⌃⌘.
    ///
    /// Plain ⌘1/⌘2/⌘3 — Calendar.app's binding, and this app's until the three
    /// windows were unified — now switch between Meet, Calendar and Work from
    /// anywhere. What the *window* shows is a tier below what *window* you are
    /// in, so day/week/month took the same digits one modifier down.
    var shortcut: String {
        switch self {
        case .day: return "1"
        case .week: return "2"
        case .month: return "3"
        }
    }

    /// How the binding is written for a tooltip. Menu items build their own
    /// from `shortcut`; this is so the two cannot drift apart.
    var shortcutLabel: String { "⌃⌘\(shortcut)" }
}

enum CalendarEditSpan: String, Sendable {
    case thisEvent
    case futureEvents
}

/// One drawn block. Usually a single event; when the same event arrives on
/// several calendars it is one block wearing all of their colours.
struct CalendarEventGroup: Identifiable, Equatable, Sendable {
    let event: StarlingsCalendarEvent
    let calendarIDs: [String]

    var id: String { event.id }
    var isMerged: Bool { calendarIDs.count > 1 }
}

struct CalendarAllDayLayout: Equatable, Sendable {
    let id: String
    let startIndex: Int
    let endIndex: Int
    let row: Int
}

struct CalendarTimedSpan: Equatable, Sendable {
    let id: String
    let start: Date
    let end: Date
}

struct CalendarPackedSpan: Equatable, Sendable {
    let id: String
    let column: Int
    let columnCount: Int

    /// Timed collisions cascade rather than splitting the column evenly.
    /// Each lane starts a fixed step further right and then runs to the edge
    /// of the day, so the card in front is wide enough to read a title in and
    /// the ones behind it show a stub you can still see and tap. Two meetings
    /// at 10:00 are a card and a stub, not two half-width slivers that both
    /// clip their titles.
    ///
    /// Cards therefore overlap by design, and whoever draws them must paint
    /// lanes in ascending `column` — the greedy packer reuses a freed lane, so
    /// a later event can land in an earlier one.
    var horizontalLeadingFraction: Double {
        guard columnCount > 1, column > 0 else { return 0 }
        return Self.laneStep(columnCount) * Double(column)
    }

    var horizontalWidthFraction: Double { 1 - horizontalLeadingFraction }

    /// How far each lane is inset from the one behind it. It tightens as a
    /// cluster grows, so the front card keeps a readable share of the column
    /// however many meetings collide, and the stubs stay wide enough to hit.
    private static func laneStep(_ columnCount: Int) -> Double {
        min(0.34, 0.8 / Double(columnCount))
    }
}

/// A candidate for the all-day band, whatever it came from.
struct CalendarAllDaySpan: Equatable, Sendable {
    let id: String
    let start: Date
    let end: Date
}

enum CalendarWeekMath {
    static func startOfWeek(containing date: Date, calendar: Calendar = .current) -> Date {
        let startOfDay = calendar.startOfDay(for: date)
        let weekday = calendar.component(.weekday, from: startOfDay)
        let delta = (weekday - calendar.firstWeekday + 7) % 7
        return calendar.date(byAdding: .day, value: -delta, to: startOfDay) ?? startOfDay
    }

    static func days(ofWeekStarting start: Date, count: Int = 7, calendar: Calendar = .current) -> [Date] {
        (0..<count).compactMap { calendar.date(byAdding: .day, value: $0, to: start) }
    }

    /// First day of the month containing `date`.
    static func startOfMonth(containing date: Date, calendar: Calendar = .current) -> Date {
        let components = calendar.dateComponents([.year, .month], from: date)
        return calendar.date(from: components) ?? calendar.startOfDay(for: date)
    }

    /// The 42 cells a month grid shows: whole weeks, so the month is padded
    /// with the trailing and leading days of its neighbours.
    static func monthGridDays(containing date: Date, calendar: Calendar = .current) -> [Date] {
        let first = startOfMonth(containing: date, calendar: calendar)
        let gridStart = startOfWeek(containing: first, calendar: calendar)
        return (0..<42).compactMap { calendar.date(byAdding: .day, value: $0, to: gridStart) }
    }

    /// The days a mode shows, anchored on `anchor`.
    static func days(for mode: CalendarViewMode, anchor: Date, calendar: Calendar = .current) -> [Date] {
        switch mode {
        case .day:
            return [calendar.startOfDay(for: anchor)]
        case .week:
            return days(ofWeekStarting: startOfWeek(containing: anchor, calendar: calendar), calendar: calendar)
        case .month:
            return monthGridDays(containing: anchor, calendar: calendar)
        }
    }

    /// Where a day-selection lands when the period on screen stops holding it:
    /// the nearest day that is still visible. Paging a week forward from a
    /// Friday lands on the Monday that arrives, not back on today.
    static func nearestDay(to target: Date, in days: [Date], calendar: Calendar = .current) -> Date? {
        let start = calendar.startOfDay(for: target)
        return days
            .map { calendar.startOfDay(for: $0) }
            .min { abs($0.timeIntervalSince(start)) < abs($1.timeIntervalSince(start)) }
    }

    /// Step one screenful forward or back. Month steps by month so the grid
    /// does not drift out of alignment with the calendar it is showing.
    static func step(
        _ mode: CalendarViewMode,
        from anchor: Date,
        direction: Int,
        calendar: Calendar = .current
    ) -> Date {
        switch mode {
        case .day:
            return calendar.date(byAdding: .day, value: direction, to: anchor) ?? anchor
        case .week:
            return calendar.date(byAdding: .day, value: 7 * direction, to: anchor) ?? anchor
        case .month:
            let first = startOfMonth(containing: anchor, calendar: calendar)
            return calendar.date(byAdding: .month, value: direction, to: first) ?? anchor
        }
    }

    static func snap(_ date: Date, minutes: Int = 15, calendar: Calendar = .current) -> Date {
        let step = max(1, minutes)
        var components = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date)
        let minute = components.minute ?? 0
        components.minute = (minute / step) * step
        components.second = 0
        components.nanosecond = 0
        return calendar.date(from: components) ?? date
    }

    /// The next slot on the `minutes` grid at or after `date`: where a new
    /// event starts when nothing picked its time, so it never opens on an odd
    /// minute like 08:03 and never in the past.
    static func snapUp(_ date: Date, minutes: Int = 15, calendar: Calendar = .current) -> Date {
        let step = max(1, minutes)
        let floored = snap(date, minutes: step, calendar: calendar)
        return floored == date ? floored : floored.addingTimeInterval(TimeInterval(step * 60))
    }

    /// Gutter hour. Meet always uses a 24-hour clock, regardless of device locale.
    static func hourLabel(_ hour: Int, locale: Locale = .current) -> String {
        let clamped = min(23, max(0, hour))
        _ = locale
        return String(format: "%02d", clamped)
    }

    /// Time of day with minutes, e.g. for a drag readout. Always 24-hour.
    static func timeLabel(_ date: Date, locale: Locale = .current, calendar: Calendar = .current) -> String {
        let components = calendar.dateComponents([.hour, .minute], from: date)
        let hour = components.hour ?? 0
        let minute = components.minute ?? 0
        _ = locale
        return String(format: "%02d:%02d", hour, minute)
    }

    /// "45 min" under an hour, otherwise "1h" / "1h 30m".
    static func durationLabel(_ interval: TimeInterval) -> String {
        let totalMinutes = max(0, Int((interval / 60).rounded()))
        let hours = totalMinutes / 60
        let minutes = totalMinutes % 60
        if hours == 0 { return "\(minutes) min" }
        if minutes == 0 { return "\(hours)h" }
        return String(localized: "\(hours)h \(minutes)m")
    }

    /// Group copies of the same event that arrived through different calendars.
    ///
    /// The same meeting often reaches you on several subscriptions at once.
    /// Drawing each copy as its own block shreds the column into unreadable
    /// slivers, so identical copies collapse into one block that carries every
    /// calendar's colour. Two copies on the *same* calendar are left alone —
    /// those are genuinely two events, and merging them would hide one.
    static func consolidate(_ events: [StarlingsCalendarEvent]) -> [CalendarEventGroup] {
        var order: [String] = []
        var byKey: [String: [StarlingsCalendarEvent]] = [:]
        for event in events {
            let key = fingerprint(event)
            if byKey[key] == nil { order.append(key) }
            byKey[key, default: []].append(event)
        }

        return order.flatMap { key -> [CalendarEventGroup] in
            let members = byKey[key] ?? []
            var seenCalendars = Set<String>()
            var merged: [StarlingsCalendarEvent] = []
            var separate: [StarlingsCalendarEvent] = []
            for member in members {
                if seenCalendars.insert(member.calendarID).inserted {
                    merged.append(member)
                } else {
                    separate.append(member)
                }
            }
            var groups: [CalendarEventGroup] = []
            if let lead = representative(of: merged) {
                groups.append(CalendarEventGroup(
                    event: lead,
                    calendarIDs: merged.map(\.calendarID)
                ))
            }
            groups.append(contentsOf: separate.map {
                CalendarEventGroup(event: $0, calendarIDs: [$0.calendarID])
            })
            return groups
        }
    }

    /// Same title, same slot, same all-day flag. Deliberately ignores ids and
    /// notes: the point is what the copies look like to a person reading a week.
    static func fingerprint(_ event: StarlingsCalendarEvent, calendar: Calendar = .current) -> String {
        let title = event.displayTitle
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        // Sources disagree about what an all-day event is as an instant: Google
        // sends dates with an exclusive end, EventKit sends local midnight to
        // 23:59:59 on the last day. Keyed on timestamps, one event sitting on a
        // Google and an iCloud calendar never matched itself and drew twice.
        // Days are the thing both sources agree on.
        if event.isAllDay {
            return [
                title,
                "all-day",
                CalendarDateParsing.format(day: event.start, calendar: calendar),
                CalendarDateParsing.format(day: lastDay(of: event), calendar: calendar),
            ].joined(separator: "|")
        }
        return [
            title,
            String(event.start.timeIntervalSince1970),
            String(event.end.timeIntervalSince1970),
            String(event.isAllDay),
        ].joined(separator: "|")
    }

    /// The last day an all-day event covers, however its source spells the end.
    /// A second back lands inside the final day whether the end was the
    /// exclusive midnight after it or 23:59:59 within it.
    private static func lastDay(of event: StarlingsCalendarEvent) -> Date {
        max(event.start, event.end.addingTimeInterval(-1))
    }

    /// The copy an edit should act on: prefer one that can be replied to, then
    /// one that can be edited, so the merged block stays useful.
    private static func representative(of events: [StarlingsCalendarEvent]) -> StarlingsCalendarEvent? {
        events.first(where: { $0.canRespond && $0.isWritable })
            ?? events.first(where: \.canRespond)
            ?? events.first(where: \.isWritable)
            ?? events.first
    }

    /// The part of a timed event that falls inside one day column, or `nil`
    /// when it does not reach that day at all.
    ///
    /// Filtering by `isDate(start, inSameDayAs:)` loses two common cases: an
    /// event that runs past midnight never appears on the second day, and an
    /// event that began before the visible week never appears at all. Clipping
    /// to the day is what makes both render.
    static func daySegment(
        for event: StarlingsCalendarEvent,
        day: Date,
        calendar: Calendar = .current
    ) -> CalendarTimedSpan? {
        guard !event.isAllDay else { return nil }
        let dayStart = calendar.startOfDay(for: day)
        guard let dayEnd = calendar.date(byAdding: .day, value: 1, to: dayStart) else { return nil }
        // Half-open [dayStart, dayEnd): an event ending exactly at midnight
        // belongs to the day it ran through, not to the next one.
        guard event.start < dayEnd, event.end > dayStart else { return nil }
        return CalendarTimedSpan(
            id: event.id,
            start: max(event.start, dayStart),
            end: min(event.end, dayEnd)
        )
    }

    /// Clipped spans for every timed event touching `day`, in draw order.
    static func daySegments(
        _ events: [StarlingsCalendarEvent],
        day: Date,
        calendar: Calendar = .current
    ) -> [CalendarTimedSpan] {
        events
            .compactMap { daySegment(for: $0, day: day, calendar: calendar) }
            .sorted { left, right in
                if left.start != right.start { return left.start < right.start }
                return left.end > right.end
            }
    }

    /// Calendar.app-style overlap columns for one day's timed events.
    static func pack(_ spans: [CalendarTimedSpan]) -> [CalendarPackedSpan] {
        let ordered = spans.sorted { left, right in
            if left.start != right.start { return left.start < right.start }
            return left.end > right.end
        }
        var columnByID: [String: Int] = [:]
        var active: [(span: CalendarTimedSpan, column: Int)] = []
        var clusters: [[String]] = []
        var currentCluster: [String] = []
        var clusterEnd = Date.distantPast

        for span in ordered {
            active.removeAll { $0.span.end <= span.start }
            if span.start >= clusterEnd {
                if !currentCluster.isEmpty { clusters.append(currentCluster) }
                currentCluster = []
                clusterEnd = span.end
            } else {
                clusterEnd = max(clusterEnd, span.end)
            }
            currentCluster.append(span.id)
            let used = Set(active.map(\.column))
            var column = 0
            while used.contains(column) { column += 1 }
            columnByID[span.id] = column
            active.append((span, column))
        }
        if !currentCluster.isEmpty { clusters.append(currentCluster) }

        let countByID: [String: Int] = Dictionary(uniqueKeysWithValues: clusters.flatMap { cluster -> [(String, Int)] in
            let width = cluster.compactMap { columnByID[$0] }.max().map { $0 + 1 } ?? 1
            return cluster.map { ($0, width) }
        })

        return ordered.map { span in
            CalendarPackedSpan(
                id: span.id,
                column: columnByID[span.id] ?? 0,
                columnCount: max(1, countByID[span.id] ?? 1)
            )
        }
    }

    /// Google and EventKit store all-day `end` as the exclusive next midnight.
    /// EventKit also spells a one-day end as 23:59:59; that end is inclusive.
    /// An all-day event stored in another zone lands off midnight here, but
    /// its start and end share one clock time. That end is still exclusive.
    static func allDayInclusiveEnd(_ event: StarlingsCalendarEvent, calendar: Calendar = .current) -> Date {
        allDayInclusiveEnd(start: event.start, end: event.end, calendar: calendar)
    }

    static func allDayInclusiveEnd(
        start rawStart: Date,
        end rawEnd: Date,
        calendar: Calendar = .current
    ) -> Date {
        let start = calendar.startOfDay(for: rawStart)
        let endDay = calendar.startOfDay(for: rawEnd)
        let clock: Set<Calendar.Component> = [.hour, .minute, .second]
        let startClock = calendar.dateComponents(clock, from: rawStart)
        let endClock = calendar.dateComponents(clock, from: rawEnd)
        let isMidnight = endClock.hour == 0 && endClock.minute == 0 && endClock.second == 0
        if isMidnight || startClock == endClock, endDay > start {
            return calendar.date(byAdding: .day, value: -1, to: endDay) ?? start
        }
        return max(start, endDay)
    }

    static func allDayDayRange(
        _ event: StarlingsCalendarEvent,
        days: [Date],
        calendar: Calendar = .current
    ) -> ClosedRange<Int>? {
        guard event.isAllDay else { return nil }
        return allDayDayRange(
            start: event.start,
            end: event.end,
            days: days,
            calendar: calendar
        )
    }

    /// The same, for anything with a start and an end — layer rows are not
    /// events, but a milestone occupies the all-day band the same way.
    static func allDayDayRange(
        start rawStart: Date,
        end rawEnd: Date,
        days: [Date],
        calendar: Calendar = .current
    ) -> ClosedRange<Int>? {
        guard !days.isEmpty else { return nil }
        let start = calendar.startOfDay(for: rawStart)
        let inclusiveEnd = allDayInclusiveEnd(start: rawStart, end: rawEnd, calendar: calendar)
        var first: Int?
        var last: Int?
        for (index, day) in days.enumerated() {
            let cursor = calendar.startOfDay(for: day)
            if cursor >= start, cursor <= inclusiveEnd {
                if first == nil { first = index }
                last = index
            }
        }
        guard let first, let last else { return nil }
        return first...last
    }

    /// One bar per all-day event, stacked so overlapping spans take separate rows.
    static func packAllDay(
        _ events: [StarlingsCalendarEvent],
        days: [Date],
        calendar: Calendar = .current
    ) -> [CalendarAllDayLayout] {
        packAllDay(
            events.filter(\.isAllDay).map {
                CalendarAllDaySpan(id: $0.id, start: $0.start, end: $0.end)
            },
            days: days,
            calendar: calendar
        )
    }

    /// The same stacking for a mixed band — all-day events and the layer rows
    /// that share it — packed in one pass so rows cannot collide.
    static func packAllDay(
        _ spans: [CalendarAllDaySpan],
        days: [Date],
        calendar: Calendar = .current
    ) -> [CalendarAllDayLayout] {
        let ranked: [(id: String, start: Int, end: Int)] = spans.compactMap { span in
            guard let range = allDayDayRange(
                start: span.start,
                end: span.end,
                days: days,
                calendar: calendar
            ) else { return nil }
            return (span.id, range.lowerBound, range.upperBound)
        }
        .sorted { left, right in
            if left.start != right.start { return left.start < right.start }
            return (left.end - left.start) > (right.end - right.start)
        }

        var rowEnds: [Int] = []
        return ranked.map { item in
            var row = 0
            while row < rowEnds.count, rowEnds[row] >= item.start {
                row += 1
            }
            if row == rowEnds.count {
                rowEnds.append(item.end)
            } else {
                rowEnds[row] = item.end
            }
            return CalendarAllDayLayout(id: item.id, startIndex: item.start, endIndex: item.end, row: row)
        }
    }
}

extension StarlingsCalendarEvent {
    /// Display-only projection of an API summary, for surfaces that hold the
    /// upcoming feed rather than the full workspace (the menu bar).
    init?(summary: CalendarEventSummary) {
        guard let start = CalendarDateParsing.parse(summary.start) else { return nil }
        let end = CalendarDateParsing.parse(summary.end) ?? start.addingTimeInterval(3_600)
        let isSubscription = summary.calendarId.hasPrefix("sub:")
        self.init(
            id: summary.id,
            calendarID: isSubscription ? summary.calendarId : StarlingsCalendar.googleID(summary.calendarId),
            rawEventID: summary.rawEventID,
            title: summary.title,
            start: start,
            end: max(end, start.addingTimeInterval(60)),
            isAllDay: CalendarDateParsing.isAllDay(summary.start, flagged: summary.isAllDay),
            isWritable: false,
            isRecurring: summary.isRecurring,
            joinURL: summary.launchURL,
            roomSlug: summary.roomSlug,
            attendeeEmails: summary.attendees.map(\.email).filter { !$0.isEmpty },
            attendees: summary.attendees,
            source: isSubscription ? .subscription : .google,
            recurringEventID: summary.recurringEventId,
            notes: summary.notes,
            location: summary.location,
            startTimeZone: summary.startTimeZone,
            travelTimeMinutes: summary.travelTimeMinutes,
            myResponse: summary.myResponse,
            isDemoted: summary.demoted,
            calendarRole: summary.calendarRole
        )
    }
}

enum CalendarDateParsing {
    static func parse(_ value: String) -> Date? {
        if let date = ISODate.parse(value) { return date }
        guard value.count >= 10 else { return nil }
        let ymd = String(value.prefix(10)).split(separator: "-")
        guard ymd.count == 3,
              let year = Int(ymd[0]),
              let month = Int(ymd[1]),
              let day = Int(ymd[2])
        else { return nil }
        var components = DateComponents()
        components.year = year
        components.month = month
        components.day = day
        return Calendar.current.date(from: components)
    }

    /// `YYYY-MM-DD` in the local calendar — the form the work-items endpoint
    /// takes, because a milestone falls on a date rather than at an instant.
    static func format(day: Date, calendar: Calendar = .current) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: day)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    static func isAllDay(_ value: String, flagged: Bool) -> Bool {
        if flagged { return true }
        return value.count == 10 && value.allSatisfy { $0.isNumber || $0 == "-" }
    }
}

/// The small, provider-neutral slice needed to say that two calendar events
/// occupy the same time. Keeping this separate from either calendar model lets
/// Home compare its pending-invitation response with the compact upcoming feed
/// without making either surface own a second conflict rule.
struct CalendarConflictEvent: Equatable, Sendable {
    let id: String
    let title: String
    let start: Date?
    let end: Date?
    let isAllDay: Bool
    let isDeclined: Bool
}

protocol CalendarConflictRepresentable: Sendable {
    var calendarConflictEvent: CalendarConflictEvent { get }
}

/// One event that blocks an invitation's time. The full event is deliberately
/// not carried here: Home needs only the line it can fit under the invite.
struct CalendarConflict: Equatable, Identifiable, Sendable {
    let id: String
    let title: String
    let start: Date
    let end: Date

    var timeRange: String {
        "\(StarlingsDateFormatting.time(start))–\(StarlingsDateFormatting.time(end))"
    }
}

enum CalendarConflictDetector {
    /// Return real overlaps only. Adjacent events are not conflicts, and
    /// all-day events have no clock interval to compare on an invite row.
    static func conflicts(
        for candidate: CalendarConflictEvent,
        among events: [CalendarConflictEvent]
    ) -> [CalendarConflict] {
        guard let candidateInterval = interval(for: candidate) else { return [] }

        return events.compactMap { event in
            guard !event.isDeclined,
                  !sameScheduledEvent(candidate, event),
                  let eventInterval = interval(for: event),
                  candidateInterval.start < eventInterval.end,
                  eventInterval.start < candidateInterval.end
            else { return nil }

            return CalendarConflict(
                id: event.id,
                title: displayTitle(event.title),
                start: eventInterval.start,
                end: eventInterval.end
            )
        }
        .sorted {
            if $0.start != $1.start { return $0.start < $1.start }
            return $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending
        }
    }

    /// Compact secondary metadata for Home. The first conflicting event is
    /// named; additional overlaps stay countable without turning the card into
    /// another calendar list.
    static func line(for conflicts: [CalendarConflict]) -> String? {
        guard let first = conflicts.first else { return nil }
        let more = conflicts.count > 1 ? String(localized: " · +\(conflicts.count - 1) more") : ""
        return String(localized: "Conflicts with \(first.title) · \(first.timeRange)\(more)")
    }

    private static func interval(for event: CalendarConflictEvent) -> DateInterval? {
        guard !event.isAllDay,
              let start = event.start,
              let end = event.end,
              end > start
        else { return nil }
        return DateInterval(start: start, end: end)
    }

    /// A copied event can arrive once per selected calendar. It is one Home
    /// row, not a collision with itself, even when the provider gives it a
    /// different calendar-qualified id.
    private static func sameScheduledEvent(
        _ left: CalendarConflictEvent,
        _ right: CalendarConflictEvent
    ) -> Bool {
        guard left.id != right.id,
              let leftStart = left.start,
              let rightStart = right.start,
              let leftEnd = left.end,
              let rightEnd = right.end
        else { return left.id == right.id }

        return leftStart == rightStart
            && leftEnd == rightEnd
            && displayTitle(left.title).caseInsensitiveCompare(displayTitle(right.title)) == .orderedSame
    }

    private static func displayTitle(_ title: String) -> String {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? String(localized: "Untitled event") : trimmed
    }
}

extension CalendarEventSummary: CalendarConflictRepresentable {
    var calendarConflictEvent: CalendarConflictEvent {
        CalendarConflictEvent(
            id: id,
            title: title,
            start: CalendarDateParsing.parse(start),
            end: CalendarDateParsing.parse(end),
            isAllDay: isAllDay,
            isDeclined: myResponse == .declined
        )
    }
}

/// What a timed calendar tile says under its title, decided once
/// for the Mac grid and the iPhone grid; the web mirrors it in
/// `web/src/calendar-tile.ts`, pinned to `fixtures/calendar-tile.json`.
///
/// Row order is title, location, time. Rows appear as the tile grows — time
/// first, then location — and a row that does not fit whole is not drawn:
/// never half a line. The location row falls back to the meeting platform's
/// name when there is no place, because "Zoom" still answers "where".
struct CalendarTileDetail: Equatable {
    /// The place, or the platform's name when the event has only a link.
    let location: String?
    /// `start – end` in the viewer's zone, then `(HH:mm ZONE)` when the event
    /// was made in a zone with a different offset on that day.
    let time: String

    init(event: StarlingsCalendarEvent, viewerZone: TimeZone = .current) {
        location = Self.place(location: event.location, platform: event.meetingPlatform)
        time = Self.timeLabel(
            start: event.start,
            end: event.end,
            originZone: event.startTimeZone.flatMap(TimeZone.init(identifier:)),
            viewerZone: viewerZone
        )
    }

    /// The place, or the platform's name when the event has only a link.
    static func place(location: String, platform: CalendarMeetingPlatform) -> String? {
        let place = location.trimmingCharacters(in: .whitespacesAndNewlines)
        if !place.isEmpty { return place }
        return platformName(platform)
    }

    /// The same short product names the web agenda uses (`platformLabel`).
    static func platformName(_ platform: CalendarMeetingPlatform) -> String? {
        switch platform {
        case .starlings: "Starlings"
        case .googleMeet: "Google Meet"
        case .zoom: "Zoom"
        case .teams: "Teams"
        case .webex: "Webex"
        case .other: String(localized: "Meeting link")
        default: nil
        }
    }

    static func timeLabel(start: Date, end: Date, originZone: TimeZone?, viewerZone: TimeZone) -> String {
        var label = "\(StarlingsDateFormatting.time(start, timeZone: viewerZone)) – \(StarlingsDateFormatting.time(end, timeZone: viewerZone))"
        if let originZone,
           originZone.secondsFromGMT(for: start) != viewerZone.secondsFromGMT(for: start) {
            let name = offsetName(seconds: originZone.secondsFromGMT(for: start))
            label += " (\(StarlingsDateFormatting.time(start, timeZone: originZone)) \(name))"
        }
        return label
    }

    /// `GMT`, `GMT+2`, `GMT-5`, `GMT+5:30`. Written from the offset rather
    /// than asked of the platform, because "CEST" on one client and "GMT+2" on
    /// another is the drift this type exists to prevent.
    static func offsetName(seconds: Int) -> String {
        guard seconds != 0 else { return "GMT" }
        let sign = seconds < 0 ? "-" : "+"
        let minutes = abs(seconds) / 60
        let hours = minutes / 60
        let rest = minutes % 60
        return rest == 0 ? "GMT\(sign)\(hours)" : "GMT\(sign)\(hours):\(String(format: "%02d", rest))"
    }

    /// Which rows a tile of `height` can hold. The title keeps one line when a
    /// row is shown; `padding` is the tile's top and bottom inset together.
    static func rows(
        height: CGFloat,
        titleHeight: CGFloat,
        rowHeight: CGFloat,
        padding: CGFloat,
        hasLocation: Bool
    ) -> (time: Bool, location: Bool) {
        var remaining = height - padding - titleHeight
        let time = remaining >= rowHeight
        if time { remaining -= rowHeight }
        let location = hasLocation && time && remaining >= rowHeight
        return (time, location)
    }
}

/// Spoken descriptions for calendar blocks, shared by the week and month grids
/// so VoiceOver hears the same phrasing in both.
enum CalendarAccessibility {
    static func describe(_ event: StarlingsCalendarEvent, calendarName: String?) -> String {
        var parts: [String] = [event.displayTitle]

        if event.calendarRole == .globalInterest { parts.append(String(localized: "global interest")) }
        if event.isDemoted { parts.append(String(localized: "hidden from Next")) }

        if event.isAllDay {
            parts.append(String(localized: "all day"))
        } else {
            parts.append("\(StarlingsDateFormatting.time(event.start)) to \(StarlingsDateFormatting.time(event.end))")
        }

        let day = DateFormatter()
        day.locale = .current
        day.setLocalizedDateFormatFromTemplate("EEEE d MMMM")
        parts.append(day.string(from: event.start))

        if let calendarName, !calendarName.isEmpty { parts.append(calendarName) }
        if !event.location.isEmpty { parts.append(String(localized: "at \(event.location)")) }
        if let travel = CalendarTravelTime.label(minutes: event.travelTimeMinutes) { parts.append(travel) }
        if let response = event.myResponse { parts.append(response.label) }
        if let attendance = event.attendance { parts.append(attendance.label.lowercased()) }
        if event.isRecurring { parts.append("repeating") }
        if event.meetingPlatform != .none { parts.append(event.meetingPlatform.displayName) }
        if !event.joinURL.isEmpty { parts.append(String(localized: "has a meeting link")) }
        if !event.isWritable { parts.append(String(localized: "read only")) }

        return parts.joined(separator: ", ")
    }
}

/// The month a run of day columns sits in, for the window subtitle on Mac
/// and the bar on the phone. Each column head carries its own date, so the
/// title names the month rather than repeating the days as a range. A run
/// across a month boundary names both months: the heads show bare day
/// numbers, and nothing else would say which month a 1 is.
enum CalendarPeriodTitle {
    static func months(first: Date, last: Date, calendar: Calendar = .current) -> String {
        if calendar.isDate(first, equalTo: last, toGranularity: .month) {
            return first.formatted(.dateTime.month(.wide).year().locale(StarlingsDateFormatting.locale))
        }
        if calendar.isDate(first, equalTo: last, toGranularity: .year) {
            return first.formatted(.dateTime.month(.abbreviated).locale(StarlingsDateFormatting.locale))
                + " – " + last.formatted(.dateTime.month(.abbreviated).year().locale(StarlingsDateFormatting.locale))
        }
        return first.formatted(.dateTime.month(.abbreviated).year().locale(StarlingsDateFormatting.locale))
            + " – " + last.formatted(.dateTime.month(.abbreviated).year().locale(StarlingsDateFormatting.locale))
    }
}
