import AuthenticationServices
import Combine
import KeepKit
import KeepUI
import SwiftUI
import UIKit

/// The phone's half of `KeepAccess` (Sources/KeepAccess.swift): how it asks
/// the Worker for a token, and how it learns the owner signed out. Same
/// shape as Docs' glue in `MobileDocsAccess.swift`.
extension KeepAccess {
    func attach(to app: StarlingsAppModel) {
        guard broker == nil else { return }
        broker = { [weak app] in
            guard let app, let owner = app.ownerCredentials else {
                throw StarlingsError.local(String(localized: "Sign in to Starlings before connecting Keep."))
            }
            return try await app.api.keepToken(credentials: owner, deviceName: UIDevice.current.name)
        }
        // Keep comes with the Meet session: signing in links it, signing
        // out drops it. There is no Connect step in Settings.
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

/// Keep under Work: the vaults, pushed from the surface menu beside Core.
/// The passkey sheet anchors to the key window.
struct MobileKeepScreen: View {
    @EnvironmentObject private var keep: KeepAccess
    var landing: KeepLanding = .vaults

    var body: some View {
        KeepRootView(
            session: keep.session,
            landing: landing,
            connect: { [weak keep] in await keep?.link() },
            anchor: {
                let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
                return scenes.flatMap(\.windows).first { $0.isKeyWindow } ?? scenes.first?.windows.first ?? UIWindow()
            }
        )
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// Keep in the app's Settings: the ways the key unlocks, the same rows the
/// Keep screen's own settings show. The token has no row; it comes with the
/// Meet session.
struct MobileKeepSettingsSection: View {
    @EnvironmentObject private var keep: KeepAccess

    var body: some View {
        if keep.isLinked {
            KeepSettingsSections(session: keep.session, anchor: {
                let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
                return scenes.flatMap(\.windows).first { $0.isKeyWindow } ?? scenes.first?.windows.first ?? UIWindow()
            })
        }
    }
}
