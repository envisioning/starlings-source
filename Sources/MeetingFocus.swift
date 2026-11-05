import Foundation
import StarlingsContracts

/// What "upcoming" means — the one definition, shared by the Mac and the phone.
///
/// One feed answers two different questions: *what should I do now*, and *what
/// is on my plate*. They are not the same list, and filling the first with the
/// head of the second is how a Friday evening ended up counting down fourteen
/// hours to Monday's standup as if it were about to start. So the agenda and the
/// hero are computed here together, once, and no surface is allowed a second
/// opinion about either.
///
/// The TypeScript port is `packages/contracts/src/upcoming.ts`. Both are pinned
/// to the same table of cases in `fixtures/upcoming-tiers.json` — that file is
/// the contract, this is one implementation of it. Change the rules there first.

/// Where an event sits relative to the viewer's day. Purely temporal, and
/// anchored to civil days rather than to a duration: at 23:50 a meeting twenty
/// minutes away is *tomorrow*, and reads completely differently from one twenty
/// minutes away at noon.
enum UpcomingTier: String, Sendable, CaseIterable {
    case now
    case today
    case tomorrow
    case ahead
    case unscheduled
}

/// The little a calendar row has to expose to be placed. Deliberately not the
/// wire type: the Mac and phone each carry their own decoded shape, while the
/// Home surfaces consume the owner-selected control-plane feed.
protocol UpcomingEvent {
    var upcomingID: String { get }
    /// Owner-selected calendar identity. Optional for rule fixtures and local
    /// adapters that do not have a shared source key.
    var upcomingCalendarID: String? { get }
    var upcomingTitle: String { get }
    /// `nil` — absent or unparseable — makes the event `unscheduled`.
    var upcomingStart: Date? { get }
    /// Without a readable end an event cannot be shown to be ahead.
    var upcomingEnd: Date? { get }
    var upcomingIsAllDay: Bool { get }
    /// Owner-wide Hide from Next state. Hidden events are omitted from Upcoming.
    var upcomingIsDemoted: Bool { get }
    /// The guest list as the feed sent it, empty when the event has no guests.
    /// `nil` means the source carries no participation facts (a widget's
    /// snapshot the app already filtered), and `MeetingFocus.isMemberEvent`
    /// does not judge it.
    var upcomingAttendees: [UpcomingAttendee]? { get }
}

extension UpcomingEvent {
    var upcomingAttendees: [UpcomingAttendee]? { nil }
}

/// What the member rule reads of one guest. `isSelf` marks the member's own row.
struct UpcomingAttendee: Equatable, Sendable {
    let status: String
    let isSelf: Bool
}

struct UpcomingPlan<Event: UpcomingEvent> {
    /// Everything still relevant, soonest first. The list.
    let agenda: [Event]
    /// Tier by event id, for rows that show their own heading or countdown.
    let tiers: [String: UpcomingTier]
    /// The agenda grouped — what section headings and summaries render from.
    let tiered: [UpcomingTier: [Event]]
    /// The hero: the countdown, the call to action, the one thing in focus.
    /// `nil` is a closed day — the surface collapses the hero to a summary and
    /// shows the rest as an ordinary list. It must never fall through to
    /// tomorrow.
    let focus: Event?

    /// The owner-wide display policy used to produce this plan.
    let preferences: UpcomingPreferencesWire

    /// The compact Home rows after the hero. Every Home surface uses this
    /// projection rather than deciding independently whether tomorrow or later
    /// events belong below the hero.
    var homeRows: [Event] {
        agenda
            .filter { $0.upcomingID != focus?.upcomingID }
            .filter { event in
                guard let tier = tier(of: event) else { return false }
                // While today is active, keep the compact card about today.
                // Once the day is closed, the same rows become tomorrow's
                // supporting summary.
                if focus != nil {
                    return tier == .now || tier == .today
                }
                return tier == .tomorrow
            }
            .prefix(preferences.homeFollowingRows)
            .map { $0 }
    }

    /// Today-tier agenda events that do not fit in the compact Home projection.
    /// This is deliberately separate from `agenda.count`: Home can have more
    /// today without asking the reader to think about the whole horizon.
    var remainingTodayCount: Int {
        remainingToday.count
    }

