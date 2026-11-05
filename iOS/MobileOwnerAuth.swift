import AuthenticationServices
import CryptoKit
import EnvisioningUI
import Foundation
import Security
import UIKit

/// The Keychain half `StarlingsAppModel` needs for the owner session.
/// `MobileOwnerSessionStore` is the one the app uses; tests pass a fake so the
/// renewal rule runs without the Keychain.
protocol MobileOwnerSessionKeychain {
    func load() throws -> MobileOwnerCredentials?
    func save(_ credentials: MobileOwnerCredentials) throws
    func clear() throws
    func deviceID() -> String
}

extension MobileOwnerSessionStore: MobileOwnerSessionKeychain {
    func load() throws -> MobileOwnerCredentials? {
        try load(environment: .configured())
    }

    func save(_ credentials: MobileOwnerCredentials) throws {
        try save(credentials, environment: .configured())
    }
}

struct MobileOwnerSessionStore {
    private let service = "\(ContractConstants.nativeAppBundleID).owner-session"

    /// One item per workspace: `owner@<webOrigin>`. The one item
    /// every workspace shared before (`google-owner`) is adopted once, by the
    /// workspace whose API minted it. The stamp is the API this build talks
    /// to, so the Debug development-server override never sends a session to
    /// a server that did not mint it.
    private func keychain(_ environment: StarlingsEnvironment, scope: WorkspaceScope = .active) -> WorkspaceCredentialKeychain<MobileOwnerCredentials> {
        WorkspaceCredentialKeychain(
            service: service,
            name: "owner",
            legacyAccounts: ["google-owner"],
            apiEndpoint: environment.apiBaseURL.absoluteString,
            scope: scope
        )
    }

    /// Another workspace's session, for a sign-out of every workspace
    /// (slice G): read so its Worker can be told, then cleared.
    func load(workspace: StarlingsWorkspace) throws -> MobileOwnerCredentials? {
        try keychain(Self.environment(for: workspace), scope: WorkspaceScope(workspace)).load()
    }

    func clear(workspace: StarlingsWorkspace) throws {
        do {
            try keychain(Self.environment(for: workspace), scope: WorkspaceScope(workspace)).clear()
        } catch is StarlingsKeychain.Failure {
            throw StarlingsError.local(String(localized: "The owner session couldn’t be removed from Keychain."))
        }
    }

    func deviceID(workspace: StarlingsWorkspace) -> String {
        StarlingsKeychain.deviceID(service: service, scope: WorkspaceScope(workspace))
    }

    static func environment(for workspace: StarlingsWorkspace) -> StarlingsEnvironment {
        StarlingsEnvironment(apiBaseURL: workspace.apiBaseURL, webOrigin: workspace.webOrigin)
    }

    func load(environment: StarlingsEnvironment = .configured()) throws -> MobileOwnerCredentials? {
        do {
            return try keychain(environment).load()
        } catch is StarlingsKeychain.Failure {
            throw StarlingsError.local(String(localized: "The owner session couldn’t be read from Keychain."))
        }
    }

    /// Readable and writable while the phone is locked, and never in a
    /// backup (`StarlingsKeychain.write`). The app keeps running behind the lock
    /// screen during a meeting (`audio` background mode), and a renewal that
    /// landed after the lock could not write its pair under the default
    /// `WhenUnlocked`: the Worker had rotated, the Keychain still held the
    /// spent token, and the next renewal was a sign-out. A restore onto
    /// another phone starts signed out instead of carrying 60 days of
    /// somebody's refresh token with it.
    func save(_ credentials: MobileOwnerCredentials, environment: StarlingsEnvironment = .configured()) throws {
        try save(credentials, into: keychain(environment))
    }

    /// Another workspace's session: the add flow signs in before it switches
    ///, so the pair goes to that workspace's scope.
    func save(_ credentials: MobileOwnerCredentials, workspace: StarlingsWorkspace) throws {
        try save(credentials, into: keychain(Self.environment(for: workspace), scope: WorkspaceScope(workspace)))
    }

    private func save(_ credentials: MobileOwnerCredentials, into keychain: WorkspaceCredentialKeychain<MobileOwnerCredentials>) throws {
        let stamped = MobileOwnerCredentials(
            accessToken: credentials.accessToken,
            refreshToken: credentials.refreshToken,
            owner: credentials.owner,
            apiEndpoint: keychain.apiEndpoint
        )
        do {
            try keychain.save(stamped)
        } catch is StarlingsKeychain.Failure {
            throw StarlingsError.local(String(localized: "The owner session couldn’t be saved to Keychain."))
        }
    }

