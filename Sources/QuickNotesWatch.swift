import Foundation

/// Keeps the owner's private Quick Notes capture list available on the Mac
/// Home surface, even while the Work window is closed.
///
/// A capture is saved on this Mac first and sent behind it, in
/// the same outbox the phone keeps (`QuickNoteOutbox`).
@MainActor
final class QuickNotesWatch {
    static let poll: TimeInterval = 300

    private(set) var notes: [QuickNote] = []
    /// Captures this Mac holds that the Worker does not have yet, by id. A
    /// row reads it for its "Not sent yet" line or the Worker's refusal.
    private(set) var pending: [QuickNote.ID: QuickNotePending] = [:]
    private let api: MeetingControlAPI
    private let ownerSessionStore: any OwnerSessionKeychain
    private var observers: [([QuickNote]) -> Void] = []
    private var pollTask: Task<Void, Never>?
    /// The Worker's list as last read or written; `notes` is this with the
    /// outbox on top.
    private var listed: [QuickNote] = []
    private let outbox = QuickNoteOutbox(directory: AppFolders.support)
    /// Sends the outbox when the network comes back or the Mac wakes.
    private var recovery: ConnectivityRecovery?

    init(api: MeetingControlAPI, ownerSessionStore: any OwnerSessionKeychain) {
        self.api = api
        self.ownerSessionStore = ownerSessionStore
    }

    func observe(_ observer: @escaping ([QuickNote]) -> Void) {
        observers.append(observer)
        observer(notes)
    }

    func start() {
        guard pollTask == nil else { return }
        useOutbox()
        // The last list first (docs/CACHING.md), then the poll. A saved empty
        // list is an answer too: it is drawn, not waited on.
        if listed.isEmpty, let cached = api.snapshot(MeetingControlAPI.quickNotesSnapshotKey, as: QuickNotesResponse.self) {
            listed = cached.value.notes
        }
        redraw()
        if recovery == nil {
            let recovery = ConnectivityRecovery { [weak self] in self?.sendNow() }
            recovery.start()
            self.recovery = recovery
        }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.tick()
                try? await Task.sleep(for: .seconds(Self.poll))
            }
        }
    }

    func stop() {
        pollTask?.cancel()
        pollTask = nil
    }

    func refreshNow() {
        Task { [weak self] in await self?.tick() }
    }

    func adopt(_ note: QuickNote) {
        listed = [note] + listed.filter { $0.id != note.id }
        redraw()
    }

    /// Saves the capture on this Mac and draws it at once; the send runs
    /// behind it. False only when nobody is signed in, so the composer keeps
    /// the draft.
    @discardableResult
    func create(body: String) -> Bool {
        useOutbox()
        guard outbox.owner != nil else { return false }
        outbox.add(QuickNotePending(body: body, source: .home))
        redraw()
        sendNow()
        return true
    }

    func update(id: String, body: String) async throws {
        // Not sent yet: the outbox carries the new body.
        if outbox.contains(id) {
            outbox.rewrite(id: id, body: body)
            redraw()
            sendNow()
            return
        }
        let note = try await api.updateQuickNote(id: id, body: body)
        listed = listed.map { $0.id == note.id ? note : $0 }
        redraw()
    }

    func delete(id: String) async throws {
        // Not sent yet: it leaves the outbox and nothing goes to the Worker.
        // A create that already left may have landed, so its copy goes too,
        // quietly; a send in flight deletes it when it lands.
        if let entry = outbox.entry(id: id) {
            outbox.remove(id: id)
            listed.removeAll { $0.id == id }
            redraw()
            if entry.sent {
                let api = api
                Task { _ = try? await api.deleteQuickNote(id: id) }
            }
            return
        }
        try await api.deleteQuickNote(id: id)
        listed.removeAll { $0.id == id }
        redraw()
    }

    /// Move to ▸ another workspace: the note is made there on that
    /// workspace's session, then deleted here. The create carries the same
    /// id, so a retry after a failed delete finds the note it already made.
    func move(id: String, to workspace: StarlingsWorkspace) async throws {
        guard let note = notes.first(where: { $0.id == id }), note.isOpen else { return }
        let target = await MeetingControlAPI.otherWorkspace(workspace)
        _ = try await target.createQuickNote(QuickNoteMove.create(note))
        try await delete(id: id)
    }

    private func sendNow() {
        Task { [weak self] in await self?.sendPending() }
    }

    /// Sends what the outbox holds, oldest first. A dropped connection stays
    /// silent and the note stays; a refusal shows on its row.
    private func sendPending() async {
        useOutbox()
        guard !outbox.entries.isEmpty else { return }
        let api = api
        await outbox.drain(
            create: { entry in try await api.createQuickNote(entry.create) },
            rewrite: { id, body in try await api.updateQuickNote(id: id, body: body) },
            discard: { id in _ = try? await api.deleteQuickNote(id: id) },
            refusal: Self.refusal,
            landed: { [weak self] note in
                guard let self else { return }
                listed = [note] + listed.filter { $0.id != note.id }
            }
        )
        redraw()
    }

    /// The Worker's words when it refused the note; nil for a failure that
    /// says "later" (offline, timeout, a 5xx, busy, signed out), which waits
    /// silently for the next send.
    private static func refusal(_ error: any Error) -> String? {
        guard let failure = error as? StarlingsError else { return nil }
        switch failure.code {
        case "service.timeout", "service.offline", "service.cancelled", "service.unreachable",
             "service.unavailable", "service.rate_limited", "service.invalid_response",
             "auth.required", "auth.session_expired":
            return nil
        default:
            return failure.message.isEmpty ? failure.title : failure.message
        }
    }

    /// The signed-in owner's outbox on this workspace, or none.
    private func useOutbox() {
        let email = (try? ownerSessionStore.load())?.owner.email
        outbox.use(owner: email.map { WorkspaceScope.active.keychainAccount($0.lowercased()) })
    }

    private func tick() async {
        guard (try? ownerSessionStore.load()) != nil else {
            useOutbox()
            listed = []
            redraw()
            return
        }
        // The outbox first, so the list read after it already holds what
        // just went out.
        await sendPending()
        let mark = outbox.readMark()
        do {
            let next = try await api.quickNotes()
            listed = outbox.reconcile(next, readSince: mark)
            redraw()
        } catch {
            // A stale capture list is more useful than an empty Home card.
        }
    }

    /// `notes` is the Worker's list with the outbox on top: a poll never
    /// drops a capture the Worker does not have yet. Observers hear only a
    /// change.
    private func redraw() {
        let next = outbox.merged(listed)
        let nextPending = Dictionary(outbox.entries.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        guard next != notes || nextPending != pending else { return }
        notes = next
        pending = nextPending
        notify()
    }

    private func notify() {
        for observer in observers { observer(notes) }
    }
}
