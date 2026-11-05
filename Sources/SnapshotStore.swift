import CryptoKit
import Foundation

/// Stale-while-revalidate snapshots for the work graph.
///
/// The last good *response body* for a read, keyed by owner and resource, so
/// a screen paints what it last knew the instant it opens and refreshes
/// quietly behind that. Bytes rather than decoded values on purpose: the CRM
/// models are `Decodable` only (they carry custom decoders and defaults), and
/// a cache of the wire bytes decodes through exactly the same code path as a
/// live response — there is no second shape to keep in step, and a model
/// change invalidates the cache the same way it would fail an old server.
///
/// Two tiers. Memory for instant tab switches; disk, protected like the rest
/// of the account material, for cold launches. Neither is ever the answer —
/// every entry is replaced by the live read a moment later, and a failed
/// refresh leaves the last snapshot on screen rather than blanking it.
///
/// Never stores tokens, transcripts, audio or credentials: the keys are
/// chosen by the API layer, and only list reads go through it.
enum SnapshotStore {
    /// Bumped whenever the envelope changes. Anything else on disk is dropped.
    private static let schema = 2
    /// Past this a snapshot stops being a head start and becomes a lie: it
    /// is not shown at all, so loading state is honest when nothing usable
    /// exists.
    static let maxAge: TimeInterval = 7 * 24 * 3_600

    struct Snapshot: Sendable {
        let data: Data
        let savedAt: Date
        /// The Worker's validator for `data`, sent back as `If-None-Match`
        /// so an unchanged list costs a 304 and no body (docs/CACHING.md).
        let etag: String?

        init(data: Data, savedAt: Date, etag: String? = nil) {
            self.data = data
            self.savedAt = savedAt
            self.etag = etag
        }

        /// Younger than `ttl`: paint it and do not bother the server.
        func isFresh(ttl: TimeInterval, now: Date = Date()) -> Bool {
            now.timeIntervalSince(savedAt) < ttl
        }
    }

    private struct Envelope: Codable {
        var schema: Int
        var owner: String
        var key: String
        var savedAt: Date
        var body: Data
        var etag: String?
    }

    /// Memory tier, behind a lock: reads come from the main actor, saves from
    /// whichever task finished the request.
    private static let memory = Memory()

    private final class Memory: @unchecked Sendable {
        private struct Entry {
            var owner: String
            var key: String
            var snapshot: Snapshot
        }

        private var entries: [String: Entry] = [:]
        private let lock = NSLock()

        func get(_ id: String) -> Snapshot? {
            lock.withLock { entries[id]?.snapshot }
        }

        func set(_ snapshot: Snapshot, id: String, owner: String, key: String) {
            lock.withLock { entries[id] = Entry(owner: owner, key: key, snapshot: snapshot) }
        }

        func remove(_ id: String) { lock.withLock { entries.removeValue(forKey: id) } }

        /// Drops every entry of `owner` whose key begins with one of `prefixes`.
        func remove(owner: String, prefixes: [String]) {
            let wanted = owner.lowercased()
            lock.withLock {
                entries = entries.filter { _, entry in
                    entry.owner.lowercased() != wanted || !SnapshotStore.matches(key: entry.key, prefixes: prefixes)
                }
            }
        }

        func removeAll() { lock.withLock { entries.removeAll() } }
    }

    /// Disk writes and purges, one at a time. A save writes its file later,
    /// off the caller's task; a write queued before a purge is dropped, so a
    /// sign-out never leaves the last owner's snapshot on disk.
    private static let disk = Disk()

    private final class Disk: @unchecked Sendable {
        private var purges = 0
        private let lock = NSLock()

        /// The purge count now. A write made with it lands only if no purge
        /// ran in between.
        var generation: Int { lock.withLock { purges } }

        func write(_ data: Data, to url: URL, options: Data.WritingOptions, generation: Int) {
            lock.withLock {
                guard generation == purges else { return }
                try? data.write(to: url, options: options)
            }
        }

