import Combine
import Foundation
import UIKit

/// The language the interface is drawn in, on this phone: the owner-synced
/// choice, cached locally so the next launch knows it and
/// replaced by the Worker's answer on sign-in and every foreground. Settings
/// writes through `save`.
@MainActor
final class MobileLanguageStore: ObservableObject {
    @Published private(set) var language: StarlingsLanguage? = StarlingsLanguageCache.load()
    @Published private(set) var isSaving = false
    @Published private(set) var errorMessage: String?

    private weak var app: StarlingsAppModel?
    private var attached = false
    private var cancellables: Set<AnyCancellable> = []

    func attach(to app: StarlingsAppModel) {
        guard !attached else { return }
        attached = true
        self.app = app

        app.$ownerCredentials
            .map { @Sendable in $0?.owner.email }
            .removeDuplicates()
            .sink { @Sendable _ in
                Task { @MainActor [weak self] in await self?.refresh() }
            }
            .store(in: &cancellables)

        NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)
            .map { @Sendable _ in () }
            .sink { @Sendable in Task { @MainActor [weak self] in await self?.refresh() } }
            .store(in: &cancellables)
    }

    func refresh() async {
        guard let app, let credentials = app.ownerCredentials else {
            // Signed out: nobody's choice. The device, not the last owner's.
            if language != nil {
                language = nil
                StarlingsLanguageCache.clear()
            }
            return
        }
        do {
            let remote = try await app.api.language(credentials: credentials).preferred
            if remote != language {
                language = remote
                StarlingsLanguageCache.store(remote)
            }
            errorMessage = nil
        } catch {
            // The cached choice is still the right one; a transient failure
            // must not flip the row.
        }
    }

    /// Show the choice now, then tell the Worker. On failure the old choice
    /// comes back and the error is shown where the change was made.
    func save(_ next: StarlingsLanguage?) async {
        guard let app, let credentials = app.ownerCredentials else { return }
        let previous = language
        guard next != previous else { return }
        language = next
        StarlingsLanguageCache.store(next)
        isSaving = true
        defer { isSaving = false }
        do {
            let saved = try await app.api.setLanguage(credentials: credentials, next).preferred
            language = saved
            StarlingsLanguageCache.store(saved)
            errorMessage = nil
        } catch {
            language = previous
            StarlingsLanguageCache.store(previous)
            errorMessage = error.localizedDescription
        }
    }
}
