import Foundation
import WatchConnectivity
import WatchKit
import WidgetKit
import StarlingsContracts

/// A screen a complication opens.
enum WatchRoute: Hashable {
    case note
    case work
}

/// Everything the watch app knows, and the one place it changes.
///
/// The session and the agenda arrive from the phone as a `WatchBridgeSnapshot`
/// and are never fetched here. The system keeps the last received context
/// across launches (`receivedApplicationContext`), so there is no store of our
/// own for the token — the watch forgets it the moment the phone sends a
/// snapshot without one.
///
/// One instance, `shared`: the view and the background refresh
/// (`WatchAppDelegate`) must drain the same queue.
@MainActor
final class WatchStore: NSObject, ObservableObject {
    static let shared = WatchStore()

    @Published private(set) var snapshot: WatchBridgeSnapshot = .empty
    /// The lent token was refused. Cleared by the next snapshot that differs.
    @Published private(set) var sessionStale = false
    /// Notes dictated with no connection, oldest first, each filed under its
    /// owner. They go on the next foreground, the next snapshot, or the next
    /// background refresh, in order.
    @Published private(set) var queue: [PendingNote] = []
    /// The owner's open notes, as the Worker last listed them. Kept on disk so
    /// the list draws before the first read and without a connection.
    @Published private(set) var notes: [QuickNote] = []
    /// The notes could not be read; shown only when there is no list to draw.
    @Published private(set) var notesUnavailable = false
    @Published private(set) var isSavingNote = false
    @Published private(set) var busyNotes: Set<String> = []
    @Published var notice: String?
    /// The screen a complication tap asked for. The home view pushes it.
    @Published var path: [WatchRoute] = []

    /// A note dictated on the wrist that has not reached the Worker yet.
    struct PendingNote: Codable, Equatable, Identifiable, Sendable {
        let id: String
        let body: String
        /// The owner's email when it was dictated. Nil for a note queued by a
        /// build before the field, which goes with whichever owner is current.
        let owner: String?
        let createdAt: Date
        /// The workspace API it was dictated for (slice E). Nil for a note
        /// queued before the field: every such note was dictated while only
        /// the build's own workspace could be signed in.
        var apiEndpoint: String? = nil
    }

    private struct NotesCache: Codable {
        let owner: String?
        let notes: [QuickNote]
        var apiEndpoint: String? = nil
    }

    private var started = false
    private var flushing = false
    private var sessionRequested = false
    private static let retryInterval: TimeInterval = 15 * 60
    private static let queueKey = "meet.watch.noteQueue"
    /// The queue before notes carried an owner: plain strings.
    private static let legacyQueueKey = "meet.watch.pendingNotes"
    private static let notesKey = "meet.watch.notes"

    /// Signed in, even while the lent token is stale: the agenda needs no
    /// token, and a dictated note waits in the queue.
    var isSignedIn: Bool { snapshot.session != nil }
    var ownerName: String? { snapshot.session?.ownerName }
    /// Which workspace and account the phone signed the wrist in to.
    var workspaceName: String? { snapshot.session?.workspaceName }
    var ownerEmail: String? { snapshot.session?.ownerEmail }
    private var owner: String? { snapshot.session?.ownerEmail }
    private var apiEndpoint: String? { snapshot.session?.apiEndpoint }

    /// The queued notes that belong to the owner and the workspace signed in
    /// now. Another workspace's notes wait for it; the same address on two
    /// workspaces is two owners (slice E).
    var pendingNotes: [PendingNote] {
        queue.filter {
            ($0.owner == nil || $0.owner == owner) && ($0.apiEndpoint == nil || $0.apiEndpoint == apiEndpoint)
        }
    }

    private var client: WatchStarlingsClient? {
        snapshot.session.map(WatchStarlingsClient.init)
    }

    override private init() {
        super.init()
        queue = Self.loadQueue()
    }

    /// Safe to call more than once: the view calls it on appear, and a
    /// background refresh can come first.
    func start() {
        guard !started, WCSession.isSupported() else { return }
        started = true
        let session = WCSession.default
        session.delegate = self
        session.activate()
        apply(context: session.receivedApplicationContext)
    }

    // MARK: Snapshot

    private func apply(context: [String: Any]) {
        guard let received = WatchBridgeSnapshot.decode(context: context) else { return }
        apply(received)
    }

