import Foundation

/// One ambient capture on disk: a folder under Application Support holding
/// the two tracks per part and this manifest beside them. Written at every
/// state change so a crash leaves a truthful record, and read by the
/// two-track pass (slice 2) — nothing else opens these files.
struct AmbientCaptureManifest: Codable, Equatable, Sendable {
    enum Status: String, Codable, Sendable {
        /// A live session is writing. At launch, a manifest still in this
        /// state means the app died mid-capture: it becomes `interrupted`.
        case recording
        /// Stopped, both tracks verified readable. Ready for the pass.
        case captured
        /// The app died mid-capture. The tracks up to the last flush are on
        /// disk; the pass takes them as they are.
        case interrupted
        /// Stopped and nothing recoverable — no part with a readable track.
        /// The folder is removed: at stop, by the pass, or by the sweep.
        case failed
        /// The pass has filed the transcript. The folder is removed next; a
        /// crash before that leaves it for the sweep.
        case processed
    }

    struct Part: Codable, Equatable, Sendable {
        let index: Int
        let micFile: String
        let systemFile: String
        let startedAt: Date
        var endedAt: Date?
        var micFrames: Int64 = 0
        var systemFrames: Int64 = 0
    }

    /// A line in the record: a rebuild, a warning, a backfill. Human-readable,
    /// dated, so the pass and a person can both see what the capture went
    /// through.
    struct Event: Codable, Equatable, Sendable {
        let at: Date
        let text: String
    }

    static let currentVersion = 1

    var version = AmbientCaptureManifest.currentVersion
    let id: UUID
    /// Always `ambient` here; the pass writes Core with `source: meet_ambient`.
    let source: String
    let startedAt: Date
    var endedAt: Date?
    var status: Status
    /// The microphone chosen at start, by name, for the record.
    let inputName: String
    /// Sample rate and channel count of what the tracks hold.
    let trackSampleRate: Double
    var parts: [Part]
    var events: [Event] = []
    /// A title the person gave, or nothing — the pass may title it from the
    /// notes, as a room meeting is titled.
    var title: String?
    /// The Google Meet code when the extension correlated this capture.
    var meetingCode: String?
    /// The calendar event this capture was started from, when one matched.
    var calendarEventID: String?
    var scheduledEnd: Date?
    /// Everyone the extension or the calendar saw, by name, de-duplicated.
    var attendees: [String] = []
    /// Addresses the calendar knew, by the same name — what lets Core link a
    /// contact. The extension never has one.
    var attendeeEmails: [String: String] = [:]
    /// The signed-in account at start, by address, lowercased. The pass
    /// files a capture only on this account and deletes it when another
    /// one is signed in. Nil from a build before that, or from a
    /// start while nobody was signed in: the pass deletes it, because nothing
    /// proves whose it is.
    var owner: String?
    /// The web origin of the workspace active at start. The pass
    /// files a capture only while that workspace is active; the same address
    /// can be a member of two. Nil from a build before that: the build's own
    /// workspace, the only one such a build could reach.
    var workspace: String?
    /// Passes that started on this capture. Counted before the work, so a
    /// crash counts too; at `AmbientCapturePolicy.passAttemptLimit` the
    /// audio is deleted instead of retried.
    var passAttempts = 0

    init(id: UUID, source: String, startedAt: Date, status: Status, inputName: String, trackSampleRate: Double, parts: [Part], title: String? = nil) {
        self.id = id
        self.source = source
        self.startedAt = startedAt
        self.status = status
        self.inputName = inputName
        self.trackSampleRate = trackSampleRate
        self.parts = parts
        self.title = title
    }

    /// Lenient on the fields that arrived after the first manifests were
    /// written: a capture from an older build still reads.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = try c.decodeIfPresent(Int.self, forKey: .version) ?? 1
        id = try c.decode(UUID.self, forKey: .id)
        source = try c.decodeIfPresent(String.self, forKey: .source) ?? "ambient"
        startedAt = try c.decode(Date.self, forKey: .startedAt)
        endedAt = try c.decodeIfPresent(Date.self, forKey: .endedAt)
        status = try c.decode(Status.self, forKey: .status)
        inputName = try c.decodeIfPresent(String.self, forKey: .inputName) ?? ""
        trackSampleRate = try c.decodeIfPresent(Double.self, forKey: .trackSampleRate) ?? 16_000
        parts = try c.decodeIfPresent([Part].self, forKey: .parts) ?? []
        events = try c.decodeIfPresent([Event].self, forKey: .events) ?? []
        title = try c.decodeIfPresent(String.self, forKey: .title)
        meetingCode = try c.decodeIfPresent(String.self, forKey: .meetingCode)
        calendarEventID = try c.decodeIfPresent(String.self, forKey: .calendarEventID)
        scheduledEnd = try c.decodeIfPresent(Date.self, forKey: .scheduledEnd)
        attendees = try c.decodeIfPresent([String].self, forKey: .attendees) ?? []
        attendeeEmails = try c.decodeIfPresent([String: String].self, forKey: .attendeeEmails) ?? [:]
        owner = try c.decodeIfPresent(String.self, forKey: .owner)
        workspace = try c.decodeIfPresent(String.self, forKey: .workspace)
        passAttempts = try c.decodeIfPresent(Int.self, forKey: .passAttempts) ?? 0
    }

    var workspaceOrigin: String { workspace ?? StarlingsWorkspace.builtIn.webOrigin }

    var hasRecoverableAudio: Bool {
        parts.contains { $0.micFrames > 0 || $0.systemFrames > 0 }
    }

    mutating func note(_ text: String, at date: Date = Date()) {
        events.append(Event(at: date, text: text))
    }

    /// Names seen in the call, kept in first-seen order, never duplicated.
    mutating func absorb(attendees names: [String]) {
        for name in names {
            let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty, !attendees.contains(trimmed) else { continue }
            attendees.append(trimmed)
        }
    }
}

