import Foundation
import StarlingsContracts

/// The stable ids of what Home is made of. The order of `allCases` is the
/// default order — `fixtures/home-layout.json` `modules`, which
/// `HomeLayoutFixtureTests` holds this file to.
enum HomeModuleID: String, CaseIterable, Codable, Hashable, Sendable {
    case messages
    case work
    case commercial
    case notes
    case agenda
    case events
    case room
    /// What you opened last and starred: starred rows lead, then the same
    /// per-device list the ⌘K palette ranks by (`SearchRecents`).
    case recent
}

struct HomeModuleDefinition: Equatable, Sendable {
    let id: HomeModuleID
    /// Settings row title. A surface's own card header keeps its own spelling.
    let title: String
    let detail: String
    let enabledByDefault: Bool
    /// Rows the module lists, and draws as placeholders while it waits
    /// (fixture DENSITY). Nil for a module that is not a capped list.
    let rows: Int?
    /// False for the room: Start is the primary action on the native apps.
    let canHide: Bool
    /// SHOW in the fixture: true when the card draws with nothing to list
    /// (the room, the notes capture, the agenda). False when a card with
    /// nothing to say draws nothing. Every surface asks `HomeLayout.draws`.
    let showsEmpty: Bool
}

/// One row of the stored list, and of the resolved one.
struct HomeModuleSetting: Equatable, Hashable, Codable, Sendable, Identifiable {
    var id: HomeModuleID
    var enabled: Bool
}

/// What Home is made of and the order it is drawn in — one answer for Mac,
/// iOS and web. Pinned by `fixtures/home-layout.json`; the TypeScript port
/// (`packages/contracts/src/home-layout.ts`) reads the same file.
///
/// The person owns the order and which modules show; Quick Access is always
/// last but can be hidden. The Worker stores the list behind
/// `/api/home/preferences`; every client resolves what it reads
/// through `resolve`, so a module that ships tomorrow reaches a layout stored
/// today without a migration, and an id a newer build wrote is ignored rather
/// than drawn blank by an older one.
enum HomeLayout {
    // `modules` is the table: Sources/Generated/HomeLayoutRegistry.swift, generated from
    // `packages/contracts/src/home-layout-values.ts` with the words String(localized:)-wrapped.

    static func definition(for id: HomeModuleID) -> HomeModuleDefinition {
        guard let found = modules.first(where: { $0.id == id }) else {
            preconditionFailure("home-layout: no module \(id.rawValue)")
        }
        return found
    }

    /// The one count for a list module: its cap and its skeleton. A module
    /// with no cap has no list to size, so asking for it is a mistake.
    static func rows(for id: HomeModuleID) -> Int {
        guard let rows = definition(for: id).rows else {
            preconditionFailure("home-layout: \(id.rawValue) is not a capped list")
        }
        return rows
    }

    /// SHOW in the fixture: whether a visible module draws, given whether it
    /// has anything to list. `homeModuleDraws` on the web; pinned by
    /// `showCases`.
    static func draws(_ id: HomeModuleID, hasContent: Bool) -> Bool {
        hasContent || definition(for: id).showsEmpty
    }

    static let defaults: [HomeModuleSetting] = modules.map {
        HomeModuleSetting(id: $0.id, enabled: $0.enabledByDefault)
    }

    /// RESOLVE in the fixture: stored order wins for the ids it names, unknown
    /// ids and later duplicates go, missing modules slot in after their nearest
    /// present default predecessor (walking the missing ones in default
    /// order), and a module that cannot hide is enabled regardless.
    static func resolve(_ stored: [HomeModuleSettingWire]?) -> [HomeModuleSetting] {
        var result: [HomeModuleSetting] = []
        var seen: Set<HomeModuleID> = []
        var firstStoredID: [HomeModuleID: String] = [:]
        for row in stored ?? [] {
            // `starred` was a separate Home module through 5.5.4. Keep its
            // visibility when an old layout arrives.
            let id: HomeModuleID
            if row.id == "starred" {
                id = .recent
            } else if let known = HomeModuleID(rawValue: row.id) {
                id = known
            } else {
                continue
            }
            if seen.contains(id) {
                // The two old modules now name one list. Keep it visible when
                // either old module was enabled.
                if id == .recent, firstStoredID[id] != row.id,
                   let index = result.firstIndex(where: { $0.id == id }) {
                    result[index].enabled = result[index].enabled || row.enabled
                }
                continue
            }
            seen.insert(id)
            firstStoredID[id] = row.id
            result.append(HomeModuleSetting(id: id, enabled: definition(for: id).canHide ? row.enabled : true))
        }
        for (index, module) in modules.enumerated() where !seen.contains(module.id) {
            seen.insert(module.id)
            var at = 0
            for back in stride(from: index - 1, through: 0, by: -1) {
                if let predecessor = result.firstIndex(where: { $0.id == modules[back].id }) {
                    at = predecessor + 1
                    break
                }
            }
            result.insert(HomeModuleSetting(id: module.id, enabled: module.enabledByDefault), at: at)
        }
        // Quick Access spans the Home grid, so it always sits below the columns.
        if let recentIndex = result.firstIndex(where: { $0.id == .recent }), recentIndex != result.count - 1 {
            result.append(result.remove(at: recentIndex))
        }
        return result
    }