        func purge(_ remove: () -> Void) {
            lock.withLock {
                purges += 1
                remove()
            }
        }
    }

    /// Posted on the main queue after `invalidate`. `userInfo` carries
    /// `invalidatedPrefixesKey` (`[String]`) and `invalidatedOwnerKey`
    /// (`String`); a screen showing one of those resources re-reads.
    static let didInvalidateNotification = Notification.Name("SnapshotStore.didInvalidate")
    static let invalidatedPrefixesKey = "prefixes"
    static let invalidatedOwnerKey = "owner"

    /// `key` is, or is under, one of `prefixes`. `crm/subjects` covers every
    /// `crm/subjects?kind=…` page; `crm/mine` covers only itself.
    static func matches(key: String, prefixes: [String]) -> Bool {
        prefixes.contains { key == $0 || key.hasPrefix($0 + "?") || key.hasPrefix($0 + "/") }
    }

    /// The prefixes a notification names, or nil when it is somebody else's.
    static func invalidatedPrefixes(in notification: Notification, owner: String) -> [String]? {
        guard let prefixes = notification.userInfo?[invalidatedPrefixesKey] as? [String],
              let who = notification.userInfo?[invalidatedOwnerKey] as? String,
              who.lowercased() == owner.lowercased()
        else { return nil }
        return prefixes
    }

    /// "Updated 4 minutes ago" — what the status line says beside a failed
    /// refresh, so a painted snapshot is never mistaken for live data.
    static func updatedLabel(_ savedAt: Date, now: Date = Date()) -> String {
        let age = now.timeIntervalSince(savedAt)
        if age < 60 { return String(localized: "Updated just now") }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        formatter.locale = StarlingsDateFormatting.locale
        return String(localized: "Updated \(formatter.localizedString(for: savedAt, relativeTo: now))")
    }

    /// The last snapshot for `key`, if any usable one exists.
    static func load(key: String, owner: String) -> Snapshot? {
        let id = identifier(owner: owner, key: key)
        if let hit = memory.get(id) {
            return Date().timeIntervalSince(hit.savedAt) < maxAge ? hit : nil
        }
        guard let url = fileURL(for: id),
              let data = try? Data(contentsOf: url),
              let envelope = try? JSONDecoder().decode(Envelope.self, from: data),
              envelope.schema == schema,
              envelope.owner == owner,
              envelope.key == key,
              Date().timeIntervalSince(envelope.savedAt) < maxAge
        else { return nil }
        let snapshot = Snapshot(data: envelope.body, savedAt: envelope.savedAt, etag: envelope.etag)
        memory.set(snapshot, id: id, owner: owner, key: key)
        return snapshot
    }

