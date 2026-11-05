import Foundation

/// The last known calendar, on disk, so a cold launch paints the week it had
/// rather than an empty grid while eight round trips run.
///
/// A cache and nothing more: it is never the answer, only the first frame.
/// Anything unreadable, foreign, or old is dropped rather than migrated, and
/// every entry it hands back is replaced by the live fetch a moment later.
/// EventKit is deliberately absent — it is a local database that reads in
/// microseconds, so a second copy of it could only be a stale one.
enum CalendarEventCache {
    /// Bumped whenever the encoded shape changes. A file stamped with anything
    /// else is discarded, which is cheaper and safer than migrating a cache.
    private static let schema = 1
    /// Past this the file stops being a head start and becomes a lie: a
    /// fortnight of moved meetings is not a week worth drawing.
    private static let maxAge: TimeInterval = 14 * 24 * 3_600
    /// Months kept, most recently fetched first. The window on screen is one or
    /// two; the rest are paging headroom, not an archive.
    private static let monthLimit = 8

    struct Month: Codable, Equatable, Sendable {
        var events: [StarlingsCalendarEvent]
        var fetchedAt: Date
    }

    struct Snapshot: Codable, Sendable {
        var schema: Int
        var savedAt: Date
        var googleConnected: Bool
        /// Google and subscribed calendars, kept for their colours and their
        /// visibility keys. Without them the first paint draws every event in
        /// the fallback colour and cannot tell a hidden calendar from a shown
        /// one — a worse flash than no first paint at all.
        var calendars: [StarlingsCalendar]
        var months: [String: Month]
    }

    static func load() async -> Snapshot? {
        guard let url = fileURL else { return nil }
        return await Task.detached(priority: .userInitiated) { () -> Snapshot? in
            guard let data = try? Data(contentsOf: url),
                  let snapshot = try? JSONDecoder().decode(Snapshot.self, from: data),
                  snapshot.schema == schema
            else { return nil }
            // Per month, not per file: a device that has been offline for a
            // fortnight rewrites the file on every launch, so the file's own
            // age says nothing about how old the events in it are.
            var fresh = snapshot
            let now = Date()
            fresh.months = fresh.months.filter { now.timeIntervalSince($0.value.fetchedAt) < maxAge }
            return fresh
        }.value
    }

    /// Fire and forget. A cache that failed to write costs the next launch its
    /// head start and nothing else, so there is nobody to report it to.
    static func save(
        months: [String: Month],
        calendars: [StarlingsCalendar],
        googleConnected: Bool
    ) {
        let trimmed = Dictionary(
            uniqueKeysWithValues: months
                .sorted { $0.value.fetchedAt > $1.value.fetchedAt }
                .prefix(monthLimit)
                .map { ($0.key, $0.value) }
        )
        let snapshot = Snapshot(
            schema: schema,
            savedAt: Date(),
            googleConnected: googleConnected,
            // EventKit calendars are re-read locally on every load.
            calendars: calendars.filter { $0.source != .eventKit },
            months: trimmed
        )
        guard let url = fileURL else { return }
        Task.detached(priority: .utility) {
            guard let data = try? JSONEncoder().encode(snapshot) else { return }
            #if os(iOS)
            // Readable after the first unlock, like the rest of the app's data,
            // and never while the phone has not been unlocked since boot.
            let options: Data.WritingOptions = [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
            #else
            let options: Data.WritingOptions = [.atomic]
            #endif
            try? data.write(to: url, options: options)
        }
    }

    /// Signing out takes the events with it. The next owner starts on an empty
    /// grid rather than on somebody else's week.
    /// The workspace's file, and the one file from before the per-workspace
    /// folders.
    static func purge(scope: WorkspaceScope = .active) {
        guard let root else { return }
        try? FileManager.default.removeItem(at: scope.directory(in: root).appendingPathComponent(fileName))
        // The loose file from before the folders, as a sign-out always cleared it.
        if scope == .active || scope.isBuiltIn { try? FileManager.default.removeItem(at: root.appendingPathComponent(fileName)) }
    }

    /// Signing out of every workspace (slice G): every workspace's months.
    static func purgeEveryWorkspace() {
        guard let root else { return }
        try? FileManager.default.removeItem(at: root)
    }

    private static let fileName = "months.json"

    /// `Caches/StarlingsCalendar`, one folder per workspace inside it.
    private static var root: URL? {
        guard let base = try? FileManager.default.url(
            for: .cachesDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        ) else { return nil }
        return base.appendingPathComponent("StarlingsCalendar", isDirectory: true)
    }

    private static var fileURL: URL? {
        root.map { WorkspaceScope.active.directory(in: $0).appendingPathComponent(fileName) }
    }
}
