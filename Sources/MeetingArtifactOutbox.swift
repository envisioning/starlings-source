import Foundation

/// Where finalized transcript text goes.
///
/// Room and meeting are plain strings so the queue needs neither client's
/// session types: the Mac holds a `MeetingContext` and an owner session, the
/// phone passes credentials per call, and the queue below is indifferent to
/// both. Conformances live next to each client's API type.
protocol TranscriptUploading: Sendable {
    func appendTranscript(room: String, meetingID: String, segments: [TranscriptSegment]) async throws
    func finalizeMeeting(room: String, meetingID: String) async throws
}

/// What one call to the outbox left behind, in three separate facts. The
/// old single `Bool` was "the row is gone", which is false for the whole of
/// a live meeting — every segment on the Worker still read as pending — and
/// said nothing about whether the text had reached the disk.
struct OutboxDelivery: Equatable, Sendable {
    /// The row is on disk as it is in memory: a crash now loses nothing.
    let persisted: Bool
    /// Every segment queued for this meeting so far is on the Worker.
    let uploaded: Bool
    /// The artifact is cut and the row is gone.
    let finalized: Bool

    /// The host's "SAVED — UPLOAD PENDING" moment: text this device holds
    /// that the Worker does not have yet.
    var isUploadPending: Bool { !uploaded }
}