/// Where captures live and how the manifest is read and written.
enum AmbientCaptureStore {
    static let folderName = "Captures"

    static var root: URL {
        AppFolders.support.appendingPathComponent(folderName, isDirectory: true)
    }

    static func directory(for id: UUID) -> URL {
        root.appendingPathComponent(id.uuidString, isDirectory: true)
    }

    static func manifestURL(in directory: URL) -> URL {
        directory.appendingPathComponent("manifest.json")
    }

    /// Who the extension saw speaking, one line a second per lit tile, as
    /// seconds from the capture's start. Appended, never rewritten — it is
    /// the pass's evidence for naming the diarizer's clusters.
    static func speakingURL(in directory: URL) -> URL {
        directory.appendingPathComponent("speaking.jsonl")
    }

    static func appendSpeaking(_ events: [SpeakerNaming.SpeakingEvent], in directory: URL) {
        guard !events.isEmpty else { return }
        let encoder = JSONEncoder()
        var lines = Data()
        for event in events {
            guard let line = try? encoder.encode(event) else { continue }
            lines.append(line)
            lines.append(0x0A)
        }
        let url = speakingURL(in: directory)
        if let handle = try? FileHandle(forWritingTo: url) {
            defer { try? handle.close() }
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: lines)
        } else {
            try? lines.write(to: url)
            ownerOnly(url)
        }
    }

    static func readSpeaking(in directory: URL) -> [SpeakerNaming.SpeakingEvent] {
        guard let data = try? Data(contentsOf: speakingURL(in: directory)) else { return [] }
        let decoder = JSONDecoder()
        return data.split(separator: 0x0A).compactMap { try? decoder.decode(SpeakerNaming.SpeakingEvent.self, from: $0) }
    }

    /// Never creates the folder: a write into a capture that was deleted
    /// (sign-out, the sweep) fails and leaves it deleted.
    static func write(_ manifest: AmbientCaptureManifest, to directory: URL) throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(manifest)
        // Atomic, so a crash mid-write leaves the previous manifest, never a
        // half one.
        let url = manifestURL(in: directory)
        try data.write(to: url, options: [.atomic])
        ownerOnly(url)
    }

    /// Owner read and write only, like the Mac's outbox and diagnostics. No
    /// data-protection class: the Mac refuses one to a process without the
    /// entitlement, and the write failed with EPERM. FileVault
    /// encrypts the disk. An atomic write makes a new file, so every write
    /// sets this again.
    static func ownerOnly(_ url: URL) {
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    static func read(from directory: URL) throws -> AmbientCaptureManifest {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(AmbientCaptureManifest.self, from: Data(contentsOf: manifestURL(in: directory)))
    }

    /// Every capture folder with a readable manifest, oldest first.
    static func all() -> [(directory: URL, manifest: AmbientCaptureManifest)] {
        guard let entries = try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) else { return [] }
        return entries
            .compactMap { url in (try? read(from: url)).map { (url, $0) } }
            .sorted { $0.1.startedAt < $1.1.startedAt }
    }

    /// The launch sweep: a manifest still `recording` belongs to a session
    /// that no longer exists. It becomes `interrupted` — the tracks up to the
    /// last flush are what there is — or `failed` when no track holds a
    /// frame. Never touches a folder that is live right now; the caller
    /// runs this before any session starts.
    @discardableResult
    static func sweepInterrupted(now: Date = Date()) -> [AmbientCaptureManifest] {
        var swept: [AmbientCaptureManifest] = []
        for (directory, var manifest) in all() where manifest.status == .recording {
            for index in manifest.parts.indices where manifest.parts[index].endedAt == nil {
                let part = manifest.parts[index]
                manifest.parts[index].micFrames = AmbientTrackWriter.frameCount(of: directory.appendingPathComponent(part.micFile))
                manifest.parts[index].systemFrames = AmbientTrackWriter.frameCount(of: directory.appendingPathComponent(part.systemFile))
                manifest.parts[index].endedAt = now
            }
            manifest.endedAt = manifest.endedAt ?? now
            manifest.status = manifest.hasRecoverableAudio ? .interrupted : .failed
            manifest.note("Recovered at launch: the app was not running when this capture ended.", at: now)
            try? write(manifest, to: directory)
            swept.append(manifest)
        }
        return swept
    }

    /// The other half of the launch sweep: audio and records that no pass
    /// will ever read. A folder with no readable manifest (a start that
    /// died before its first write), a `failed` capture, and a `processed`
    /// one whose removal a crash cut short. Same rule as above: run before
    /// any session starts.
    static func sweepFinished(in root: URL = root) {
        guard let entries = try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) else { return }
        for directory in entries {
            guard let manifest = try? read(from: directory) else {
                remove(directory)
                continue
            }
            if manifest.status == .failed || manifest.status == .processed { remove(directory) }
        }
    }

    /// One capture, gone: tracks, manifest, `speaking.jsonl`. Idempotent —
    /// a folder that is already gone is not an error.
    static func remove(_ directory: URL) {
        try? FileManager.default.removeItem(at: directory)
    }

    /// One workspace's captures, for a sign-out of that workspace. The caller
    /// stops the live session first.
    static func removeAll(workspaceOrigin: String) {
        for (directory, manifest) in all() where manifest.workspaceOrigin == workspaceOrigin {
            remove(directory)
        }
    }

    /// Every capture on this Mac, for a sign-out of every workspace. The
    /// caller stops the live session first.
    static func removeAll() {
        try? FileManager.default.removeItem(at: root)
    }
}
