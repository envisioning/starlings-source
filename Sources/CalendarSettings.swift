import Foundation

/// The stable identifiers used by every calendar settings surface. Views may
/// choose AppKit or SwiftUI controls, but they do not invent a second list of
/// settings, a second order, or a second answer to "does this sync?".
enum CalendarSettingID: String, CaseIterable, Hashable, Identifiable, Sendable {
    case googleCalendar
    case googleCalendarSync
    case calendarSources
    case calendarDisplay
    case calendarWeather
    case calendarLayers
    case defaultWriteCalendar
    case bookingHours

    var id: String { rawValue }
}

enum CalendarSettingGroup: String, CaseIterable, Hashable, Sendable {
    case accountsAndSources = "Accounts & sources"
    case upcoming = "Upcoming"
    case display = "Display"
    case behavior = "Calendar behavior"
    case booking = "Booking"

    var title: String { rawValue }
}

/// Owner settings are stored by the control plane and appear on both devices;
/// device settings stay in that device's UserDefaults. This is deliberately
/// explicit because a new UI must not infer sync from where it happens to live.
enum CalendarSettingScope: String, Hashable, Sendable {
    case ownerSynced
    case deviceLocal
}

enum CalendarSettingSurface: String, Hashable, Sendable {
    case macSettings
    case macCalendarSidebar
    case iosCalendarSources
    case iosCalendarDisplay
}

enum CalendarSettingControl: String, Hashable, Sendable {
    case connection
    case syncPicker
    case sourceGroups
    case display
    case weather
    case layers
    case defaultCalendar
    case bookingHours
}

struct CalendarSettingDefinition: Equatable, Identifiable, Sendable {
    let id: CalendarSettingID
    let group: CalendarSettingGroup
    let title: String
    let scope: CalendarSettingScope
    let surfaces: Set<CalendarSettingSurface>
    let control: CalendarSettingControl
}

/// Registry of settings metadata shared by the macOS and iOS surfaces.
///
/// The registry is intentionally data-only. Platform renderers own layout and
/// controls, while this table owns the product contract: identity, order,
/// grouping, naming, and whether a value is owner-wide or device-local.
enum CalendarSettingsRegistry {
    static let all: [CalendarSettingDefinition] = [
        .init(
            id: .googleCalendar,
            group: .accountsAndSources,
            title: String(localized: "Google Calendar"),
            scope: .ownerSynced,
            surfaces: [.macSettings, .iosCalendarSources],
            control: .connection
        ),
        .init(
            id: .googleCalendarSync,
            group: .upcoming,
            title: String(localized: "Show in Upcoming"),
            scope: .ownerSynced,
            surfaces: [.macSettings, .iosCalendarSources],
            control: .syncPicker
        ),
        .init(
            id: .calendarSources,
            group: .accountsAndSources,
            title: String(localized: "Calendars in Starlings"),
            scope: .ownerSynced,
            surfaces: [.macSettings, .iosCalendarSources],
            control: .sourceGroups
        ),
        .init(
            id: .calendarDisplay,
            group: .display,
            title: String(localized: "Calendar display"),
            scope: .deviceLocal,
            surfaces: [.macSettings, .iosCalendarDisplay],
            control: .display
        ),
        .init(
            id: .calendarWeather,
            group: .display,
            title: String(localized: "Weather"),
            scope: .deviceLocal,
            surfaces: [.macSettings, .iosCalendarDisplay],
            control: .weather
        ),
        .init(
            id: .calendarLayers,
            group: .behavior,
            title: String(localized: "\(StarlingsWorkspace.active.name) layers"),
            scope: .deviceLocal,
            surfaces: [.macCalendarSidebar, .iosCalendarSources],
            control: .layers
        ),
        .init(
            id: .defaultWriteCalendar,
            group: .behavior,
            title: String(localized: "New events"),
            scope: .deviceLocal,
            surfaces: [.macCalendarSidebar, .iosCalendarSources],
            control: .defaultCalendar
        ),
        // The member's booking page hours. The web edits the same
        // row under Settings › Calendar.
        .init(
            id: .bookingHours,
            group: .booking,
            title: String(localized: "Booking hours"),
            scope: .ownerSynced,
            surfaces: [.macSettings, .iosCalendarSources],
            control: .bookingHours
        ),
    ]