    private func apply(_ received: WatchBridgeSnapshot) {
        let previousOwner = owner
        let previousEndpoint = apiEndpoint
        let newSession = received.session != snapshot.session
        if newSession {
            sessionStale = false
            sessionRequested = false
        }
        snapshot = received
        if received.session == nil {
            // The queue stays: each note carries its owner, and goes when that
            // owner signs in again. The list is this owner's.
            notes = []
            UserDefaults.standard.removeObject(forKey: Self.notesKey)
        } else {
            if received.session?.ownerEmail != previousOwner || received.session?.apiEndpoint != previousEndpoint {
                loadNotesCache()
            }
            // A new token is the moment a queued note can go.
            if newSession { Task { await flushQueue() } }
        }
        var agenda = WatchBridgeSnapshot.Agenda(meetings: received.meetings, preferences: .defaults)
        agenda.work = received.work
        AgendaFile.write(agenda)
        WidgetCenter.shared.reloadAllTimelines()
    }

    /// Today's work from the last snapshot; empty from an older phone.
    var work: [WatchBridgeSnapshot.WorkRow] { snapshot.work ?? [] }

    /// A complication tap: `meetwatch://note` or `meetwatch://work`.
    func open(_ url: URL) {
        guard url.scheme == WatchBridgeSnapshot.watchScheme else { return }
        switch url.host {
        case "note": path = [.note]
        case "work": path = [.work]
        default: path = []
        }
    }

    /// The meetings still ahead, by the clock, not by the snapshot.
    func upcoming(now: Date = Date()) -> [WatchBridgeSnapshot.Meeting] {
        snapshot.meetings.filter { $0.end > now }
    }

    /// The Worker refused the lent token. Ask the phone once per token; it
    /// renews if it must and sends the snapshot again. The phone may be out
    /// of reach, and then the next snapshot it sends on its own does it.
    private func tokenRefused() {
        sessionStale = true
        guard !sessionRequested else { return }
        let session = WCSession.default
        guard session.activationState == .activated, session.isReachable else { return }
        sessionRequested = true
        session.sendMessage([WatchBridgeSnapshot.sessionRequestKey: true], replyHandler: nil, errorHandler: nil)
    }

    // MARK: Foreground

    /// The door is the phone's: a knock banner mirrors to the wrist and its
    /// Admit runs on the phone. The watch app never polls the lobby.
    func enterForeground() {
        Task {
            await flushQueue()
            await refreshNotes()
        }
    }

    /// The background refresh: send what is queued, and ask for another turn
    /// while anything is left.
    func backgroundRefresh() async {
        start()
        await flushQueue()
        if !pendingNotes.isEmpty { Self.scheduleRetry() }
    }

    // MARK: Quick notes

    /// Dictated text becomes an unfiled quick note, the same row a phone
    /// capture makes. If the Worker is out of reach the note waits in the
    /// queue; a dictated thought must not be lost to a dropped Bluetooth link.
    func saveNote(_ text: String) async {
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty, isSignedIn else { return }
        isSavingNote = true
        defer { isSavingNote = false }
        // Queued first, then sent behind the queue: the notes keep
        // their order, and the id minted here is the one every try sends, so
        // a lost answer plus a retry is still one note.
        let pending = PendingNote(id: UUID().uuidString.lowercased(), body: body, owner: owner, createdAt: Date(), apiEndpoint: apiEndpoint)
        queue.append(pending)
        persistQueue()
        await flushQueue()
        if queue.contains(where: { $0.id == pending.id }) {
            Self.scheduleRetry()
            notice = String(localized: "Saved, sends later")
        } else {
            notice = String(localized: "Saved")
        }
    }

    /// A queued note the owner no longer wants. It never reached the Worker.
    func discard(_ pending: PendingNote) {
        queue.removeAll { $0.id == pending.id }
        persistQueue()
    }

    private func flushQueue() async {
        guard !flushing else { return }
        flushing = true
        defer { flushing = false }
        while let next = pendingNotes.first {
            guard await post(next) else { return }
            queue.removeAll { $0.id == next.id }
            persistQueue()
        }
    }