    func clear() throws {
        do {
            try keychain(.configured()).clear()
        } catch is StarlingsKeychain.Failure {
            throw StarlingsError.local(String(localized: "The owner session couldn’t be removed from Keychain."))
        }
    }

    /// This phone's id for the workspace (`StarlingsKeychain.deviceID`). Kept
    /// across sign-outs: `clear()` removes the session, never this.
    func deviceID() -> String {
        StarlingsKeychain.deviceID(service: service, scope: .active)
    }
}

/// One claim on a continuation, for a callback that can arrive twice.
///
/// Main-actor isolated rather than locked, because both racers already resume
/// on the main actor: the completion handler hops there, and `start()` is
/// called there.
@MainActor
private final class SignInResume {
    private var isClaimed = false

    func claim() -> Bool {
        guard !isClaimed else { return false }
        isClaimed = true
        return true
    }
}

@MainActor
final class MobileGoogleAuthenticator: NSObject, ASWebAuthenticationPresentationContextProviding {
    enum Purpose {
        case owner
        case calendar
        case calendarAccount

        var scopes: String {
            switch self {
            case .owner:
                "openid email profile"
            case .calendar, .calendarAccount:
                [
                    "openid email profile",
                    "https://www.googleapis.com/auth/calendar.events",
                    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
                    // Free/busy: the booking page and Team availability.
                    "https://www.googleapis.com/auth/calendar.events.freebusy",
                ].joined(separator: " ")
            }
        }

        var restrictsToEnvisioningDomain: Bool {
            switch self {
            case .owner, .calendar: return true
            case .calendarAccount: return false
            }
        }
    }

    struct AuthorizationCode {
        let code: String
        let verifier: String
        let redirectURI: String
        let nonce: String
    }

    private var webAuthenticationSession: ASWebAuthenticationSession?