    static func definition(for id: CalendarSettingID) -> CalendarSettingDefinition {
        guard let definition = all.first(where: { $0.id == id }) else {
            preconditionFailure("Calendar setting registry is missing \(id.rawValue)")
        }
        return definition
    }

    static func title(for id: CalendarSettingID) -> String {
        definition(for: id).title
    }

    static func definitions(for surface: CalendarSettingSurface) -> [CalendarSettingDefinition] {
        all.filter { $0.surfaces.contains(surface) }
    }
}

/// The settings error shared by the Mac and iOS calendar editors.
enum CalendarSettingsError: LocalizedError, Equatable, Sendable {
    case atLeastOneGoogleCalendar

    var errorDescription: String? {
        switch self {
        case .atLeastOneGoogleCalendar:
            return String(localized: "Keep at least one Google calendar enabled for Upcoming.")
        }
    }
}

/// A source group is the unit the settings screens present: one Google account,
/// one local calendar store, or the shared subscription shelf. The group is
/// deliberately platform-neutral so AppKit and SwiftUI cannot grow different
/// account ordering or grouping rules.
struct CalendarSourceGroup: Identifiable, Equatable, Sendable {
    let title: String
    let source: StarlingsCalendar.Source
    let calendars: [StarlingsCalendar]

    var id: String { "\(source.rawValue):\(title)" }

    var symbolName: String {
        switch source {
        case .google: return "person.crop.circle"
        case .eventKit: return "laptopcomputer"
        case .subscription: return "link"
        }
    }

    /// Stable reading order shared by Settings and the iOS Calendars sheet.
    /// The input order is not used: EventKit and network responses are allowed
    /// to arrive in different orders on the two devices.
    static func ordered(_ calendars: [StarlingsCalendar]) -> [CalendarSourceGroup] {
        let grouped = Dictionary(grouping: calendars, by: \.groupTitle)

        return grouped.map { key, members in
            CalendarSourceGroup(
                title: key,
                source: members.first?.source ?? .eventKit,
                calendars: members.sorted { left, right in
                    let titleOrder = left.title.localizedCaseInsensitiveCompare(right.title)
                    if titleOrder != .orderedSame { return titleOrder == .orderedAscending }
                    return left.id < right.id
                }
            )
        }.sorted { left, right in
            let leftRank = rank(for: left)
            let rightRank = rank(for: right)
            if leftRank != rightRank { return leftRank < rightRank }
            let titleOrder = left.title.localizedCaseInsensitiveCompare(right.title)
            if titleOrder != .orderedSame { return titleOrder == .orderedAscending }
            return left.id < right.id
        }
    }

    private static func rank(for group: CalendarSourceGroup) -> Int {
        if group.source == .google, group.title == "Google" { return 0 }
        if group.source == .eventKit, group.title.hasPrefix("On My ") { return 2 }
        if group.source == .subscription { return 3 }
        return 1
    }
}

/// The platform-neutral rules for the two calendar questions:
///
/// - disabled: whether a source belongs in Meet at all; owner-wide and synced
/// - hidden: whether an enabled source is drawn; owner-wide and synced
///
/// `CalendarWorkspace` persists and syncs this value. Keeping the mutations in
/// a value type makes account-vs-calendar behaviour identical on both clients
/// and gives it a small, deterministic test surface.
struct CalendarSourceSettings: Equatable, Sendable {
    var hiddenKeys: Set<String>
    var disabledKeys: Set<String>

    init(hiddenKeys: Set<String> = [], disabledKeys: Set<String> = []) {
        self.hiddenKeys = hiddenKeys
        self.disabledKeys = disabledKeys
    }

    func isHidden(_ calendar: StarlingsCalendar) -> Bool {
        hiddenKeys.contains(calendar.visibilityKey)
            || hiddenKeys.contains(StarlingsCalendar.accountVisibilityKey(calendar.groupTitle))
    }