    /// True once the Worker has the note; the list shows it at once.
    private func post(_ pending: PendingNote) async -> Bool {
        guard let client, !sessionStale else { return false }
        // A note queued before the id and the time were sent carries an
        // upper-case id and, from the oldest builds, no real time.
        let written = pending.createdAt.timeIntervalSince1970
        let capturedAt = written > 0 ? Int((written * 1000).rounded()) : nil
        do {
            let note = try await client.createQuickNote(pending.body, id: pending.id.lowercased(), capturedAt: capturedAt)
            notes = [note] + notes.filter { $0.id != note.id }
            persistNotesCache()
            return true
        } catch is WatchStarlingsClient.SessionRejected {
            tokenRefused()
            return false
        } catch {
            return false
        }
    }

    func refreshNotes() async {
        guard let client, !sessionStale else { return }
        do {
            notes = try await client.quickNotes().filter(\.isOpen)
            notesUnavailable = false
            persistNotesCache()
        } catch is WatchStarlingsClient.SessionRejected {
            tokenRefused()
        } catch {
            notesUnavailable = true
        }
    }

    /// Dictated text goes under the note's body, on a line of its own.
    func append(_ text: String, to note: QuickNote) async {
        let addition = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !addition.isEmpty else { return }
        await edit(note) { client in
            try await client.updateQuickNote(id: note.id, body: note.body + "\n" + addition)
        }
    }

    func delete(_ note: QuickNote) async {
        await edit(note) { client in
            try await client.deleteQuickNote(id: note.id)
            return nil
        }
    }

    /// One write to one note: the note is busy while it runs, and the list
    /// takes the answer. A nil answer means the note is gone.
    private func edit(_ note: QuickNote, _ write: (WatchStarlingsClient) async throws -> QuickNote?) async {
        guard let client, !sessionStale, !busyNotes.contains(note.id) else {
            notice = String(localized: "Open Starlings on your phone")
            return
        }
        busyNotes.insert(note.id)
        defer { busyNotes.remove(note.id) }
        do {
            if let saved = try await write(client) {
                notes = notes.map { $0.id == saved.id ? saved : $0 }
            } else {
                notes.removeAll { $0.id == note.id }
            }
            persistNotesCache()
        } catch is WatchStarlingsClient.SessionRejected {
            tokenRefused()
        } catch {
            notice = String(localized: "Couldn’t save")
        }
    }

    // MARK: Storage

    private static func loadQueue() -> [PendingNote] {
        let defaults = UserDefaults.standard
        var queue = defaults.data(forKey: queueKey)
            .flatMap { try? JSONDecoder().decode([PendingNote].self, from: $0) } ?? []
        if let legacy = defaults.stringArray(forKey: legacyQueueKey) {
            queue = legacy.map { PendingNote(id: UUID().uuidString, body: $0, owner: nil, createdAt: .distantPast) } + queue
            defaults.removeObject(forKey: legacyQueueKey)
            if let data = try? JSONEncoder().encode(queue) { defaults.set(data, forKey: queueKey) }
        }
        return queue
    }

    private func persistQueue() {
        guard let data = try? JSONEncoder().encode(queue) else { return }
        UserDefaults.standard.set(data, forKey: Self.queueKey)
    }

    private func loadNotesCache() {
        guard let data = UserDefaults.standard.data(forKey: Self.notesKey),
              let cache = try? JSONDecoder().decode(NotesCache.self, from: data),
              cache.owner == owner,
              cache.apiEndpoint == nil || cache.apiEndpoint == apiEndpoint
        else {
            notes = []
            return
        }
        notes = cache.notes
    }

    private func persistNotesCache() {
        guard let data = try? JSONEncoder().encode(NotesCache(owner: owner, notes: notes, apiEndpoint: apiEndpoint)) else { return }
        UserDefaults.standard.set(data, forKey: Self.notesKey)
    }

    /// The system decides when; it is a floor, not a promise.
    private static func scheduleRetry() {
        WKApplication.shared().scheduleBackgroundRefresh(
            withPreferredDate: Date().addingTimeInterval(retryInterval),
            userInfo: nil
        ) { _ in }
    }
}

extension WatchStore: WCSessionDelegate {
    nonisolated func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {
        // Decode here: the dictionary is not `Sendable`, the snapshot is.
        guard let received = WatchBridgeSnapshot.decode(context: session.receivedApplicationContext) else { return }
        Task { @MainActor in self.apply(received) }
    }

    nonisolated func session(_ session: WCSession, didReceiveApplicationContext context: [String: Any]) {
        guard let received = WatchBridgeSnapshot.decode(context: context) else { return }
        Task { @MainActor in self.apply(received) }
    }
}