    func authorize(purpose: Purpose) async throws -> AuthorizationCode {
        let clientID = try configuredValue("MEET_GOOGLE_NATIVE_CLIENT_ID")
        let callbackScheme = try configuredValue("MEET_GOOGLE_REDIRECT_SCHEME")
        let redirectURI = "\(callbackScheme):/oauth/callback"
        let state = try secureToken(byteCount: 24)
        let nonce = try secureToken(byteCount: 24)
        let verifier = try secureToken(byteCount: 48)
        let challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64URLEncodedString()

        var components = URLComponents(string: "https://accounts.google.com/o/oauth2/v2/auth")!
        var items = [
            URLQueryItem(name: "client_id", value: clientID),
            URLQueryItem(name: "redirect_uri", value: redirectURI),
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "scope", value: purpose.scopes),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "nonce", value: nonce),
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
        ]
        if purpose.restrictsToEnvisioningDomain, let hint = EnvisioningIdentity.hostedDomainHint {
            items.append(URLQueryItem(name: "hd", value: hint))
        }
        switch purpose {
        case .calendar, .calendarAccount:
            items.append(contentsOf: [
                URLQueryItem(name: "access_type", value: "offline"),
                URLQueryItem(name: "include_granted_scopes", value: "true"),
                URLQueryItem(name: "prompt", value: "consent"),
            ])
        case .owner:
            items.append(URLQueryItem(name: "prompt", value: "select_account"))
        }
        components.queryItems = items
        guard let authorizationURL = components.url else {
            throw StarlingsError.local(String(localized: "Sign-in configuration is invalid."))
        }

        let callbackURL = try await open(url: authorizationURL, callbackScheme: callbackScheme)
        guard let callback = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false),
              callback.queryItems?.first(where: { $0.name == "state" })?.value == state,
              let code = callback.queryItems?.first(where: { $0.name == "code" })?.value else {
            throw StarlingsError.local(String(localized: "The sign-in service returned an invalid response."))
        }
        return AuthorizationCode(code: code, verifier: verifier, redirectURI: redirectURI, nonce: nonce)
    }

    /// Sign-in through the workspace's own web sign-in (slice D):
    /// open its native start and answer the single-use code its callback
    /// carries for this attempt.
    func authorizeThroughWorkspace(_ attempt: WorkspaceSignInAttempt) async throws -> String {
        guard let startURL = attempt.startURL else {
            throw StarlingsError.local(String(localized: "Sign-in configuration is invalid."))
        }
        let callbackURL: URL
        if #available(iOS 17.4, *) {
            callbackURL = try await open(url: startURL) { url, completion in
                ASWebAuthenticationSession(url: url, callback: attempt.sessionCallback, completionHandler: completion)
            }
        } else {
            callbackURL = try await open(url: startURL, callbackScheme: WorkspaceSignInAttempt.callbackScheme)
        }
        return try attempt.code(from: callbackURL)
    }

    /// Abandon whatever sign-in is in flight. The session's completion runs
    /// with `canceledLogin`, so the attempt that owned it ends the ordinary way.
    func cancel() {
        webAuthenticationSession?.cancel()
        webAuthenticationSession = nil
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        if let key = scenes.flatMap(\.windows).first(where: \.isKeyWindow) { return key }
        // No key window yet — sign-in can be the first thing that happens after
        // a cold launch. Anchor to a scene rather than a scene-less window:
        // `UIWindow()` is deprecated in iOS 26, and a window with no scene has
        // nowhere to present from anyway.
        if let scene = scenes.first(where: { $0.activationState == .foregroundActive }) ?? scenes.first {
            return ASPresentationAnchor(windowScene: scene)
        }
        return ASPresentationAnchor(frame: .zero)
    }

    private func open(url: URL, callbackScheme: String) async throws -> URL {
        try await open(url: url) { url, completion in
            ASWebAuthenticationSession(url: url, callbackURLScheme: callbackScheme, completionHandler: completion)
        }
    }

    /// One browser sign-in. `makeSession` builds the session for a callback
    /// scheme or, on iOS 17.4 and later, an https callback.
    private func open(
        url: URL,
        makeSession: (URL, @escaping @Sendable (URL?, (any Error)?) -> Void) -> ASWebAuthenticationSession
    ) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            // `start()` can return false *and* the completion handler can still
            // run for the same attempt — a refused presentation reports itself
            // both ways. Resuming a continuation twice is not an error the
            // runtime recovers from: it traps and takes the app down, which is
            // what a failed sign-in was doing on device. Whoever arrives first
            // answers; the other one has nothing left to say.
            let resume = SignInResume()
            let completion: @Sendable (URL?, (any Error)?) -> Void = { url, error in
                Task { @MainActor [weak self] in
                    self?.webAuthenticationSession = nil
                    guard resume.claim() else { return }
                    if let error {
                        continuation.resume(throwing: Self.userFacingAuthenticationError(error))
                    } else if let url {
                        continuation.resume(returning: url)
                    } else {
                        continuation.resume(throwing: StarlingsError.local(EnvisioningCopy.signInCancelled))
                    }
                }
            }
            let session = makeSession(url, completion)
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            webAuthenticationSession = session
            guard session.start() else {
                webAuthenticationSession = nil
                if resume.claim() {
                    continuation.resume(throwing: StarlingsError.local(String(localized: "Sign-in couldn’t start.")))
                }
                return
            }
        }
    }

    private static func userFacingAuthenticationError(_ error: Error) -> StarlingsError {
        if let webAuthError = error as? ASWebAuthenticationSessionError,
           webAuthError.code == .canceledLogin {
            return StarlingsError.local(EnvisioningCopy.signInCancelled)
        }
        return StarlingsError.local(EnvisioningCopy.signInFailed)
    }

    private func configuredValue(_ key: String) throws -> String {
        guard let value = Bundle.main.object(forInfoDictionaryKey: key) as? String,
              !value.isEmpty, !value.hasPrefix("replace-with-") else {
            throw StarlingsError.local(String(localized: "Sign-in needs the \(key) build setting."))
        }
        return value
    }

    private func secureToken(byteCount: Int) throws -> String {
        var bytes = [UInt8](repeating: 0, count: byteCount)
        let status = bytes.withUnsafeMutableBytes {
            SecRandomCopyBytes(kSecRandomDefault, $0.count, $0.baseAddress!)
        }
        guard status == errSecSuccess else {
            throw StarlingsError.local(String(localized: "Secure random data is unavailable."))
        }
        return Data(bytes).base64URLEncodedString()
    }
}

private extension Data {
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