    static func resolve(_ stored: [HomeModuleSetting]) -> [HomeModuleSetting] {
        resolve(stored.map { HomeModuleSettingWire(id: $0.id.rawValue, enabled: $0.enabled) })
    }

    /// The modules a surface draws, in order: enabled, and, for a module
    /// that draws a work module's data, one of those work modules on in the
    /// workspace (`workModules`). Nil work modules, an older
    /// Worker's answer, draw every enabled module.
    static func visible(_ layout: [HomeModuleSetting], workModules: [WorkModule]? = nil) -> [HomeModuleID] {
        offered(layout, workModules: workModules).filter(\.enabled).map(\.id)
    }

    /// Settings offers every ungated row, including one the person disabled.
    static func offered(_ layout: [HomeModuleSetting], workModules: [WorkModule]? = nil) -> [HomeModuleSetting] {
        layout.filter { row in
            guard let workModules, let needs = Self.workModules[row.id] else { return true }
            return needs.contains { workModules.contains($0) }
        }
    }

    /// One jump list across owner-level favorites and this device's recents.
    /// Keep each source's existing order inside its weight group.
    static func mergeRecentRows(_ recentRows: [SearchRow], starredRows: [SearchRow]) -> [SearchRow] {
        var seen: Set<String> = []
        return (starredRows + recentRows).filter { seen.insert($0.key).inserted }
    }

    /// The Inbox card's order (`messages`): invitations, decisions and
    /// questions first, in the order given (INBOX sends invitations first,
    /// the soonest event first), then everything else newest first; ties keep the
    /// order given. `orderHomeInbox` in packages/contracts; pinned by
    /// `inboxOrderCases` in fixtures/home-layout.json.
    static func orderInbox<Row>(_ rows: [Row], pinned: (Row) -> Bool, at: (Row) -> Double) -> [Row] {
        let indexed = Array(rows.enumerated())
        let first = indexed.filter { pinned($0.element) }
        let rest = indexed.filter { !pinned($0.element) }.sorted {
            let lhs = at($0.element)
            let rhs = at($1.element)
            return lhs != rhs ? lhs > rhs : $0.offset < $1.offset
        }
        return (first + rest).map(\.element)
    }

    /// Two-column packing, shared by the Mac and the phone. `modules` are
    /// the ones that draw, in the person's order; `heights` their measured
    /// heights. Tallest first, each to the shorter column, so the columns
    /// end close in height. Order holds inside a column, not across them.
    /// A module without a height goes to the shorter column last, so a
    /// late answer never defaults into the left side. `true` means right.
    /// Its result is never `columnsLopsided`.
    static func packColumns(_ modules: [HomeModuleID], heights: [HomeModuleID: CGFloat], gap: CGFloat) -> [HomeModuleID: Bool] {
        var leftHeight: CGFloat = 0
        var rightHeight: CGFloat = 0
        var assignment: [HomeModuleID: Bool] = [:]
        let measured = modules.filter { (heights[$0] ?? 0) > 0 }
        // Stable on the person's order for equal heights.
        let byHeight = measured.enumerated().sorted {
            let lhs = heights[$0.element] ?? 0
            let rhs = heights[$1.element] ?? 0
            return lhs != rhs ? lhs > rhs : $0.offset < $1.offset
        }.map(\.element)
        for module in byHeight {
            let height = heights[module] ?? 0
            let goesRight = rightHeight < leftHeight
            assignment[module] = goesRight
            if goesRight {
                rightHeight += height + gap
            } else {
                leftHeight += height + gap
            }
        }
        for module in modules where assignment[module] == nil {
            assignment[module] = rightHeight < leftHeight
        }
        return assignment
    }

