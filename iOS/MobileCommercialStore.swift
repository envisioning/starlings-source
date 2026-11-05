import Combine
import Foundation
import UIKit

/// Slow, read-only commercial history for the Home card. Core remains the
/// source of truth; this store only keeps the last answer for the phone.
@MainActor
final class MobileCommercialStore: ObservableObject {
    static let poll: TimeInterval = 300

    @Published private(set) var summary: CommercialSummary?
    @Published private(set) var isLoading = false
    @Published private(set) var homeReady = false
    private var lastAnswered: Date?
    /// Whose summary is drawn: the owner painted at attach, then each sign-in.
    private var paintedOwner: String?

    private weak var app: StarlingsAppModel?
    private var attached = false
    private var pollTask: Task<Void, Never>?
    private var cancellables: Set<AnyCancellable> = []

    func attach(to app: StarlingsAppModel) {
        guard !attached else { return }
        attached = true
        self.app = app
        // Disk first, synchronously, before the sink hops and the poll asks
        // Core (docs/CACHING.md).
        paintedOwner = app.ownerCredentials?.owner.email
        paintSnapshot()

        app.$ownerCredentials
            .map { @Sendable in $0?.owner.email }
            .removeDuplicates()
            .sink { @Sendable email in
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    self.stop()
                    // Only a different owner clears what is drawn.
                    if email != self.paintedOwner {
                        self.paintedOwner = email
                        self.summary = nil
                        self.homeReady = false
                        self.lastAnswered = nil
                        self.paintSnapshot()
                    }
                    if self.app?.ownerCredentials != nil {
                        self.start()
                    }
                }
            }
            .store(in: &cancellables)

        NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)
            .map { @Sendable _ in () }
            .sink { @Sendable in Task { @MainActor [weak self] in self?.start() } }
            .store(in: &cancellables)

        NotificationCenter.default.publisher(for: UIApplication.willResignActiveNotification)
            .map { @Sendable _ in () }
            .sink { @Sendable in Task { @MainActor [weak self] in self?.stop() } }
            .store(in: &cancellables)
        // No `start()` here: the credentials sink above fires with the
        // current session and starts the poll. A second start here was
        // cancelled by it, and its request with it.
    }

    /// Last known first (docs/CACHING.md): the card draws the last summary
    /// while the Core read runs.
    private func paintSnapshot() {
        guard summary == nil, let app, let credentials = app.ownerCredentials,
              let cached = app.api.snapshot(StarlingsAPI.commercialSnapshotKey, credentials: credentials, as: CommercialSummary.self)
        else { return }
        summary = cached.value
        homeReady = true
    }

    func start() {
        guard pollTask == nil, app?.ownerCredentials != nil else { return }
        pollTask = Task { [weak self] in
            // A return from a short app switch keeps the answer it has.
            let isStale = self?.lastAnswered.map { Date().timeIntervalSince($0) >= 60 } ?? true
            if isStale { await self?.refresh() }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(Self.poll))
                guard !Task.isCancelled else { return }
                await self?.refresh()
            }
        }
    }

    func stop() {
        pollTask?.cancel()
        pollTask = nil
    }

    func refresh() async {
        guard let app, let credentials = app.ownerCredentials else {
            summary = nil
            homeReady = false
            return
        }
        isLoading = summary == nil
        defer {
            isLoading = false
            homeReady = true
        }
        if let next = try? await app.api.commercialSummary(credentials: credentials) {
            summary = next
            lastAnswered = Date()
        }
    }
}
