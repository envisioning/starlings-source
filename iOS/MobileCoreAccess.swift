import Combine
import CoreKit
import UIKit

/// The phone's half of `CoreSession` (Sources/CoreAccess.swift): how it asks
/// the Worker for a token, and how it learns the owner signed out.

extension CoreSession {
    func attach(to app: StarlingsAppModel) {
        guard broker == nil else { return }
        broker = { [weak app] in
            guard let app, let owner = app.ownerCredentials else {
                throw StarlingsError.local(String(localized: "Sign in to Starlings before connecting records."))
            }
            return try await app.api.coreToken(credentials: owner, deviceName: UIDevice.current.name)
        }
        app.$ownerCredentials
            .map { $0 == nil }
            .removeDuplicates()
            .dropFirst()
            .sink { [weak self] signedOut in
                guard signedOut, let self else { return }
                Task { await self.ownerSignedOut() }
            }
            .store(in: &cancellables)
        Task {
            await loadContracts()
            await refreshIfNeeded()
        }
    }
}