    /// A placement a surface must pack again: a card in the taller column,
    /// plus the gap, is at most half the difference between the columns, or
    /// a measured card has no column. A card with no height does not count.
    /// `homeColumnsLopsided` in the TypeScript port.
    static func columnsLopsided(_ modules: [HomeModuleID], heights: [HomeModuleID: CGFloat], assignment: [HomeModuleID: Bool], gap: CGFloat) -> Bool {
        var leftHeight: CGFloat = 0
        var rightHeight: CGFloat = 0
        var leftCards: [CGFloat] = []
        var rightCards: [CGFloat] = []
        for module in modules {
            let height = heights[module] ?? 0
            guard height > 0 else { continue }
            guard let goesRight = assignment[module] else { return true }
            if goesRight {
                rightHeight += height + gap
                rightCards.append(height)
            } else {
                leftHeight += height + gap
                leftCards.append(height)
            }
        }
        let difference = abs(leftHeight - rightHeight)
        let taller = leftHeight >= rightHeight ? leftCards : rightCards
        return taller.contains { 2 * ($0 + gap) <= difference }
    }

    enum MoveDirection { case up, down }

    /// Move one module up or down one place; a move off either end is a no-op.
    static func move(_ layout: [HomeModuleSetting], _ id: HomeModuleID, _ direction: MoveDirection, workModules: [WorkModule]? = nil) -> [HomeModuleSetting] {
        let offered = Self.offered(layout, workModules: workModules)
        guard let at = offered.firstIndex(where: { $0.id == id }) else { return layout }
        let target = direction == .up ? at - 1 : at + 1
        guard id != .recent, offered.indices.contains(target), offered[target].id != .recent else { return layout }
        guard let from = layout.firstIndex(where: { $0.id == id }) else { return layout }
        guard let to = layout.firstIndex(where: { $0.id == offered[target].id }) else { return layout }
        var next = layout
        next.swapAt(from, to)
        return next
    }
}

// MARK: - Wire

/// A stored row as the Worker sends it. `id` is a string here on purpose:
/// an id this build does not know is dropped by `resolve`, never a decode
/// failure that blanks the whole screen.
/// `GET` and `PUT /api/home/preferences`: the generated `HomePreferencesResponse`
/// carries `HomeModuleSettingWire` rows; every client resolves them here.
extension HomePreferencesResponse {
    var layout: [HomeModuleSetting] { HomeLayout.resolve(modules) }
}

/// `PUT /api/home/preferences` body is the generated `HomePreferencesUpdate`.
extension HomePreferencesUpdate {
    init(_ layout: [HomeModuleSetting]) {
        self.init(modules: layout.map { HomeModuleSettingWire(id: $0.id.rawValue, enabled: $0.enabled) })
    }
}

/// The 12-month commercial projection that Core publishes through Meet's CRM
/// bridge. Offer state and amount definitions remain Core-owned.
/// Home's commercial module reads the generated `CommercialSummary` and its
/// histogram points as they are.
extension CommercialHistogramPoint: Identifiable {
    public var id: String { key }
}

// MARK: - Local copy

/// The last layout this device read, so Home draws in the right order on the
/// first frame after launch instead of reshuffling when the Worker answers.
/// A cache of the owner-synced value, never a second source of truth: the
/// Worker's answer replaces it on every read.
enum HomeLayoutCache {
    static let key = "meet.home.layout"
    /// Posted with the new `[HomeModuleSetting]` as `object` whenever a
    /// surface on this device saves or reads a layout.
    static let didChange = Notification.Name("MeetHomeLayoutDidChange")

    static func load(defaults: UserDefaults = .standard) -> [HomeModuleSetting] {
        guard let data = defaults.data(forKey: key),
              let rows = try? JSONDecoder().decode([HomeModuleSettingWire].self, from: data)
        else { return HomeLayout.defaults }
        return HomeLayout.resolve(rows)
    }

    /// This device has read or saved a layout before, so `load` is the
    /// owner's order and not the default standing in for it.
    static func isStored(defaults: UserDefaults = .standard) -> Bool {
        defaults.data(forKey: key) != nil
    }

    static func store(_ layout: [HomeModuleSetting], defaults: UserDefaults = .standard) {
        let rows = layout.map { HomeModuleSettingWire(id: $0.id.rawValue, enabled: $0.enabled) }
        if let data = try? JSONEncoder().encode(rows) {
            defaults.set(data, forKey: key)
        }
        NotificationCenter.default.post(name: didChange, object: layout)
    }

    static func clear(defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: key)
        NotificationCenter.default.post(name: didChange, object: HomeLayout.defaults)
    }
}