    func isDisabled(_ calendar: StarlingsCalendar) -> Bool {
        disabledKeys.contains(calendar.visibilityKey)
            || disabledKeys.contains(StarlingsCalendar.accountVisibilityKey(calendar.groupTitle))
    }

    func isAccountHidden(_ group: String, calendars: [StarlingsCalendar]) -> Bool {
        if hiddenKeys.contains(StarlingsCalendar.accountVisibilityKey(group)) { return true }
        let members = calendars.filter { $0.groupTitle == group }
        return !members.isEmpty && members.allSatisfy { isHidden($0) }
    }

    func isAccountDisabled(_ group: String, calendars: [StarlingsCalendar]) -> Bool {
        if disabledKeys.contains(StarlingsCalendar.accountVisibilityKey(group)) { return true }
        let members = calendars.filter { $0.groupTitle == group }
        return !members.isEmpty && members.allSatisfy { isDisabled($0) }
    }

    // The rules live in `CalendarKeys` (packages/contracts/src/calendar-keys.ts, pinned by
    // fixtures/calendar-keys.json): turning one calendar back on inside an account that was
    // switched off wholesale expands the account key into per-calendar keys, keeping the rest.

    mutating func setHidden(_ calendar: StarlingsCalendar, hidden: Bool, calendars: [StarlingsCalendar]) {
        hiddenKeys = CalendarKeys.withCalendarHidden(
            hiddenKeys,
            calendarKey: calendar.visibilityKey,
            accountKey: StarlingsCalendar.accountVisibilityKey(calendar.groupTitle),
            siblingKeys: siblingKeys(of: calendar, in: calendars),
            hidden: hidden
        )
    }

    mutating func setAccountHidden(_ group: String, hidden: Bool, calendars: [StarlingsCalendar]) {
        hiddenKeys = CalendarKeys.withAccountHidden(
            hiddenKeys,
            accountKey: StarlingsCalendar.accountVisibilityKey(group),
            memberKeys: memberKeys(of: group, in: calendars),
            hidden: hidden
        )
    }

    mutating func setDisabled(_ calendar: StarlingsCalendar, disabled: Bool, calendars: [StarlingsCalendar]) {
        disabledKeys = CalendarKeys.withCalendarHidden(
            disabledKeys,
            calendarKey: calendar.visibilityKey,
            accountKey: StarlingsCalendar.accountVisibilityKey(calendar.groupTitle),
            siblingKeys: siblingKeys(of: calendar, in: calendars),
            hidden: disabled
        )
    }

    mutating func setAccountDisabled(_ group: String, disabled: Bool, calendars: [StarlingsCalendar]) {
        disabledKeys = CalendarKeys.withAccountHidden(
            disabledKeys,
            accountKey: StarlingsCalendar.accountVisibilityKey(group),
            memberKeys: memberKeys(of: group, in: calendars),
            hidden: disabled
        )
    }

    private func siblingKeys(of calendar: StarlingsCalendar, in calendars: [StarlingsCalendar]) -> [String] {
        calendars
            .filter { $0.groupTitle == calendar.groupTitle && $0.id != calendar.id }
            .map(\.visibilityKey)
    }

    private func memberKeys(of group: String, in calendars: [StarlingsCalendar]) -> [String] {
        calendars.filter { $0.groupTitle == group }.map(\.visibilityKey)
    }
}

extension CalendarSourcePreferences {
    private static let hiddenKey = "meet.calendar.hiddenKeys"

    static func hidden(defaults: UserDefaults = .standard) -> Set<String> {
        Set(defaults.stringArray(forKey: hiddenKey) ?? [])
    }

    static func setHidden(_ keys: Set<String>, defaults: UserDefaults = .standard) {
        defaults.set(Array(keys).sorted(), forKey: hiddenKey)
        NotificationCenter.default.post(name: didChange, object: nil)
    }
}

extension CalendarWorkspace {
    /// The same grouped settings model is consumed by the Mac Settings page and
    /// the iOS Calendar settings destinations. Views still decide how rows look
    /// and behave.
    var sourceGroups: [CalendarSourceGroup] {
        CalendarSourceGroup.ordered(allCalendars)
    }
}