    /// Today-tier events hidden behind the compact Home foldout.
    var remainingToday: [Event] {
        let visibleTodayIDs = Set(
            ([focus].compactMap { $0 } + homeRows)
                .filter { event in
                    guard let tier = tier(of: event) else { return false }
                    return tier == .now || tier == .today
                }
                .map(\.upcomingID)
        )
        return (
            events(in: .now).filter { !visibleTodayIDs.contains($0.upcomingID) }
                + events(in: .today).filter { !visibleTodayIDs.contains($0.upcomingID) }
        )
    }

    func events(in tier: UpcomingTier) -> [Event] { tiered[tier] ?? [] }
    func count(_ tier: UpcomingTier) -> Int { events(in: tier).count }
    func tier(of event: Event) -> UpcomingTier? { tiers[event.upcomingID] }

    /// True when the day has nothing left that asks anything of you. Hidden
    /// events are already omitted, so an empty agenda is a closed day.
    var isDayClosed: Bool { focus == nil }

    /// The word over the hero. The config's "UPCOMING" while the meeting is
    /// still ahead; "NOW" once it has started, because a card counting down
    /// the minutes left in a call is not upcoming. Matched by `heroLabel` in
    /// packages/contracts/src/upcoming.ts.
    var heroLabel: String {
        guard let focus, tier(of: focus) == .now else {
            return UpcomingConfiguration.current.sectionTitle
        }
        return "NOW"
    }

    /// Before the first feed arrives. A closed day with an empty agenda is the
    /// honest starting state — the surfaces distinguish it from a failed load by
    /// their own "couldn't reach your calendar" flag, not by this.
    static var empty: UpcomingPlan<Event> {
        UpcomingPlan(agenda: [], tiers: [:], tiered: [:], focus: nil, preferences: .defaults)
    }
}

enum MeetingFocus {
    /// How far ahead a meeting may start and still be worth listing.
    static var horizon: TimeInterval { UpcomingConfiguration.current.horizon }

    /// How far clients read past the display horizon to avoid edge flicker.
    static var requestHours: Int { UpcomingConfiguration.current.requestHours }

    /// The number of non-hero rows a compact Home surface shows.
    static var homeFollowingRows: Int { UpcomingConfiguration.current.homeFollowingRows }

    /// The server-side cap that protects the feed from an unusually large day.
    static var maxAgendaEvents: Int { UpcomingConfiguration.current.maxAgendaEvents }

    /// How long before the start the hero grows its button.
    static var joinLead: TimeInterval { TimeInterval(UpcomingConfiguration.current.joinWindowMinutes) * 60 }

    /// Whether the hero shows a button at all. A meeting three hours out is a
    /// countdown, not a call to action — and while the hero has no button,
    /// the room card's Start holds the screen's one accent. Mirrored by
    /// `canJoin` in packages/contracts/src/upcoming.ts.
    static func canJoin(_ event: some UpcomingEvent, now: Date = Date()) -> Bool {
        guard let start = event.upcomingStart, let end = event.upcomingEnd else { return false }
        return start.addingTimeInterval(-joinLead) <= now && now < end
    }

    /// The button's words inside the window: the verb, then how long —
    /// "Join · in 4m", "Join · ends in 25m". The countdown rides the button
    /// because it is the reason the button is there.
    static func joinTitle(_ action: String, for event: some UpcomingEvent, now: Date = Date()) -> String {
        "\(action) · \(StarlingsDateFormatting.relativeCountdown(start: event.upcomingStart, end: event.upcomingEnd, now: now))"
    }

    /// Rows somebody used to defend an hour. Not meetings, never the hero.
    static func hasRealTitle(_ title: String) -> Bool {
        let normalized = title.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return !UpcomingConfiguration.current.placeholderTitles.contains(normalized)
    }

