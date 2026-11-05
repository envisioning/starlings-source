import AppKit
import Combine
import StarlingsContracts

/// Your own work, watched for the life of the app rather than the life of the
/// Work window.
///
/// The launch card and the menu bar show the focus slice of Mine, and both
/// are on screen with the Work window shut. So this polls
/// `/api/crm/mine` on its own cadence — every few minutes, because a task's
/// date changes about once a day, not once a second like a ring — and hands
/// the list to whoever draws it. Nothing here decides what is in focus;
/// `WorkItems.focus` does, on the device that knows what day it is.
///
/// Envisioning-only by construction: the route refuses anyone without a
/// verified member session, and this skips the request entirely when nobody is
/// signed in.
@MainActor
final class WorkWatch {
    /// Cadence in seconds. A poll this slow is why the Work window calls
    /// `refreshNow()` after every write — the list must not lag the tick that
    /// changed it by five minutes.
    static let poll: TimeInterval = 300

    private(set) var tasks: [CrmMyTask] = []
    /// Issues assigned to you, beside the tasks: Mine is one list.
    private(set) var issues: [CrmIssue] = []
    /// INBOX, on the same cadence: every glance surface counts and lists
    /// what needs you from here ("inbox everywhere"). Unread talk
    /// inside it is also on the faster thread poll; badges add the two.
    private(set) var inbox: WorkInboxResponse = .empty
    /// Set only when the list has never been read. A stale list is left alone:
    /// last-known beats an empty card.
    private(set) var lastErrorMessage: String?

    private let api: MeetingControlAPI
    private let ownerSessionStore: any OwnerSessionKeychain
    private var observers: [([CrmMyTask], [CrmIssue]) -> Void] = []
    private var inboxObservers: [(WorkInboxResponse) -> Void] = []
    private var pollTask: Task<Void, Never>?
    /// Which rows have been seen, for `InboxNotices.plan`: a new key from a
    /// source somebody else writes to is a banner, once.
    private var seenInboxKeys: Set<String> = []
    private var hasObservedInbox = false

    init(api: MeetingControlAPI, ownerSessionStore: any OwnerSessionKeychain) {
        self.api = api
        self.ownerSessionStore = ownerSessionStore
    }

    /// Whether anything — a snapshot or a live read — has answered yet. An
    /// observer is not called with the empty start: Home draws placeholders
    /// until the first answer, and "nothing" is an answer only once read.
    private var tasksAnswered = false
    private var inboxAnswered = false

    /// Called back on every poll, and immediately with whatever is already
    /// known so a surface that appears mid-cycle paints at once.
    func observe(_ observer: @escaping ([CrmMyTask], [CrmIssue]) -> Void) {
        observers.append(observer)
        if tasksAnswered { observer(tasks, issues) }
    }

    func observeInbox(_ observer: @escaping (WorkInboxResponse) -> Void) {
        inboxObservers.append(observer)
        if inboxAnswered { observer(inbox) }
    }