/// A text-only, crash-safe upload queue. Audio never enters this store. Segment
/// IDs make every retry safe because the room coordinator de-duplicates them.
///
/// Shared by the Mac and the phone. Both hosts owe the artifact the same
/// promise — finalized text, uploaded eventually, never twice — and one queue
/// is the only way that promise means the same thing on both.
///
/// **One instance per file.** Each instance caches the file in memory and
/// writes the whole of it back, so two instances over one file overwrite each
/// other's rows: recovery on the phone used to open a second one
/// beside the host's, and a segment the host wrote while recovery was
/// uploading was gone when recovery failed and wrote its copy back. The
/// uploader is therefore resolved at delivery, not at construction, so the one
/// instance an app owns can outlive any sign-in: `uploader()` answers with the
/// current session, or nil when there is none, in which case the text waits.
actor MeetingArtifactOutbox {
    typealias UploaderProvider = @Sendable () async -> (any TranscriptUploading)?

    private struct Entry: Codable, Sendable {
        let roomSlug: String
        let meetingID: String
        var segments: [TranscriptSegment]
        var finalizeRequested: Bool
        /// The web origin of the workspace the meeting is in. Nil
        /// in a row written before the field: that row is the build's own
        /// workspace's, the only one such a build could reach.
        var workspace: String?

        var workspaceOrigin: String { workspace ?? StarlingsWorkspace.builtIn.webOrigin }
    }

    private let uploader: UploaderProvider
    /// The active workspace's web origin. A row goes out only while its own
    /// workspace is active, because the uploader answers with the active
    /// workspace's session; another workspace's row waits on disk.
    private let activeWorkspace: @Sendable () -> String
    private let fileURL: URL
    private var entries: [String: Entry] = [:]
    private var didLoad = false
    /// False after a write that did not reach the disk; true again after one that did.
    private var diskInSync = true
    /// One drain in flight per meeting. A second caller waits for it and
    /// then drains again, so what it enqueued goes out in order behind it.
    private var drains: [String: Task<Void, Never>] = [:]
    /// Told the number of meetings with text still on this device after
    /// every change, so a model can show it without asking.
    private var pendingObserver: (@Sendable (Int) -> Void)?

    init(
        uploader: @escaping UploaderProvider,
        fileURL: URL = MeetingArtifactOutbox.defaultFileURL,
        activeWorkspace: @escaping @Sendable () -> String = { StarlingsWorkspace.active.webOrigin }
    ) {
        self.uploader = uploader
        self.fileURL = fileURL
        self.activeWorkspace = activeWorkspace
    }

    /// One fixed uploader, for a client whose API type resolves its own
    /// session per call (the Mac), and for tests.
    init(
        api: any TranscriptUploading,
        fileURL: URL = MeetingArtifactOutbox.defaultFileURL
    ) {
        self.init(uploader: { api }, fileURL: fileURL)
    }

    func observePendingCount(_ observer: @escaping @Sendable (Int) -> Void) {
        pendingObserver = observer
        loadIfNeeded()
        observer(entries.count)
    }

    @discardableResult
    func enqueue(_ segment: TranscriptSegment, room: String, meetingID: String) async -> OutboxDelivery {
        loadIfNeeded()
        let key = Self.key(room: room, meetingID: meetingID)
        var entry = entries[key] ?? Entry(
            roomSlug: room,
            meetingID: meetingID,
            segments: [],
            finalizeRequested: false,
            workspace: activeWorkspace()
        )
        if !entry.segments.contains(where: { $0.id == segment.id }) {
            entry.segments.append(segment)
        }
        entries[key] = entry
        persist()
        await flush(key: key)
        return delivery(key: key)
    }

    @discardableResult
    func requestFinalization(room: String, meetingID: String) async -> OutboxDelivery {
        loadIfNeeded()
        let key = Self.key(room: room, meetingID: meetingID)
        var entry = entries[key] ?? Entry(
            roomSlug: room,
            meetingID: meetingID,
            segments: [],
            finalizeRequested: false,
            workspace: activeWorkspace()
        )
        entry.finalizeRequested = true
        entries[key] = entry
        persist()
        await flush(key: key)
        return delivery(key: key)
    }

    /// Every meeting with text still here, drained in turn. Returns how many
    /// remain. Safe to call from any number of places at once — launch,
    /// foreground, network recovery, Settings — because each meeting's drain
    /// is serialised and the callers queue behind it.
    @discardableResult
    func retryPending() async -> Int {
        loadIfNeeded()
        for key in entries.keys.sorted() {
            await flush(key: key)
        }
        return entries.count
    }

    /// Drain one live meeting before its host moves to another device.
    /// Uploading an empty transcript is already complete; an offline uploader
    /// leaves the row here and prevents the caller from releasing the host.
    func flush(room: String, meetingID: String) async -> OutboxDelivery {
        loadIfNeeded()
        let key = Self.key(room: room, meetingID: meetingID)
        await flush(key: key)
        return delivery(key: key)
    }

    func pendingMeetingCount() -> Int {
        loadIfNeeded()
        return entries.count
    }

    private func delivery(key: String) -> OutboxDelivery {
        let entry = entries[key]
        return OutboxDelivery(
            persisted: diskInSync,
            uploaded: entry?.segments.isEmpty ?? true,
            finalized: entry == nil
        )
    }

    /// Serialised per key. The actor protects each access, not the whole
    /// function: `drain` suspends on every upload, and an `enqueue` or
    /// `requestFinalization` that ran in that gap used to be overwritten when
    /// the suspended call wrote its stale copy back. Now only one
    /// drain runs per meeting, and it reads the stored entry again after each
    /// await instead of carrying a copy across it.
    private func flush(key: String) async {
        while let running = drains[key] {
            await running.value
        }
        let task = Task { [self] in
            await drain(key: key)
            drains[key] = nil
        }
        drains[key] = task
        await task.value
    }

    private func drain(key: String) async {
        // A row with no room or meeting cannot be uploaded and cannot be
        // repaired: drop it rather than retrying it forever. Every slug that
        // gets here came from a live meeting, so this is file corruption, not
        // a routine case.
        guard let seed = entries[key],
              !seed.roomSlug.isEmpty,
              !seed.meetingID.isEmpty else {
            entries.removeValue(forKey: key)
            persist()
            return
        }
        let room = seed.roomSlug
        let meetingID = seed.meetingID
        // Another workspace's meeting: its text waits until that workspace
        // is active, and never goes out on this one's session.
        guard seed.workspaceOrigin == activeWorkspace() else { return }
        // Nobody signed in: the text waits on disk for the next session. Not
        // a failure and not a success — the row is simply still here.
        guard let api = await uploader() else { return }

        do {
            while let entry = entries[key], !entry.segments.isEmpty {
                let batch = Array(entry.segments.prefix(50))
                try await api.appendTranscript(room: room, meetingID: meetingID, segments: batch)
                // Remove what was acknowledged from the entry as it is *now*:
                // a segment enqueued during the upload is still in it.
                let sentIDs = Set(batch.map(\.id))
                entries[key]?.segments.removeAll(where: { sentIDs.contains($0.id) })
                persist()
            }
            guard let entry = entries[key] else { return }
            if entry.finalizeRequested {
                try await api.finalizeMeeting(room: room, meetingID: meetingID)
                // The artifact is cut once. Text that arrived while the
                // finalize was in flight is still owed, so it stays queued and
                // goes out on the next drain without a second finalize.
                if let late = entries[key], !late.segments.isEmpty {
                    entries[key]?.finalizeRequested = false
                } else {
                    entries.removeValue(forKey: key)
                }
            }
            persist()
        } catch {
            // Nothing to restore: the stored entry was never replaced by a
            // copy, so everything enqueued during the failed upload is in it.
            persist()
        }
    }

    private func loadIfNeeded() {
        guard !didLoad else { return }
        didLoad = true
        guard let data = try? Data(contentsOf: fileURL),
              let decoded = try? JSONDecoder().decode([String: Entry].self, from: data) else {
            return
        }
        entries = decoded
    }

    /// Write the whole file, and remember whether it landed: a failed write
    /// is not a saved segment, and the caller's `persisted` says so.
    private func persist() {
        defer { pendingObserver?(entries.count) }
        do {
            let directory = fileURL.deletingLastPathComponent()
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
            if entries.isEmpty {
                if FileManager.default.fileExists(atPath: fileURL.path) {
                    try FileManager.default.removeItem(at: fileURL)
                }
                diskInSync = true
                return
            }
            let data = try JSONEncoder().encode(entries)
            var options: Data.WritingOptions = [.atomic]
            #if os(iOS)
            // Until first unlock, not `complete`: a phone hosting from a pocket
            // is locked, and `complete` makes the file unwritable ten seconds
            // after lock, so every save failed and the disk copy that outlives
            // a killed app did not exist. The same class as
            // SnapshotStore and CalendarEventCache.
            options.insert(.completeFileProtectionUntilFirstUserAuthentication)
            #endif
            try data.write(to: fileURL, options: options)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
            diskInSync = true
        } catch {
            // The next write retries. Media must never depend on this path.
            diskInSync = false
        }
    }

    private static func key(room: String, meetingID: String) -> String {
        "\(room):\(meetingID)"
    }

    private static var defaultFileURL: URL {
        AppFolders.support.appendingPathComponent("artifact-outbox.json")
    }
}
