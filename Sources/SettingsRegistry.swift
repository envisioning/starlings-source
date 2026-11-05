import Foundation

/// The shared top-level settings vocabulary. macOS renders the host-oriented
/// pages; iOS renders the settings that make sense on a join-only device and
/// gives Calendar a root destination with its own grouped settings.
enum StarlingsSettingID: Int, CaseIterable, Hashable, Identifiable, Sendable {
    case account
    case home
    case work
    case calendar
    case video
    case audio
    case captions
    case meetings
    case room
    case notifications
    case calls
    case appearance
    case appLock
    case about
    case developmentServer

    var id: Int { rawValue }
}

/// The headings every client draws the page list under, in order
/// (`SETTINGS_GROUPS` in `packages/contracts/src/settings-pages.ts`).
enum StarlingsSettingsGroup: String, CaseIterable, Hashable, Sendable {
    case account
    case preferences
    case security
    case system

    var title: String {
        switch self {
        case .account: String(localized: "Account")
        case .preferences: String(localized: "Preferences")
        case .security: String(localized: "Security")
        case .system: String(localized: "System")
        }
    }
}

enum StarlingsSettingsSurface: String, CaseIterable, Hashable, Sendable {
    case macSettingsSidebar
    case iosSettings
    case iosCalendarSettings
}

enum StarlingsSettingsControl: String, Hashable, Sendable {
    case account
    /// What Home is made of: module order and visibility, owner-synced
    /// (`fixtures/home-layout.json`), plus the Upcoming density knob that
    /// used to sit under Calendar.
    case home
    /// What Work's rail is made of: the SALES opt-in (owner-synced,
    /// `sales_enabled`) and the blocks' order and visibility (this Mac).
    case work
    case calendarShortcut
    case macPage
    /// Speech-model status and download. The Mac renders it inside its Captions
    /// page; the phone renders it as its own section, because a half-gigabyte
    /// download over cellular is a decision worth putting in front of somebody.
    case transcription
    /// The permanent room's standing guest policy. It is configured in
    /// Settings because it applies to the room, not to a single waiting-room
    /// decision.
    case roomPolicy
    case notifications
    case calls
    case appearance
    case appLock
    case about
    case developmentServer
}

struct StarlingsSettingDefinition: Equatable, Identifiable, Sendable {
    let id: StarlingsSettingID
    let group: StarlingsSettingsGroup
    let title: String
    let symbolName: String
    let surfaces: Set<StarlingsSettingsSurface>
    let control: StarlingsSettingsControl
}

/// Where one page sits: its group and the surfaces that show it, in the table generated from
/// `packages/contracts/src/settings-pages.ts` (Sources/Generated/SettingsPagesRegistry.swift).
struct StarlingsSettingPlacement: Equatable, Sendable {
    let id: StarlingsSettingID
    let group: StarlingsSettingsGroup
    let surfaces: Set<StarlingsSettingsSurface>
}

/// One ordered inventory for the top-level settings taxonomy. Platform views
/// choose their native presentation, but they cannot silently rename or
/// reorder a shared destination without changing the TypeScript table, which
/// holds the pages, their groups and order and the surfaces; the words, glyphs
/// and controls stay below.
///
/// Icon rule, shared with the Core app so both settings surfaces read as one
/// family: one glyph per concept, no two rows on the same glyph, and the
/// filled variant whenever SF Symbols ships one. `calendar` has no filled
/// variant, so it stays plain.
enum StarlingsSettingsRegistry {
    static let all: [StarlingsSettingDefinition] = placements.map { placement in
        let page = words(for: placement.id)
        return StarlingsSettingDefinition(
            id: placement.id,
            group: placement.group,
            title: page.title,
            symbolName: page.symbolName,
            surfaces: placement.surfaces,
            control: page.control
        )
    }

    /// What a page is called, its glyph, and the control that draws it. Exhaustive, so a page
    /// added to the table fails to compile until it has its words.
    private static func words(for id: StarlingsSettingID) -> (title: String, symbolName: String, control: StarlingsSettingsControl) {
        switch id {
        case .account: (String(localized: "Account"), "person.crop.circle.fill", .account)
        case .home: (String(localized: "Home"), "house.fill", .home)
        case .work: (String(localized: "Work"), "tray.full.fill", .work)
        case .calendar: (String(localized: "Calendar"), "calendar", .calendarShortcut)
        case .video: (String(localized: "Video"), "video.fill", .macPage)
        case .audio: (String(localized: "Audio"), "mic.fill", .macPage)
        case .captions: (String(localized: "Captions"), "captions.bubble.fill", .transcription)
        case .meetings: (String(localized: "Meetings"), "record.circle", .macPage)
        case .room: (String(localized: "Room"), "door.left.hand.open", .roomPolicy)
        case .notifications: (String(localized: "Notifications"), "bell.fill", .notifications)
        case .calls: (String(localized: "Calls"), "phone.fill", .calls)
        case .appearance: (String(localized: "Appearance"), "circle.lefthalf.filled", .appearance)
        case .appLock: (String(localized: "App lock"), "lock.fill", .appLock)
        case .about: (String(localized: "About"), "info.circle.fill", .about)
        case .developmentServer: (String(localized: "Development server"), "wrench.and.screwdriver.fill", .developmentServer)
        }
    }

    static func definition(for id: StarlingsSettingID) -> StarlingsSettingDefinition {
        guard let definition = all.first(where: { $0.id == id }) else {
            preconditionFailure("Meet settings registry is missing \(id.rawValue)")
        }
        return definition
    }

    static func title(for id: StarlingsSettingID) -> String {
        definition(for: id).title
    }

    static func definitions(for surface: StarlingsSettingsSurface) -> [StarlingsSettingDefinition] {
        all.filter { $0.surfaces.contains(surface) }
    }

    /// The groups one surface draws, each with its pages in order; a group with no page is left out.
    static func groups(
        for surface: StarlingsSettingsSurface,
        including include: (StarlingsSettingDefinition) -> Bool = { _ in true }
    ) -> [(group: StarlingsSettingsGroup, definitions: [StarlingsSettingDefinition])] {
        let definitions = definitions(for: surface).filter(include)
        return StarlingsSettingsGroup.allCases.compactMap { group in
            let rows = definitions.filter { $0.group == group }
            return rows.isEmpty ? nil : (group, rows)
        }
    }
}