    func start() {
        guard pollTask == nil else { return }
        // Paint what was last known before the first poll answers
        // (docs/CACHING.md): Home's WORK card is right in the first frame.
        if tasks.isEmpty, let cached = api.snapshot(MeetingControlAPI.mineSnapshotKey, as: CrmMyWorkResponse.self) {
            publish(cached.value.tasks, cached.value.issues)
        }
        if inbox.items.isEmpty, let cached = api.snapshot(MeetingControlAPI.inboxSnapshotKey, as: WorkInboxResponse.self) {
            publishInbox(cached.value)
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

    /// After a write, or a window opening: read again rather than waiting out
    /// the cadence.
    func refreshNow() {
        Task { [weak self] in await self?.tick() }
    }

    private func tick() async {
        // Signed out is not an error state: publish nothing and stay cheap.
        guard (try? ownerSessionStore.load()) != nil else {
            // Signed out is an answer too: nothing on your plate.
            if !tasks.isEmpty || !issues.isEmpty || !tasksAnswered { publish([], []) }
            if !inbox.items.isEmpty || !inboxAnswered { publishInbox(.empty) }
            return
        }
        do {
            let work = try await api.crmMyWork()
            lastErrorMessage = nil
            if !tasksAnswered || work.tasks != tasks || work.issues != issues { publish(work.tasks, work.issues) }
        } catch {
            if tasks.isEmpty {
                lastErrorMessage = (error as? StarlingsError)?.message ?? String(localized: "Couldn’t load your work")
            }
        }
        // Read on its own: a Core that will not answer for tasks must not
        // empty a note somebody typed a minute ago. A failure keeps the last
        // list, like the tasks above.
        if let next = try? await api.crmInbox(), !inboxAnswered || next.items.map(\.id) != inbox.items.map(\.id) {
            publishInbox(next)
        }
    }

    /// The Work window read INBOX itself, after a write it made. Hand the
    /// answer here so Home and the menu bar move with it instead of waiting
    /// out the cadence or asking the Worker a second time.
    func adoptInbox(_ next: WorkInboxResponse) {
        guard next.items.map(\.id) != inbox.items.map(\.id) else { return }
        publishInbox(next)
    }

    /// A row answered in this app leaves every glance surface at once.
    func dropInboxItem(key: String) {
        guard inbox.items.contains(where: { $0.id == key }) else { return }
        publishInbox(inbox.removing(key: key))
    }

    private func publishInbox(_ next: WorkInboxResponse) {
        inbox = next.retainingQuestions(from: inbox)
        inboxAnswered = true
        // The first answer — a cached snapshot or the first poll — records
        // what is there; only what arrives after it is announced.
        let planned = InboxNotices.plan(items: next.items, seen: seenInboxKeys, isFirstObservation: !hasObservedInbox)
        seenInboxKeys = planned.seen
        hasObservedInbox = true
        Task { await InboxNotices.deliver(planned.notices, authorize: StarlingsNotices.requestAuthorization) }
        for observer in inboxObservers { observer(inbox) }
    }

    private func publish(_ next: [CrmMyTask], _ nextIssues: [CrmIssue]) {
        tasks = next
        issues = nextIssues
        tasksAnswered = true
        for observer in observers { observer(next, nextIssues) }
    }
}

/// The Home commercial card's slow Core read. It shares WorkWatch's lifetime
/// because both are glance data and neither deserves a request per Home render.
@MainActor
final class CommercialWatch {
    static let poll: TimeInterval = 300

    private let api: MeetingControlAPI
    private let ownerSessionStore: any OwnerSessionKeychain
    private var observer: ((CommercialSummary?) -> Void)?
    private var pollTask: Task<Void, Never>?
    private(set) var summary: CommercialSummary?
    private var answered = false

    init(api: MeetingControlAPI, ownerSessionStore: any OwnerSessionKeychain) {
        self.api = api
        self.ownerSessionStore = ownerSessionStore
    }

    func observe(_ observer: @escaping (CommercialSummary?) -> Void) {
        self.observer = observer
        if answered { observer(summary) }
    }

    func start() {
        guard pollTask == nil else { return }
        // The last summary first (docs/CACHING.md): read from disk
        // before the poll's first request, so COMMERCIAL is right in the
        // first frame and offline keeps its numbers.
        if !answered, let cached = api.snapshot(MeetingControlAPI.commercialSnapshotKey, as: CommercialSummary.self) {
            publish(cached.value)
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

    /// One poll, awaited. `refreshNow` is the fire-and-forget form.
    func tick() async {
        guard (try? ownerSessionStore.load()) != nil else {
            publish(nil)
            return
        }
        if let next = try? await api.commercialSummary() {
            publish(next)
        } else if summary == nil {
            // Failure is still an answer for a cold Home: do not hold a
            // permanent loading card over the rest of the surface.
            publish(nil)
        }
    }

    private func publish(_ next: CommercialSummary?) {
        guard !answered || next != summary else { return }
        answered = true
        summary = next
        observer?(next)
    }
}

/// Home's QUICK ACCESS list: starred rows as search rows, from the Worker
/// (`crmStarred`). Polled like the commercial summary; a star change asks
/// for a fresh read (`refreshNow`).
@MainActor
final class StarredWatch: ObservableObject {
    static let poll: TimeInterval = 300

    private let api: MeetingControlAPI
    private let ownerSessionStore: any OwnerSessionKeychain
    private var observer: (([SearchRow]) -> Void)?
    private var favoritesObserver: (([FavoriteRow]) -> Void)?
    private var pollTask: Task<Void, Never>?
    @Published private(set) var rows: [SearchRow] = []
    @Published private(set) var favorites: [FavoriteRow] = []
    private var answered = false

    init(api: MeetingControlAPI, ownerSessionStore: any OwnerSessionKeychain) {
        self.api = api
        self.ownerSessionStore = ownerSessionStore
    }

    func observe(_ observer: @escaping ([SearchRow]) -> Void) {
        self.observer = observer
        if answered { observer(rows) }
    }

    func observeFavorites(_ observer: @escaping ([FavoriteRow]) -> Void) {
        favoritesObserver = observer
        observer(favorites)
    }

    func contains(_ target: FavoriteTarget) -> Bool {
        favorites.contains { FavoriteTargets.matches($0, target) }
    }

    func setFavorite(_ target: FavoriteTarget, starred: Bool) async throws {
        try await api.crmSetFavorite(target, starred: starred)
        await tick()
    }

    /// A starred subject was merged into another: the star moves
    /// to the survivor. Quiet on failure: the old star still opens the survivor.
    func moveStar(kind: String, from mergedID: String, to survivorID: String) async {
        guard let merged = FavoriteTargets.crmSubject(kind: kind, id: mergedID),
              let survivor = FavoriteTargets.crmSubject(kind: kind, id: survivorID),
              contains(merged) else { return }
        try? await api.crmSetFavorite(survivor, starred: true)
        try? await api.crmSetFavorite(merged, starred: false)
        await tick()
    }

    func start() {
        guard pollTask == nil else { return }
        // The last starred rows first (docs/CACHING.md), before the
        // poll's first request: QUICK ACCESS draws them in the first frame.
        if !answered, let cached = api.snapshot(MeetingControlAPI.starredSnapshotKey, as: SearchResponse.self) {
            publish(SearchAnswer(cached.value).rows)
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

    /// One poll, awaited. `refreshNow` is the fire-and-forget form.
    func tick() async {
        guard (try? ownerSessionStore.load()) != nil else {
            publishFavorites([])
            publish([])
            return
        }
        if let next = try? await api.crmFavorites() { publishFavorites(next) }
        if let next = try? await api.crmStarred() {
            publish(next.rows)
        } else if !answered {
            // Failure is still an answer for a cold Home: do not hold a
            // permanent loading card over the rest of the surface.
            publish([])
        }
    }

    private func publish(_ next: [SearchRow]) {
        guard !answered || next != rows else { return }
        answered = true
        rows = next
        observer?(next)
    }

    private func publishFavorites(_ next: [FavoriteRow]) {
        guard next != favorites else { return }
        favorites = next
        favoritesObserver?(next)
    }
}

extension NSMenu {
    @MainActor
    func addFavoriteAction(_ target: FavoriteTarget, watch: StarredWatch, window: NSWindow?) {
        let starred = watch.contains(target)
        let item = ClosureMenuItem(title: String(localized: starred ? "Unstar" : "Star")) {
            Task { @MainActor in
                do {
                    try await watch.setFavorite(target, starred: !starred)
                } catch {
                    StarlingsToast.show(error.localizedDescription, tone: .danger, in: window)
                }
            }
        }
        item.symbol(starred ? .unstar : .star)
        addItem(item)
    }
}
