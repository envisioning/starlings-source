import Combine
import Foundation
import UIKit

/// The owner's unfiled capture list, kept alive for Home rather than only for
/// the Work tab. A note is deliberately not a task until triage supplies its
/// subject and other filing choices.
@MainActor
final class MobileQuickNotesStore: ObservableObject {
    static let poll: TimeInterval = 300

    @Published private(set) var notes: [QuickNote] = []
    @Published private(set) var isLoading = false
    @Published private(set) var isSaving = false
    @Published private(set) var errorMessage: String?
    /// Home waits for the cached or live first answer before replacing its
    /// fixed-height NOTES loading card.
    @Published private(set) var homeReady = false
    /// The last destination set opened by Quick Note filing. Reused by later
    /// sheets until its source list changes or the five-minute memory window
    /// expires (docs/CACHING.md).
    @Published private(set) var filingOptions: QuickNoteDestinationOptions?
    /// Captures this phone holds that the Worker does not have yet, by id
    ///. A row reads it for its "Not sent" mark and the Worker's
    /// refusal, when there is one.
    @Published private(set) var pending: [QuickNote.ID: QuickNotePending] = [:]
    /// The other workspaces this phone is signed in to: Move to ▸ lists
    /// them, and is not drawn when there are none. Read at attach and on each
    /// sign-in; a workspace switch rebuilds the app.
    @Published private(set) var moveTargets: [StarlingsWorkspace] = []

    private weak var app: StarlingsAppModel?
    private var attached = false
    private var pollTask: Task<Void, Never>?
    private var cancellables: Set<AnyCancellable> = []
    /// Whose list is drawn: the owner painted at attach, then each sign-in.
    private var paintedOwner: String?
    /// The Worker's list as last read or written; `notes` is this with the
    /// outbox on top.
    private var listed: [QuickNote] = []
    /// Save first, send later: a capture is on disk before the
    /// field clears.
    private let outbox = QuickNoteOutbox(directory: AppFolders.support)
    /// Sends the outbox when the network comes back.
    private var recovery: ConnectivityRecovery?

    func attach(to app: StarlingsAppModel) {
        guard !attached else { return }
        attached = true
        self.app = app
        // Disk first, synchronously, before the sink hops and the poll's
        // first request (docs/CACHING.md).
        paintedOwner = app.ownerCredentials?.owner.email
        readMoveTargets()
        useOutbox()
        paintSnapshot()
        redraw()

        let recovery = ConnectivityRecovery { [weak self] in
            Task { await self?.sendPending() }
        }
        recovery.start()
        self.recovery = recovery

        app.$ownerCredentials
            .map { @Sendable in $0?.owner.email }
            .removeDuplicates()
            .sink { @Sendable email in
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    self.readMoveTargets()
                    // Only a different owner clears what is drawn.
                    if email != self.paintedOwner {
                        self.paintedOwner = email
                        self.listed = []
                        self.useOutbox()
                        self.redraw()
                        self.filingOptions = nil
                        QuickNoteDestinationOptionsCache.shared.clear()
                        self.homeReady = false
                        self.paintSnapshot()
                    }
                    // The poll's first pass is the read; see MobileMyWorkStore.
                    self.stop()
                    if self.app?.ownerCredentials != nil {
                        self.start()
                    } else {
                        await self.refresh()
                    }
                }
            }
            .store(in: &cancellables)

        NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)
            .map { @Sendable _ in () }
            .sink { @Sendable in Task { @MainActor [weak self] in self?.start() } }
            .store(in: &cancellables)

        NotificationCenter.default.publisher(for: UIApplication.didEnterBackgroundNotification)
            .map { @Sendable _ in () }
            .sink { @Sendable in Task { @MainActor [weak self] in self?.stop() } }
            .store(in: &cancellables)
        // No `start()` here: the credentials sink above fires with the
        // current session and starts the poll.
    }

    private func readMoveTargets() {
        let store = MobileOwnerSessionStore()
        moveTargets = QuickNoteMove.targets { (try? store.load(workspace: $0)) != nil }
    }

    /// The last list for the signed-in owner, from disk. No request.
    private func paintSnapshot() {
        guard listed.isEmpty, let app, let credentials = app.ownerCredentials,
              let cached = app.api.snapshot(StarlingsAPI.quickNotesSnapshotKey, credentials: credentials, as: QuickNotesResponse.self)
        else { return }
        listed = cached.value.notes
        redraw()
        homeReady = true
    }

    /// The signed-in owner's outbox on this workspace, or none.
    private func useOutbox() {
        let owner = app?.ownerCredentials.map { WorkspaceScope.active.keychainAccount($0.owner.email.lowercased()) }
        outbox.use(owner: owner)
    }

    /// `notes` is the Worker's list with the outbox on top: a refresh never
    /// drops a capture the Worker does not have yet.
    private func redraw() {
        notes = outbox.merged(listed)
        pending = Dictionary(outbox.entries.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    }

    /// Sends what the outbox holds, oldest first, on the signed-in session.
    /// Runs on create, on every refresh (so on launch, foreground and the
    /// poll) and when the network comes back. A dropped connection stays
    /// silent and the note stays; a refusal shows on its row.
    func sendPending() async {
        guard let app, let credentials = app.ownerCredentials else { return }
        useOutbox()
        guard !outbox.entries.isEmpty else { return }
        await outbox.drain(
            create: { entry in try await app.api.createQuickNote(credentials: credentials, entry.create) },
            rewrite: { id, body in try await app.api.updateQuickNote(credentials: credentials, id: id, body: body) },
            discard: { id in _ = try? await app.api.deleteQuickNote(credentials: credentials, id: id) },
            refusal: Self.refusal,
            landed: { [weak self] note in
                guard let self else { return }
                listed = [note] + listed.filter { $0.id != note.id }
            }
        )
        redraw()
    }

    /// The Worker's words when it refused the note; nil when the request
    /// never got an answer, or got one that says "later" (a 5xx, a 408, a
    /// 429, a token being renewed). Those wait silently for the next send.
    private static func refusal(_ error: any Error) -> String? {
        guard let failure = error as? StarlingsError, let status = failure.status else { return nil }
        if status >= 500 || status == 408 || status == 429 || failure.isOwnerSessionRejection { return nil }
        return failure.message
    }

    func start() {
        guard app?.ownerCredentials != nil, pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.refresh()
                try? await Task.sleep(for: .seconds(Self.poll))
            }
        }
    }

    func stop() {
        pollTask?.cancel()
        pollTask = nil
    }

    func refresh() async {
        guard let app, let credentials = app.ownerCredentials else {
            listed = []
            useOutbox()
            redraw()
            errorMessage = nil
            homeReady = false
            return
        }
        useOutbox()
        // Last known first, so the card never spins over a list it had
        // yesterday (docs/CACHING.md).
        paintSnapshot()
        isLoading = notes.isEmpty
        defer {
            isLoading = false
            homeReady = true
        }
        // The outbox first, so the list read after it already holds what
        // just went out.
        await sendPending()
        let mark = outbox.readMark()
        do {
            let fresh = try await app.api.quickNotes(credentials: credentials)
            guard app.ownerCredentials?.owner.email == credentials.owner.email else { return }
            listed = outbox.reconcile(fresh, readSince: mark)
            redraw()
            errorMessage = nil
        } catch {
            // Keep a stale list visible rather than replacing it with a blank
            // capture surface during a transient network failure.
            if notes.isEmpty { errorMessage = error.localizedDescription }
        }
    }

    /// Load the destination sets once for this owner. Subject search uses the
    /// same Core-backed typeahead endpoint as Work; the base page is cached so
    /// opening another triage sheet does not repeat the list reads.
    func loadFilingOptions() async throws -> QuickNoteDestinationOptions? {
        guard let app, let credentials = app.ownerCredentials else {
            filingOptions = nil
            return nil
        }
        let owner = credentials.owner.email
        if let cached = QuickNoteDestinationOptionsCache.shared.load(owner: owner) {
            filingOptions = cached
            return cached
        }

        async let projects = app.api.crmSubjectPage(credentials: credentials, kind: .project, query: "")
        async let leads = app.api.crmSubjectPage(credentials: credentials, kind: .lead, query: "")
        // Partners take a task too (by organization). Optional: the list is
        // still useful without them.
        async let partners = try? app.api.crmSubjectPage(credentials: credentials, kind: .organization, query: "")
        async let conversations = app.api.threads(credentials: credentials)
        async let state = app.api.crmSubjectState(credentials: credentials)
        let pages = try await (projects, leads)
        let stars = Set((try? await state)?.states.filter(\.starred).map(\.subjectKey) ?? [])
        let partnerPage = await partners
        let subjects = (pages.0.subjects + pages.1.subjects + (partnerPage?.subjects ?? [])).sorted { left, right in
            let (a, b) = (stars.contains(left.stateKey), stars.contains(right.stateKey))
            if a != b { return a }
            return left.title.localizedCaseInsensitiveCompare(right.title) == .orderedAscending
        }
        let options = QuickNoteDestinationOptions(
            subjects: subjects,
            starred: stars,
            threads: try await conversations,
            projectsHaveMore: pages.0.hasMore,
            leadsHaveMore: pages.1.hasMore,
            partnersHaveMore: partnerPage?.hasMore == true
        )
        guard let currentOwner = app.ownerCredentials?.owner.email,
              currentOwner.caseInsensitiveCompare(owner) == .orderedSame else {
            return nil
        }
        QuickNoteDestinationOptionsCache.shared.store(options, owner: owner)
        filingOptions = options
        return options
    }

    /// Saves the capture on this phone and draws it at once; the send runs
    /// behind it. True once the note is in the outbox, so the
    /// card clears its draft whether or not there is a connection. False
    /// only when the capture is empty or the owner is signed out, so the
    /// card leaves the draft in place.
    @discardableResult
    func create(body: String, source: QuickNoteSource = .home) async -> Bool {
        let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, app?.ownerCredentials != nil else { return false }
        useOutbox()
        outbox.add(QuickNotePending(body: trimmed, source: source))
        redraw()
        errorMessage = nil
        Task { await sendPending() }
        return true
    }

    /// Rewrite a note's body. Same gate as `create`: false without sending
    /// when the text is empty, so the card keeps the draft.
    @discardableResult
    func update(_ note: QuickNote, body: String) async -> Bool {
        let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              !isSaving,
              let app,
              let credentials = app.ownerCredentials
        else { return false }

        // Not sent yet: the outbox carries the new body.
        if outbox.contains(note.id) {
            outbox.rewrite(id: note.id, body: trimmed)
            redraw()
            errorMessage = nil
            Task { await sendPending() }
            return true
        }

        isSaving = true
        defer { isSaving = false }
        do {
            let saved = try await app.api.updateQuickNote(credentials: credentials, id: note.id, body: trimmed)
            listed = listed.map { $0.id == saved.id ? saved : $0 }
            redraw()
            errorMessage = nil
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    /// A note the Worker does not have yet goes out first;
    /// filing one it does not have would make the task and lose the link.
    /// Throws when it is still on this phone.
    func ensureSent(_ note: QuickNote) async throws {
        guard outbox.contains(note.id) else { return }
        await sendPending()
        if let entry = outbox.entry(id: note.id) {
            throw StarlingsError.local(entry.lastError ?? String(localized: "Not sent yet. Try again when you’re online."))
        }
    }

    /// Point a note at the thing Work triage made for it. The caller has
    /// already made the task, issue, message or document; this is the second
    /// write, and the Worker accepts it again if the first attempt was lost.
    func promote(_ note: QuickNote, _ promote: QuickNotePromote) async throws {
        guard let app, let credentials = app.ownerCredentials else { return }
        try await ensureSent(note)
        let filed = try await app.api.promoteQuickNote(credentials: credentials, id: note.id, promote)
        listed = listed.map { $0.id == filed.id ? filed : $0 }
        redraw()
        errorMessage = nil
    }

    @discardableResult
    func delete(_ note: QuickNote) async -> Bool {
        guard let app, let credentials = app.ownerCredentials else { return false }
        // Not sent yet: it leaves the outbox and nothing goes to the Worker.
        // A create that already left may have landed, so its copy is
        // deleted too, quietly; a send in flight deletes it when it lands.
        if let entry = outbox.entry(id: note.id) {
            outbox.remove(id: note.id)
            listed.removeAll { $0.id == note.id }
            redraw()
            errorMessage = nil
            if entry.sent {
                Task { try? await app.api.deleteQuickNote(credentials: credentials, id: note.id) }
            }
            return true
        }
        let previous = listed
        listed.removeAll { $0.id == note.id }
        redraw()
        do {
            try await app.api.deleteQuickNote(credentials: credentials, id: note.id)
            errorMessage = nil
            return true
        } catch {
            listed = previous
            redraw()
            errorMessage = error.localizedDescription
            return false
        }
    }

    /// Move to ▸ another workspace: the note is made there on the session
    /// this phone holds for it, then deleted here. The create carries the
    /// same id, so a retry after a failed delete finds the note it already
    /// made. False, with the reason in `errorMessage`, when it stays here.
    @discardableResult
    func move(_ note: QuickNote, to workspace: StarlingsWorkspace) async -> Bool {
        guard note.isOpen, !isSaving else { return false }
        let current = notes.first { $0.id == note.id } ?? note
        isSaving = true
        do {
            let (api, credentials) = try await session(for: workspace)
            _ = try await api.createQuickNote(credentials: credentials, QuickNoteMove.create(current))
        } catch {
            isSaving = false
            errorMessage = QuickNoteMove.failure(error, to: workspace)
            return false
        }
        isSaving = false
        return await delete(current)
    }

    /// Another workspace's API and session. The token is renewed first when
    /// it is near expiry and saved to that workspace's Keychain item; after
    /// that a refusal is the answer. Nothing here renews or signs out the
    /// active workspace.
    private func session(for workspace: StarlingsWorkspace) async throws -> (StarlingsAPI, MobileOwnerCredentials) {
        let store = MobileOwnerSessionStore()
        let api = StarlingsAPI(environment: MobileOwnerSessionStore.environment(for: workspace), ownerSessionRenewal: .none)
        guard var credentials = try store.load(workspace: workspace) else {
            throw StarlingsError.local(String(localized: "Sign in to \(workspace.name) again to move notes there."))
        }
        if let refreshToken = credentials.refreshToken, OwnerAccessToken.expiresSoon(credentials.accessToken) {
            let renewed = try await api.refreshSession(
                refreshToken: refreshToken,
                deviceID: store.deviceID(workspace: workspace),
                deviceName: UIDevice.current.name
            )
            // Saved before use: the refresh token just spent is refused from now on.
            try store.save(renewed, workspace: workspace)
            credentials = try store.load(workspace: workspace) ?? renewed
        }
        return (api, credentials)
    }
}