    /// Place visible events on the feed, and decide which one — if any — the
    /// viewer is actually being asked to act on.
    static func classify<Event: UpcomingEvent>(
        _ events: [Event],
        now: Date = Date(),
        calendar: Calendar = .current,
        horizon: TimeInterval? = nil,
        preferences: UpcomingPreferencesWire = .defaults
    ) -> UpcomingPlan<Event> {
        let resolvedPreferences = preferences.normalizedForHome
        let resolvedHorizon = horizon ?? resolvedPreferences.horizon
        let startOfToday = calendar.startOfDay(for: now)
        // Judge each copy before copies collapse, so the copy that survives is
        // one on the member's own calendar.
        let agenda = consolidate(events.filter { isMemberEvent($0) })
            .filter { onAgenda($0, now: now, horizon: resolvedHorizon) }
            .filter {
                let tier = tierOf($0, now: now, startOfToday: startOfToday, calendar: calendar)
                return tier == .now || tier == .today || tier == .tomorrow
            }
            .sorted { isSoonerThan($0, $1) }

        var tiers: [String: UpcomingTier] = [:]
        var tiered: [UpcomingTier: [Event]] = [:]
        for event in agenda {
            let tier = tierOf(event, now: now, startOfToday: startOfToday, calendar: calendar)
            tiers[event.upcomingID] = tier
            tiered[tier, default: []].append(event)
        }

        let focus = agenda.first { canFocus($0, tier: tiers[$0.upcomingID]) }
        return UpcomingPlan(
            agenda: agenda,
            tiers: tiers,
            tiered: tiered,
            focus: focus,
            preferences: resolvedPreferences
        )
    }

    /// Whether Home shows this event to the member at all: they organize it or
    /// attend it and have not declined. The rule and its reasons are
    /// `isMemberEvent` in packages/contracts/src/upcoming.ts; the cases are in
    /// fixtures/upcoming-tiers.json.
    ///
    /// Own calendar (`primary`, `acct:<account>:primary`): stays unless the
    /// member's `self` row is declined. Subscribed feed (`sub:`): stays. Any
    /// other calendar: dropped. No calendar id or no guest list: stays.
    static func isMemberEvent(_ event: some UpcomingEvent) -> Bool {
        guard let attendees = event.upcomingAttendees else { return true }
        let calendarID = event.upcomingCalendarID?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !calendarID.isEmpty else { return true }
        // The subscription prefix of packages/contracts/src/calendar-keys.ts.
        // `CalendarKeys` is not in the widget and watch targets that build
        // this file, so the prefix is spelled here.
        if calendarID.hasPrefix("sub:") { return true }
        guard isOwnPrimaryCalendar(calendarID) else { return false }
        return !attendees.contains { $0.isSelf && $0.status == "declined" }
    }

    private static func isOwnPrimaryCalendar(_ calendarID: String) -> Bool {
        guard calendarID.hasPrefix("acct:") else { return calendarID == "primary" }
        // `acct:<account>:<calendar>`: the account id holds no colon.
        let parts = calendarID.split(separator: ":", maxSplits: 2, omittingEmptySubsequences: false)
        return parts.count == 3 && !parts[1].isEmpty && parts[2] == "primary"
    }

    /// The same event can be returned once per selected calendar. Collapse
    /// cross-calendar copies, while preserving two genuinely separate copies
    /// on the same calendar. This belongs here so Mac, iOS, and the web do not
    /// disagree about the number of meetings in the compact Home projection.
    private static func consolidate<Event: UpcomingEvent>(_ events: [Event]) -> [Event] {
        var order: [String] = []
        var byKey: [String: [Event]] = [:]

        for event in events {
            let key = fingerprint(event)
            if byKey[key] == nil { order.append(key) }
            byKey[key, default: []].append(event)
        }

        return order.flatMap { key in
            let members = byKey[key] ?? []
            let sourceCalendar: String? = members
                .compactMap { member in
                    let calendarID = member.upcomingCalendarID?.trimmingCharacters(in: .whitespacesAndNewlines)
                    return calendarID?.isEmpty == false ? calendarID : nil
                }
                .first
            return members.filter { member in
                guard let sourceCalendar else { return true }
                let calendarID = member.upcomingCalendarID?.trimmingCharacters(in: .whitespacesAndNewlines)
                guard calendarID?.isEmpty == false else { return true }
                // One event copied onto another selected calendar is still one
                // Home row. A second copy on the same calendar is a distinct
                // calendar row and must remain visible.
                return calendarID == sourceCalendar
            }
        }
    }

    private static func fingerprint<Event: UpcomingEvent>(_ event: Event) -> String {
        let title = event.upcomingTitle
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        let calendarID = event.upcomingCalendarID?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard calendarID?.isEmpty == false,
              let start = event.upcomingStart,
              let end = event.upcomingEnd else {
            return "unparseable|\(calendarID ?? "")|\(event.upcomingID)"
        }
        return [
            title,
            String(start.timeIntervalSince1970),
            String(end.timeIntervalSince1970),
            String(event.upcomingIsAllDay),
        ].joined(separator: "|")
    }

