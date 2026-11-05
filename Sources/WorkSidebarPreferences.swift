import Foundation

/// One block Work can put on its rail. The key is what preferences are filed
/// under and never changes; the title is what the header draws.
struct WorkSidebarSectionSpec: Equatable, Sendable {
    let key: String
    let title: String
    /// One line under the name in Settings > Work.
    let detail: String
    let isVisibleByDefault: Bool

    init(key: String, title: String, detail: String = "", isVisibleByDefault: Bool = true) {
        self.key = key
        self.title = title
        self.detail = detail
        self.isVisibleByDefault = isVisibleByDefault
    }
}

/// How the owner has arranged Work's sidebar: which sections are on it, in
/// what order, and the status a filtered list opens on.
///
/// Folds are already remembered per section (`MeetingSidebarFoldPreferences`),
/// but a fold still leaves the header in the way. Somebody who never works
/// sales wants SALES gone and wants the list they always narrow to come back
/// narrowed. All three are preferences about the rail rather than state of the
/// work, so they live here beside the folds and outlive the window.
///
/// The order and the hidden set are stored as plain string arrays of section
/// keys. Every read is reconciled against `catalog`, so a section this build
/// adds appears where it ships rather than falling off the end of somebody's
/// saved order, and one a build removes is dropped instead of leaving a hole.
enum WorkSidebarPreferences {
    /// Every block, in the order Work ships it: one. INBOX and MINE left the
    /// rail (2026-09-23) — they live on Overview, where the middle pane has
    /// room to read them — and a saved order that still names them drops them
    /// on read. The four relationship groups are the Browse view in the
    /// middle pane, under the keys in `browseKeys`.
    static let catalog: [WorkSidebarSectionSpec] = [
        .init(
            key: "work.subjects", title: String(localized: "SUBJECTS"),
            detail: String(localized: "The subjects you follow: starred first, then the busiest.")
        ),
    ]

    /// The Browse view's four groups. Not on the rail, but their status
    /// filter and sort are remembered under these keys — the same keys the
    /// groups had as rail blocks, so nobody's choice is lost. `work.leads` is
    /// SALES; the group is on Browse only for people with Sales on.
    static let browseKeys = BrowseGroupRegistry.order.map { BrowseGroupRegistry.spec(for: $0).preferenceKey }

    static func spec(for key: String) -> WorkSidebarSectionSpec? {
        catalog.first { $0.key == key }
    }

    /// Posted after any write here, so a Work window redraws its rail when
    /// Settings > Work rearranges it — and the other way round. No payload:
    /// the listener reads the store.
    static let didChangeNotification = Notification.Name("meet.workSidebar.didChange")

    private static func didChange(_ defaults: UserDefaults) {
        guard defaults === UserDefaults.standard else { return }
        NotificationCenter.default.post(name: didChangeNotification, object: nil)
    }

    private static let orderKey = "meet.workSidebar.order"
    private static let hiddenKey = "meet.workSidebar.hidden"
    private static let visibleOverrideKey = "meet.workSidebar.visibleOverride"
    private static let filterPrefix = "meet.workSidebar.filter."
    private static let sortPrefix = "meet.workSidebar.sort."
    private static let mineFilterSectionKey = "meet.workSidebar.mineFilter.section"
    private static let mineFilterOriginKey = "meet.workSidebar.mineFilter.origin"

    private static let unownedFilterOriginKey = "meet.workSidebar.unownedFilter.origin"
    private static let unownedHiddenSubjectsKey = "meet.workSidebar.unownedFilter.hiddenSubjects"
    private static let inboxFilterSourceKey = "meet.workSidebar.inboxFilter.source"

    // MARK: - Order

    /// The saved order, reconciled with what this build actually has.
    static func order(defaults: UserDefaults = .standard) -> [String] {
        resolvedOrder(saved: defaults.stringArray(forKey: orderKey) ?? [])
    }

    static func setOrder(_ keys: [String], defaults: UserDefaults = .standard) {
        defaults.set(resolvedOrder(saved: keys), forKey: orderKey)
        didChange(defaults)
    }

    /// Keep what was saved, drop what no longer exists, and put anything new
    /// where the catalog says it belongs — beside the section it shipped after,
    /// not at the bottom where nobody would look for it.
    static func resolvedOrder(saved: [String]) -> [String] {
        let known = Set(catalog.map(\.key))
        var result: [String] = []
        for key in saved where known.contains(key) && !result.contains(key) {
            result.append(key)
        }
        for (index, spec) in catalog.enumerated() where !result.contains(spec.key) {
            result.insert(spec.key, at: min(index, result.count))
        }
        return result
    }

    /// Move one section up (`-1`) or down (`+1`) among the sections that are
    /// on the rail. Hidden sections are skipped: a move that appears to do
    /// nothing because it stepped over something invisible is a broken move.
    static func moved(
        _ key: String,
        by delta: Int,
        order: [String],
        hidden: Set<String>
    ) -> [String] {
        let visible = order.filter { !hidden.contains($0) }
        guard let from = visible.firstIndex(of: key) else { return order }
        let to = from + delta
        guard visible.indices.contains(to) else { return order }
        guard let a = order.firstIndex(of: visible[from]),
              let b = order.firstIndex(of: visible[to]) else { return order }
        var result = order
        result.swapAt(a, b)
        return result
    }

    // MARK: - Visibility