    /// Fire and forget. A cache that failed to write costs the next launch its
    /// head start and nothing else.
    static func save(_ data: Data, key: String, owner: String, etag: String? = nil) {
        let id = identifier(owner: owner, key: key)
        let now = Date()
        memory.set(Snapshot(data: data, savedAt: now, etag: etag), id: id, owner: owner, key: key)
        guard let url = fileURL(for: id) else { return }
        let envelope = Envelope(schema: schema, owner: owner, key: key, savedAt: now, body: data, etag: etag)
        let generation = disk.generation
        Task.detached(priority: .utility) {
            guard let encoded = try? JSONEncoder().encode(envelope) else { return }
            #if os(iOS)
            let options: Data.WritingOptions = [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
            #else
            let options: Data.WritingOptions = [.atomic]
            #endif
            disk.write(encoded, to: url, options: options, generation: generation)
        }
    }

    /// Signing out of every workspace (slice G): every workspace's folder,
    /// and the loose files from before the folders.
    static func purgeEveryWorkspace() {
        memory.removeAll()
        QuickNoteDestinationOptionsCache.shared.clear()
        guard let root else { return }
        disk.purge {
            try? FileManager.default.removeItem(at: root)
        }
    }

    /// Signing out takes the workspace's snapshots with it. The next owner
    /// starts cold rather than on somebody else's work. The files from before
    /// the per-workspace folders, loose in the root, go too.
    /// Another workspace's (a sign-out from the list) leaves the
    /// memory alone: it only ever holds the active workspace's.
    static func purgeAll(scope: WorkspaceScope = .active) {
        if scope == .active {
            memory.removeAll()
            QuickNoteDestinationOptionsCache.shared.clear()
        }
        guard let root else { return }
        disk.purge {
            try? FileManager.default.removeItem(at: scope.directory(in: root))
            guard scope == .active || scope.isBuiltIn else { return }
            let loose = (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
            for file in loose where file.pathExtension == "json" {
                try? FileManager.default.removeItem(at: file)
            }
        }
    }

    /// One resource, after a mutation that made it stale — a completed task,
    /// a filed issue. Memory only: the next read overwrites the file.
    static func invalidate(key: String, owner: String) {
        invalidate(prefixes: [key], owner: owner)
    }

    /// The resources a mutation made stale, by prefix (`crm/subjects` takes
    /// every filtered page with it), for `owner`. Memory drops them; the disk
    /// copy stays as the next cold launch's head start and is overwritten by
    /// the re-read. Then `didInvalidateNotification`, so a screen that is
    /// *not* the one that wrote — Home's card after Work completed a task —
    /// re-reads instead of holding the old list until its next poll.
    static func invalidate(prefixes: [String], owner: String) {
        guard !owner.isEmpty, !prefixes.isEmpty else { return }
        memory.remove(owner: owner, prefixes: prefixes)
        QuickNoteDestinationOptionsCache.shared.invalidate(owner: owner, prefixes: prefixes)
        let userInfo: [String: Any] = [invalidatedPrefixesKey: prefixes, invalidatedOwnerKey: owner]
        if Thread.isMainThread {
            NotificationCenter.default.post(name: didInvalidateNotification, object: nil, userInfo: userInfo)
        } else {
            DispatchQueue.main.async {
                NotificationCenter.default.post(name: didInvalidateNotification, object: nil, userInfo: userInfo)
            }
        }
    }

    /// The active workspace is part of the key: one address can be a member
    /// of two workspaces, and neither may paint the other's lists.
    private static func identifier(owner: String, key: String) -> String {
        let scope = WorkspaceScope.active.webOrigin
        let digest = SHA256.hash(data: Data("\(scope)\n\(owner.lowercased())\n\(key)".utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    /// `Caches/MeetSnapshots`, one folder per workspace inside it.
    private static var root: URL? {
        guard let base = try? FileManager.default.url(
            for: .cachesDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        ) else { return nil }
        return base.appendingPathComponent("MeetSnapshots", isDirectory: true)
    }

    private static func fileURL(for identifier: String) -> URL? {
        guard let root else { return nil }
        return WorkspaceScope.active.directory(in: root).appendingPathComponent("\(identifier).json")
    }
}

/// One in-flight read per resource. Two screens asking for Mine in the same
/// second share a request rather than racing two; the second caller gets the
/// first's result.
actor RequestCoalescer {
    static let shared = RequestCoalescer()

    /// What one list read came back with: the body to decode (the snapshot's
    /// own bytes after a 304) and the validator to keep beside it.
    struct Fetched: Sendable {
        let data: Data
        let etag: String?
    }

    private var inFlight: [String: Task<Fetched, Error>] = [:]

    func run(key: String, _ operation: @escaping @Sendable () async throws -> Fetched) async throws -> Fetched {
        if let existing = inFlight[key] {
            return try await existing.value
        }
        let task = Task { try await operation() }
        inFlight[key] = task
        defer { inFlight.removeValue(forKey: key) }
        return try await task.value
    }
}
