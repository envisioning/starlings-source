import Combine
import Foundation
import UIKit

/// What Home is made of on this phone: the owner-synced module order
/// (`fixtures/home-layout.json`), cached locally for the first frame and
/// replaced by the Worker's answer on sign-in and every foreground. Settings
/// writes through `save`, so Home re-draws before the round trip lands.
@MainActor
final class MobileHomeLayoutStore: ObservableObject {
    @Published private(set) var layout: [HomeModuleSetting] = HomeLayoutCache.load()
    @Published private(set) var isSaving = false
    @Published private(set) var errorMessage: String?
    /// The order is known: read on this device before, or answered now.
    /// Without this, a remote preference could reorder already-painted cards
    /// on a first launch.
    @Published private(set) var homeReady = HomeLayoutCache.isStored()

    private weak var app: StarlingsAppModel?
    private var attached = false
    /// Sign-in, foreground and Home all ask at launch; they share one read.
    private var inFlight: Task<Void, Never>?
    private var cancellables: Set<AnyCancellable> = []


    func attach(to app: StarlingsAppModel) {
        guard !attached else { return }
        attached = true
        self.app = app

        app.$ownerCredentials
            .map { @Sendable in $0?.owner.email }
            .removeDuplicates()
            .sink { @Sendable _ in
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    self.homeReady = self.app?.ownerCredentials != nil && HomeLayoutCache.isStored()
                    await self.refresh()
                }
            }
            .store(in: &cancellables)

        NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)
            .map { @Sendable _ in () }
            .sink { @Sendable in Task { @MainActor [weak self] in await self?.refresh() } }
            .store(in: &cancellables)

        // The Mac posts the same name when its Settings saves; on the phone
        // it is Settings on this device, and Home listens the same way.
        NotificationCenter.default.publisher(for: HomeLayoutCache.didChange)
            .compactMap { @Sendable in $0.object as? [HomeModuleSetting] }
            .sink { @Sendable layout in
                Task { @MainActor [weak self] in
                    guard let self, self.layout != layout else { return }
                    self.layout = layout
                }
            }
            .store(in: &cancellables)
    }

    func refresh() async {
        guard let app, let credentials = app.ownerCredentials else {
            // Signed out: nobody's layout. The default, not the last owner's.
            if layout != HomeLayout.defaults {
                layout = HomeLayout.defaults
                HomeLayoutCache.clear()
            }
            homeReady = false
            return
        }
        if let inFlight {
            await inFlight.value
            return
        }
        let task = Task { await load(credentials: credentials, api: app.api) }
        inFlight = task
        await task.value
        inFlight = nil
    }

    private func load(credentials: MobileOwnerCredentials, api: StarlingsAPI) async {
        do {
            let remote = try await api.homeLayout(credentials: credentials).layout
            if remote != layout || !HomeLayoutCache.isStored() {
                layout = remote
                HomeLayoutCache.store(remote)
            }
            errorMessage = nil
        } catch {
            // The cached order is still the right order to draw; a transient
            // failure must not reshuffle Home.
        }
        homeReady = true
    }

    /// Draw the new order now, then tell the Worker. On failure the old order
    /// comes back and the error is shown where the change was made.
    func save(_ next: [HomeModuleSetting]) async {
        guard let app, let credentials = app.ownerCredentials else { return }
        let resolved = HomeLayout.resolve(next)
        let previous = layout
        guard resolved != previous else { return }
        layout = resolved
        HomeLayoutCache.store(resolved)
        isSaving = true
        defer { isSaving = false }
        do {
            let saved = try await app.api.setHomeLayout(credentials: credentials, resolved).layout
            layout = saved
            HomeLayoutCache.store(saved)
            errorMessage = nil
        } catch {
            layout = previous
            HomeLayoutCache.store(previous)
            errorMessage = error.localizedDescription
        }
    }
}
