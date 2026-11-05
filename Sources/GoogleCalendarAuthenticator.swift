import AppKit
import AuthenticationServices
import CryptoKit
import Foundation
import Security

/// Incremental Google OAuth for Calendar — separate from host identity sign-in.
@MainActor
final class GoogleCalendarAuthenticator: NSObject, ASWebAuthenticationPresentationContextProviding {
    private let session: URLSession
    private var presentationAnchor: ASPresentationAnchor?
    private var webAuthenticationSession: ASWebAuthenticationSession?

    static let calendarScope = [
        "https://www.googleapis.com/auth/calendar.events",
        "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
        // Free/busy: the booking page and Team availability.
        "https://www.googleapis.com/auth/calendar.events.freebusy",
    ].joined(separator: " ")

    init(session: URLSession = .shared) {
        self.session = session
    }

    /// Attach another Google account for its calendars — a personal Gmail, a
    /// second workspace.
    ///
    /// Same dance as `connect`, minus the `hd` restriction: a personal address
    /// has no hosted domain, so pinning one would shut out exactly the accounts
    /// this exists for. The code goes to the accounts endpoint, which files it as
    /// a calendar source. Nothing here can change who is signed in — host
    /// identity is still Envisioning-only, and that check lives on the server.
    func connectAdditionalAccount(
        in window: NSWindow,
        controlAPI: MeetingControlAPI
    ) async throws -> CalendarAccountResponse {
        let flow = try await authorizeCalendarAccess(in: window, restrictToEnvisioning: false)
        return try await controlAPI.exchangeCalendarAccountConnect(
            code: flow.code,
            codeVerifier: flow.verifier,
            redirectURI: flow.redirectURI,
            nonce: flow.nonce
        )
    }

    func connect(in window: NSWindow, controlAPI: MeetingControlAPI) async throws -> CalendarConnectionStatus {
        let flow = try await authorizeCalendarAccess(in: window, restrictToEnvisioning: true)
        return try await controlAPI.exchangeCalendarConnect(
            code: flow.code,
            codeVerifier: flow.verifier,
            redirectURI: flow.redirectURI,
            nonce: flow.nonce
        )
    }

    private struct CalendarAuthorization {
        let code: String
        let verifier: String
        let redirectURI: String
        let nonce: String
    }

    private func authorizeCalendarAccess(
        in window: NSWindow,
        restrictToEnvisioning: Bool
    ) async throws -> CalendarAuthorization {
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
            URLQueryItem(name: "scope", value: "openid email profile \(Self.calendarScope)"),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "nonce", value: nonce),
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "access_type", value: "offline"),
            URLQueryItem(name: "include_granted_scopes", value: "true"),
            // Adding a second account means choosing which one, so the picker has
            // to be shown rather than the last session reused.
            URLQueryItem(name: "prompt", value: restrictToEnvisioning ? "consent" : "select_account consent"),
        ]
        // Only when this is the owner's own account, and only as a filter —
        // `hd` narrows the picker to Envisioning accounts and the Worker
        // decides. Absent entirely for the others: any `hd` at all excludes a
        // plain @gmail.com, which is exactly the kind of account that flow
        // exists to attach.
        if restrictToEnvisioning, let hint = EnvisioningIdentity.hostedDomainHint {
            components.queryItems?.append(URLQueryItem(name: "hd", value: hint))
        }
        guard let authorizationURL = components.url else { throw GoogleCalendarAuthError.invalidConfiguration }
        presentationAnchor = window
        let callbackURL = try await authorize(url: authorizationURL, callbackScheme: callbackScheme)
        guard let callback = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false),
              callback.queryItems?.first(where: { $0.name == "state" })?.value == state,
              let code = callback.queryItems?.first(where: { $0.name == "code" })?.value else {
            throw GoogleCalendarAuthError.invalidCallback
        }
        return CalendarAuthorization(code: code, verifier: verifier, redirectURI: redirectURI, nonce: nonce)
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        presentationAnchor ?? NSApp.keyWindow ?? ASPresentationAnchor()
    }

    private func authorize(url: URL, callbackScheme: String) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let completionHandler: @Sendable (URL?, (any Error)?) -> Void = { url, error in
                Task { @MainActor [weak self] in
                    self?.webAuthenticationSession = nil
                    if let error {
                        continuation.resume(throwing: error)
                    } else if let url {
                        continuation.resume(returning: url)
                    } else {
                        continuation.resume(throwing: GoogleCalendarAuthError.invalidCallback)
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
                continuation.resume(throwing: GoogleCalendarAuthError.couldNotStart)
                return
            }
        }
    }

    private func configuredValue(_ key: String) throws -> String {
        guard let value = Bundle.main.object(forInfoDictionaryKey: key) as? String,
              !value.isEmpty, !value.hasPrefix("replace-with-") else {
            throw GoogleCalendarAuthError.missingConfiguration(key)
        }
        return value
    }

    private func secureToken(byteCount: Int) throws -> String {
        var bytes = [UInt8](repeating: 0, count: byteCount)
        let status = bytes.withUnsafeMutableBytes { buffer in
            SecRandomCopyBytes(kSecRandomDefault, buffer.count, buffer.baseAddress!)
        }
        guard status == errSecSuccess else {
            throw GoogleCalendarAuthError.randomnessUnavailable
        }
        return Data(bytes).base64URLEncodedString()
    }
}

private enum GoogleCalendarAuthError: LocalizedError {
    case invalidConfiguration
    case missingConfiguration(String)
    case invalidCallback
    case couldNotStart
    case randomnessUnavailable

    var errorDescription: String? {
        switch self {
        case .invalidConfiguration: String(localized: "Google Calendar configuration is invalid.")
        case .missingConfiguration(let key): String(localized: "Google Calendar needs the \(key) build setting.")
        case .invalidCallback: String(localized: "Google returned an invalid Calendar response.")
        case .couldNotStart: String(localized: "The secure Google Calendar window couldn’t start.")
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