    static func hidden(defaults: UserDefaults = .standard) -> Set<String> {
        let explicitlyHidden = Set(defaults.stringArray(forKey: hiddenKey) ?? [])
        let explicitlyVisible = Set(defaults.stringArray(forKey: visibleOverrideKey) ?? [])
        let hiddenByDefault = Set(catalog.filter { !$0.isVisibleByDefault }.map(\.key))
        return explicitlyHidden
            .union(hiddenByDefault)
            .subtracting(explicitlyVisible)
    }

    static func isVisible(_ key: String, defaults: UserDefaults = .standard) -> Bool {
        !hidden(defaults: defaults).contains(key)
    }

    static func setVisible(_ visible: Bool, for key: String, defaults: UserDefaults = .standard) {
        var hiddenKeys = Set(defaults.stringArray(forKey: hiddenKey) ?? [])
        var visibleOverrides = Set(defaults.stringArray(forKey: visibleOverrideKey) ?? [])
        if visible {
            hiddenKeys.remove(key)
            visibleOverrides.insert(key)
        } else {
            hiddenKeys.insert(key)
            visibleOverrides.remove(key)
        }
        defaults.set(Array(hiddenKeys), forKey: hiddenKey)
        defaults.set(Array(visibleOverrides), forKey: visibleOverrideKey)
        didChange(defaults)
    }

    // MARK: - Default filter

    /// The status a filtered list opens on. `allowed` is the section's current
    /// options: a status Core has stopped offering falls back rather than
    /// asking the server for a category that no longer exists.
    static func filter(
        for key: String,
        allowed: [String],
        fallback: String,
        defaults: UserDefaults = .standard
    ) -> String {
        guard let saved = defaults.string(forKey: filterPrefix + key),
              allowed.contains(saved) else { return fallback }
        return saved
    }

    static func setFilter(_ value: String, for key: String, defaults: UserDefaults = .standard) {
        defaults.set(value, forKey: filterPrefix + key)
    }

    // MARK: - Default sort

    /// The sort a section opens on. `allowed` is that section's current sort
    /// option ids; a saved value the current build no longer offers falls back
    /// rather than asking for an order that no longer exists.
    static func sort(
        for key: String,
        allowed: [String],
        fallback: String,
        defaults: UserDefaults = .standard
    ) -> String {
        guard let saved = defaults.string(forKey: sortPrefix + key),
              allowed.contains(saved) else { return fallback }
        return saved
    }

    static func setSort(_ value: String, for key: String, defaults: UserDefaults = .standard) {
        defaults.set(value, forKey: sortPrefix + key)
    }

    // MARK: - Mine and INBOX contextual filters

    static func mineFilter(defaults: UserDefaults = .standard) -> MineFilter {
        MineFilter(
            section: defaults.string(forKey: mineFilterSectionKey)
                .flatMap(MineSectionFilter.init(rawValue:)) ?? .all,
            origin: defaults.string(forKey: mineFilterOriginKey)
                .flatMap(MineOriginFilter.init(rawValue:)) ?? .all
        )
    }

    static func setMineFilter(_ filter: MineFilter, defaults: UserDefaults = .standard) {
        defaults.set(filter.section.rawValue, forKey: mineFilterSectionKey)
        defaults.set(filter.origin.rawValue, forKey: mineFilterOriginKey)
        didChange(defaults)
    }

    /// UNOWNED's one axis: tasks, GitHub issues, or both. Tasks until a
    /// person picks otherwise (mz, 2026-10-01).
    static let unownedOriginDefault: MineOriginFilter = .task

    static func unownedOrigin(defaults: UserDefaults = .standard) -> MineOriginFilter {
        defaults.string(forKey: unownedFilterOriginKey).flatMap(MineOriginFilter.init(rawValue:)) ?? unownedOriginDefault
    }

    static func setUnownedOrigin(_ origin: MineOriginFilter, defaults: UserDefaults = .standard) {
        defaults.set(origin.rawValue, forKey: unownedFilterOriginKey)
        didChange(defaults)
    }

    /// UNOWNED's hidden subjects, as `kind:id` keys.
    static func unownedHiddenSubjects(defaults: UserDefaults = .standard) -> Set<String> {
        Set(defaults.stringArray(forKey: unownedHiddenSubjectsKey) ?? [])
    }

    static func setUnownedHiddenSubjects(_ keys: Set<String>, defaults: UserDefaults = .standard) {
        defaults.set(keys.sorted(), forKey: unownedHiddenSubjectsKey)
        didChange(defaults)
    }

    static func inboxFilter(defaults: UserDefaults = .standard) -> InboxFilterSource {
        guard let raw = defaults.string(forKey: inboxFilterSourceKey),
              let filter = InboxFilterSource(rawValue: raw),
              filter != .note else { return .all }
        return filter
    }

    static func setInboxFilter(_ filter: InboxFilterSource, defaults: UserDefaults = .standard) {
        defaults.set(filter.rawValue, forKey: inboxFilterSourceKey)
        didChange(defaults)
    }

    // MARK: - Reset

    /// Back to the shipped rail. Folds are left alone — they are about what
    /// you are reading now, not how the sidebar is built.
    static func reset(defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: orderKey)
        defaults.removeObject(forKey: hiddenKey)
        defaults.removeObject(forKey: visibleOverrideKey)
        for key in catalog.map(\.key) + browseKeys {
            defaults.removeObject(forKey: filterPrefix + key)
            defaults.removeObject(forKey: sortPrefix + key)
        }
        defaults.removeObject(forKey: mineFilterSectionKey)
        defaults.removeObject(forKey: mineFilterOriginKey)
        defaults.removeObject(forKey: inboxFilterSourceKey)
        didChange(defaults)
    }
}
