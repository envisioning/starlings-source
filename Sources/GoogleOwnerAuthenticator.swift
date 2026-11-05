import AppKit
import AuthenticationServices
import CryptoKit
import Foundation
import Security

@MainActor
final class GoogleOwnerAuthenticator: NSObject, ASWebAuthenticationPresentationContextProviding {
    private let store: OwnerSessionStore
    private let session: URLSession
    private var presentationAnchor: ASPresentationAnchor?
    private var webAuthenticationSession: ASWebAuthenticationSession?
    /// Set while the add flow signs in: a 403 there reads as
    /// "not invited". Other sign-ins keep the Worker's own sentence.
    private var refusalMeansNotInvited = false

    init(store: OwnerSessionStore = OwnerSessionStore(), session: URLSession = .shared) {
        self.store = store
        self.session = session
    }

    func authenticate(in window: NSWindow) async throws -> OwnerSessionCredentials {
        try await authenticate(StarlingsWorkspace.active, in: window, requireActive: true)
    }

    /// Signs in to `workspace` and saves the pair in this authenticator's
    /// store. Add a workspace runs it before the switch, with a
    /// store fixed to that workspace's scope and `requireActive: false`.
    func authenticate(_ workspace: StarlingsWorkspace, in window: NSWindow, requireActive: Bool) async throws -> OwnerSessionCredentials {
        refusalMeansNotInvited = !requireActive
        defer { refusalMeansNotInvited = false }
        if workspace.signsInThroughWorkspace {
            return try await authenticateThroughWorkspace(workspace, in: window, requireActive: requireActive)
        }
        let clientID = try configuredValue("MEET_GOOGLE_NATIVE_CLIENT_ID")
        let callbackScheme = try configuredValue("MEET_GOOGLE_REDIRECT_SCHEME")
        let redirectURI = "\(callbackScheme):/oauth/callback"
        let state = try secureToken(byteCount: 24)
        let nonce = try secureToken(byteCount: 24)
        let verifier = try secureToken(byteCount: 48)
        let challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64URLEncodedString()

        var components = URLComponents(string: "https://accounts.google.com/o/oauth2/v2/auth")!
        components.queryItems = [
            URLQueryItem(name: "client_id", value: clientID),
            URLQueryItem(name: "redirect_uri", value: redirectURI),
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "scope", value: "openid email profile"),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "nonce", value: nonce),
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "prompt", value: "select_account"),
        ]
        // A workspace with no hint shows every account.
        if let hint = EnvisioningIdentity.hostedDomainHint {
            components.queryItems?.append(URLQueryItem(name: "hd", value: hint))
        }
        guard let authorizationURL = components.url else { throw GoogleOwnerAuthError.invalidConfiguration }
        presentationAnchor = window
        let callbackURL = try await authorize(url: authorizationURL, callbackScheme: callbackScheme)
        guard let callback = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false),
              callback.queryItems?.first(where: { $0.name == "state" })?.value == state,
              let code = callback.queryItems?.first(where: { $0.name == "code" })?.value else {
            throw GoogleOwnerAuthError.invalidCallback
        }
        let credentials = try await exchange(
            code: code,
            verifier: verifier,
            redirectURI: redirectURI,
            nonce: nonce,
            apiBase: workspace.apiBaseURL
        )
        try store.save(credentials)
        return credentials
    }

    /// Sign-in through the workspace's own web sign-in (slice D):
    /// open its native start, take the single-use code from the callback,
    /// and redeem it with the verifier at the same workspace.
    private func authenticateThroughWorkspace(_ workspace: StarlingsWorkspace, in window: NSWindow, requireActive: Bool) async throws -> OwnerSessionCredentials {
        let attempt = try WorkspaceSignInAttempt(workspace: workspace)
        guard let startURL = attempt.startURL else { throw GoogleOwnerAuthError.invalidConfiguration }
        presentationAnchor = window
        let callbackURL = try await authorize(url: startURL, callbackScheme: WorkspaceSignInAttempt.callbackScheme)
        let code = try attempt.code(from: callbackURL)
        let body = try attempt.redeemRequest(
            code: code,
            client: .mac,
            deviceID: store.deviceID(),
            deviceName: OwnerSessionStore.deviceName,
            requireActive: requireActive
        )
        let endpoint = workspace.apiBaseURL
            .appending(path: "auth")
            .appending(path: "native")
            .appending(path: "redeem")
        let credentials = try await send(body, to: endpoint, method: "POST")
        // The redeem took a round trip: save only if the workspace is still the one signed in to.
        if requireActive, StarlingsWorkspace.active.webOrigin != workspace.webOrigin {
            throw WorkspaceSignInAttempt.Failure.workspaceChanged
        }
        try store.save(credentials)
        return credentials
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        presentationAnchor ?? NSApp.keyWindow ?? ASPresentationAnchor()
    }

    private func authorize(url: URL, callbackScheme: String) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            // ASWebAuthenticationSession invokes its completion on a background XPC
            // queue (SafariLaunchAgent). A literal closure here would inherit @MainActor
            // from this type and trap with _dispatch_assert_queue_fail at entry.
            let completionHandler: @Sendable (URL?, (any Error)?) -> Void = { url, error in
                Task { @MainActor [weak self] in
                    self?.webAuthenticationSession = nil
                    if let error {
                        continuation.resume(throwing: error)
                    } else if let url {
                        continuation.resume(returning: url)
                    } else {
                        continuation.resume(throwing: GoogleOwnerAuthError.invalidCallback)
                    }
                }
            }
            let session = ASWebAuthenticationSession(
                url: url,
                callbackURLScheme: callbackScheme,
                completionHandler: completionHandler
            )
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            webAuthenticationSession = session
            guard session.start() else {
                webAuthenticationSession = nil
                continuation.resume(throwing: GoogleOwnerAuthError.couldNotStart)
                return
            }
        }
    }

    private func exchange(code: String, verifier: String, redirectURI: String, nonce: String, apiBase: URL) async throws -> OwnerSessionCredentials {
        let endpoint = apiBase
            .appending(path: "auth")
            .appending(path: "native")
            .appending(path: "exchange")
        return try await send(NativeExchangeRequest(
            code: code,
            codeVerifier: verifier,
            redirectURI: redirectURI,
            nonce: nonce,
            client: .mac,
            deviceID: store.deviceID(),
            deviceName: OwnerSessionStore.deviceName
        ), to: endpoint, method: "POST")
    }

    /// Sends a sign-in body and reads the session pair the Worker answers.
    private func send(_ body: some Encodable, to endpoint: URL, method: String) async throws -> OwnerSessionCredentials {
        var request = URLRequest(url: endpoint)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        StarlingsClientVersion.apply(to: &request)
        request.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw GoogleOwnerAuthError.exchangeRejected(nil)
        }
        StarlingsHTTPTransport.observeUpgradeRecommendation(for: request, response: http)
        // 403 is the workspace refusing this account (native-sign-in.ts):
        // Add a workspace says so in its own words.
        if http.statusCode == 403, refusalMeansNotInvited {
            throw WorkspaceSignInAttempt.Failure.notInvited
        }
        guard (200..<300).contains(http.statusCode) else {
            if let message = (try? JSONDecoder().decode(ControlErrorBody.self, from: data))?.error
                .trimmingCharacters(in: .whitespacesAndNewlines),
               !message.isEmpty {
                throw GoogleOwnerAuthError.exchangeRejected(message)
            }
            throw GoogleOwnerAuthError.exchangeRejected(nil)
        }
        return OwnerSessionCredentials(wire: try JSONDecoder().decode(OwnerSessionResponse.self, from: data))
    }

    private func configuredValue(_ key: String) throws -> String {
        guard let value = Bundle.main.object(forInfoDictionaryKey: key) as? String,
              !value.isEmpty, !value.hasPrefix("replace-with-") else {
            throw GoogleOwnerAuthError.missingConfiguration(key)
        }
        return value
    }

    private func secureToken(byteCount: Int) throws -> String {
        var bytes = [UInt8](repeating: 0, count: byteCount)
        let status = bytes.withUnsafeMutableBytes { buffer in
            SecRandomCopyBytes(kSecRandomDefault, buffer.count, buffer.baseAddress!)
        }
        guard status == errSecSuccess else {
            throw GoogleOwnerAuthError.randomnessUnavailable
        }
        return Data(bytes).base64URLEncodedString()
    }
}

private enum GoogleOwnerAuthError: LocalizedError {
    case invalidConfiguration
    case missingConfiguration(String)
    case invalidCallback
    case couldNotStart
    case exchangeRejected(String?)
    case randomnessUnavailable

    var errorDescription: String? {
        switch self {
        case .invalidConfiguration: String(localized: "Google sign-in configuration is invalid.")
        case .missingConfiguration(let key): String(localized: "Google sign-in needs the \(key) build setting.")
        case .invalidCallback: String(localized: "Google returned an invalid sign-in response.")
        case .couldNotStart: String(localized: "The secure Google sign-in window couldn’t start.")
        case .exchangeRejected(let detail):
            detail ?? String(localized: "The meeting service rejected the Google sign-in response.")
        case .randomnessUnavailable: String(localized: "Secure random data is unavailable.")
        }
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
