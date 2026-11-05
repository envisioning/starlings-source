import Combine
import DocsKit
import UIKit

/// The phone's half of `DocsSession` (Sources/DocsAccess.swift): how it
/// reads and renews the owner session Docs rides on, and how it
/// learns the owner signed out. Same shape as Core's glue in
/// `MobileCoreAccess.swift`.
extension DocsSession {
    func attach(to app: StarlingsAppModel) {
        guard broker == nil else { return }
        broker = { [weak app] in
            guard let app, app.ownerCredentials != nil else {
                throw StarlingsError.local(String(localized: "Sign in to Starlings before connecting Docs."))
            }
            await app.renewSessionIfNeeded()
            return app.ownerCredentials.map { DocsOwnerSession(accessToken: $0.accessToken, email: $0.owner.email) }
        }
        // Docs comes with the Starlings session: signing in links it,
        // signing out drops it. There is no Connect step in Settings.
        app.$ownerCredentials
            .map { $0 == nil }
            .removeDuplicates()
            .dropFirst()
            .sink { [weak self] signedOut in
                guard let self else { return }
                Task { @MainActor in
                    if signedOut { self.ownerSignedOut() } else { await self.ensureLinked() }
                }
            }
            .store(in: &cancellables)
        if app.ownerCredentials != nil { Task { await ensureLinked() } }
    }
}

extension DocsOwnerSession {
    /// The phone's stored owner session, as Docs needs it; nil when signed
    /// out or when the Keychain does not answer.
    init?(_ store: MobileOwnerSessionStore) {
        guard let stored = try? store.load(environment: .configured()) else { return nil }
        self.init(accessToken: stored.accessToken, email: stored.owner.email)
    }
}