    /// Still ahead, a real meeting, and near enough to be worth a row.
    private static func onAgenda(_ event: some UpcomingEvent, now: Date, horizon: TimeInterval) -> Bool {
        guard !event.upcomingIsDemoted else { return false }
        guard !event.upcomingIsAllDay else { return false }
        guard let end = event.upcomingEnd, end > now else { return false }
        guard hasRealTitle(event.upcomingTitle) else { return false }
        guard let start = event.upcomingStart else { return true }
        return start <= now.addingTimeInterval(horizon)
    }

    private static func tierOf(
        _ event: some UpcomingEvent,
        now: Date,
        startOfToday: Date,
        calendar: Calendar
    ) -> UpcomingTier {
        guard let start = event.upcomingStart else { return .unscheduled }
        // An offsite spanning the whole day is not something you are five
        // minutes late for, so it is never "now" even while it is happening.
        if !event.upcomingIsAllDay, start <= now { return .now }
        let offset = calendar.dateComponents(
            [.day],
            from: startOfToday,
            to: calendar.startOfDay(for: start)
        ).day ?? 0
        if offset <= 0 { return .today }
        if offset == 1 { return .tomorrow }
        return .ahead
    }

    /// What the hero slot will accept. Note what is *not* on this list: having a
    /// video link. An in-person meeting is still what is next — it simply has no
    /// button, which is a question about the call to action, not about focus.
    private static func canFocus(_ event: some UpcomingEvent, tier: UpcomingTier?) -> Bool {
        guard tier == .now || tier == .today else { return false }
        return !event.upcomingIsDemoted && !event.upcomingIsAllDay
    }

    /// Soonest first, and everything undated after everything dated — an event
    /// whose date is still being agreed cannot sit above a meeting this
    /// afternoon. Ties break on id so two meetings at the same minute keep one
    /// order across a refresh, and across clients.
    private static func isSoonerThan(_ left: some UpcomingEvent, _ right: some UpcomingEvent) -> Bool {
        switch (left.upcomingStart, right.upcomingStart) {
        case let (leftStart?, rightStart?):
            if leftStart != rightStart { return leftStart < rightStart }
        case (_?, nil):
            return true
        case (nil, _?):
            return false
        case (nil, nil):
            let leftEnd = left.upcomingEnd ?? .distantFuture
            let rightEnd = right.upcomingEnd ?? .distantFuture
            if leftEnd != rightEnd { return leftEnd < rightEnd }
        }
        return left.upcomingID < right.upcomingID
    }
}

extension MeetingFocus {
    /// What a surface says where the hero would have been. The words are matched
    /// by `closedDaySummary` in packages/contracts/src/upcoming.ts — a closed day
    /// that reads three different ways on three clients is the same bug as a
    /// hero that reads three different ways.
    ///
    /// "Nothing left today" rather than "day's done": it is equally true at six
    /// in the morning on a clear day, and the hero is empty then too. Tomorrow
    /// is useful context; meetings farther ahead stay in Calendar rather than
    /// taking over the idle surface's one-line answer.
    static func closedDaySummary<Event: UpcomingEvent>(
        _ plan: UpcomingPlan<Event>,
        calendar: Calendar = .current
    ) -> String {
        guard !plan.agenda.isEmpty else {
            return String(localized: "Nothing scheduled today or tomorrow.")
        }
        guard plan.preferences.showTomorrow else {
            return String(localized: "Nothing left today.")
        }
        let tomorrow = plan.events(in: .tomorrow)
        if let first = tomorrow.first, let start = first.upcomingStart {
            let time = shortTime(start, calendar: calendar)
            return tomorrow.count == 1
                ? String(localized: "Nothing left today. 1 tomorrow, at \(time).")
                : String(localized: "Nothing left today. \(tomorrow.count) tomorrow, first at \(time).")
        }
        if !tomorrow.isEmpty {
            return tomorrow.count == 1
                ? String(localized: "Nothing left today. 1 tomorrow.")
                : String(localized: "Nothing left today. \(tomorrow.count) tomorrow.")
        }
        return String(localized: "Nothing left today.")
    }

    private static func shortTime(_ date: Date, calendar: Calendar) -> String {
        StarlingsDateFormatting.time(date, timeZone: calendar.timeZone)
    }
}
