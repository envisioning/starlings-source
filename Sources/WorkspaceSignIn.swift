import AuthenticationServices
import CryptoKit
import EnvisioningUI
import Foundation
import Security

/// One native sign-in through a workspace's own web sign-in (slice D,
///; docs/CENTRAL_AUTH.md §Signing in through the auth host). The
/// Mac and the phone share it whole; each opens `startURL` in its own
/// `ASWebAuthenticationSession` and redeems the code through its own API.
///
/// The attempt lives in memory only. It names the workspace it started for,
/// and the code it returns is redeemed only there.
struct WorkspaceSignInAttempt: Sendable {
    let workspace: StarlingsWorkspace
    let state: String
    let verifier: String
    /// The https callback host when this attempt returns through it
    ///, else nil and the scheme.
    let httpsCallbackHost: String?

    /// The scheme `ASWebAuthenticationSession` waits for:
    /// `NATIVE_SIGN_IN_CALLBACK` up to its colon.
    static let callbackScheme: String = {
        let callback = ContractConstants.nativeSignInCallback
        return String(callback[..<(callback.firstIndex(of: ":") ?? callback.endIndex)])
    }()

    enum Failure: LocalizedError, Equatable {
        case randomnessUnavailable
        case invalidCallback
        case cancelled
        /// The active workspace changed while this attempt was in the browser.
        case workspaceChanged
        /// The workspace refused the account (403 at redeem): it is not a
        /// member there.
        case notInvited

        var errorDescription: String? {
            switch self {
            case .randomnessUnavailable: String(localized: "Secure random data is unavailable.")
            case .invalidCallback: String(localized: "The sign-in returned an invalid response.")
            case .cancelled: EnvisioningCopy.signInCancelled
            case .workspaceChanged: String(localized: "The workspace changed during sign-in. Sign in again.")
            case .notInvited: String(localized: "This account isn’t invited to that workspace.")
            }
        }
    }

    /// `httpsCallback`: return through `https://<host>/auth/native/callback`
    /// when the workspace host is one the app's associated domains cover
    /// (`*.<suffix>`). Only the signed app can claim that
    /// address; any app can register the scheme. The caller passes true only
    /// where `ASWebAuthenticationSession.Callback.https` exists and the build
    /// carries the entitlement.
    init(workspace: StarlingsWorkspace, httpsCallback: Bool = false) throws {
        self.workspace = workspace
        state = try Self.randomToken(byteCount: 24)
        verifier = try Self.randomToken(byteCount: 32)
        httpsCallbackHost = httpsCallback ? Self.associatedHost(of: workspace) : nil
    }

    /// The workspace's host when it is a `*.<suffix>` host over https.
    static func associatedHost(of workspace: StarlingsWorkspace) -> String? {
        guard let url = URL(string: workspace.webOrigin), url.scheme == "https",
              let host = url.host?.lowercased(),
              host.hasSuffix(".\(ContractConstants.workspaceHostSuffix)")
        else { return nil }
        return host
    }

    /// The callback value the start names: the scheme, or this host's https callback.
    var callbackValue: String {
        guard let host = httpsCallbackHost else { return ContractConstants.nativeSignInCallback }
        return "https://\(host)\(ContractConstants.nativeSignInHTTPSPath)"
    }

    /// What `ASWebAuthenticationSession` waits for.
    @available(macOS 14.4, iOS 17.4, *)
    var sessionCallback: ASWebAuthenticationSession.Callback {
        if let host = httpsCallbackHost {
            return .https(host: host, path: ContractConstants.nativeSignInHTTPSPath)
        }
        return .customScheme(Self.callbackScheme)
    }

    /// S256 of the verifier: 43 base64url characters.
    var challenge: String {
        Data(SHA256.hash(data: Data(verifier.utf8))).base64URLEncodedStringWithoutPadding()
    }

    /// `<web_origin>/api/auth/native/start?code_challenge=…&state=…&callback=…`.
    /// The callback names this app's scheme, or this host's https
    /// callback; the workspace sends the code back there and
    /// nowhere else.
    var startURL: URL? {
        guard var components = URLComponents(string: workspace.webOrigin) else { return nil }
        components.path = ContractConstants.nativeSignInStartPath
        components.queryItems = [
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "callback", value: callbackValue),
        ]
        return components.url
    }

    /// The single-use code the callback carries. Accepted only for this
    /// attempt's `state`; `error=cancelled` is the person backing out.
    func code(from callback: URL) throws -> String {
        guard let components = URLComponents(url: callback, resolvingAgainstBaseURL: false),
              returnsHere(components),
              let items = components.queryItems,
              items.first(where: { $0.name == "state" })?.value == state
        else { throw Failure.invalidCallback }
        if items.first(where: { $0.name == "error" }) != nil { throw Failure.cancelled }
        guard let code = items.first(where: { $0.name == "code" })?.value, !code.isEmpty else {
            throw Failure.invalidCallback
        }
        return code
    }

    /// True when the callback is the one this attempt named.
    private func returnsHere(_ components: URLComponents) -> Bool {
        guard let host = httpsCallbackHost else { return components.scheme == Self.callbackScheme }
        return components.scheme == "https" && components.host?.lowercased() == host
            && components.path == ContractConstants.nativeSignInHTTPSPath
    }

    /// The redeem body. Throws when the active workspace is no longer the one
    /// this attempt started for: the code is redeemed only where it was issued.
    /// The add flow signs in before it switches and redeems at
    /// `workspace.apiBaseURL` itself, so it passes `requireActive: false`.
    func redeemRequest(code: String, client: NativeClient, deviceID: String, deviceName: String, requireActive: Bool = true) throws -> NativeSignInRedeemRequest {
        if requireActive, StarlingsWorkspace.active.webOrigin != workspace.webOrigin { throw Failure.workspaceChanged }
        return NativeSignInRedeemRequest(
            code: code,
            codeVerifier: verifier,
            client: client,
            deviceID: deviceID,
            deviceName: deviceName
        )
    }

    private static func randomToken(byteCount: Int) throws -> String {
        var bytes = [UInt8](repeating: 0, count: byteCount)
        let status = bytes.withUnsafeMutableBytes { buffer in
            SecRandomCopyBytes(kSecRandomDefault, buffer.count, buffer.baseAddress!)
        }
        guard status == errSecSuccess else { throw Failure.randomnessUnavailable }
        return Data(bytes).base64URLEncodedStringWithoutPadding()
    }
}

private extension Data {
    func base64URLEncodedStringWithoutPadding() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

/// What a finished sign-in attempt that did not sign anyone in means to the
/// person. Cancelling the browser sheet is a choice, not a failure:
/// the screen stays calm. Everything else is said in plain words, and the
/// system's own text goes behind Copy.
enum SignInOutcome {
    static func isCancel(_ error: Error) -> Bool {
        if let web = error as? ASWebAuthenticationSessionError, web.code == .canceledLogin { return true }
        if error is CancellationError { return true }
        if let failure = error as? WorkspaceSignInAttempt.Failure, failure == .cancelled { return true }
        return (error as? LocalizedError)?.errorDescription == EnvisioningCopy.signInCancelled
    }

    /// Plain words for a real failure. An error that already speaks plainly
    /// (ours) keeps its own text; a system error is replaced by a sentence and
    /// its description goes in `detail`.
    static func plainMessage(for error: Error) -> (text: String, detail: String?) {
        if error is URLError {
            return (String(localized: "Couldn’t reach the sign-in service. Check your connection and try again."), error.localizedDescription)
        }
        if error is ASWebAuthenticationSessionError {
            return (EnvisioningCopy.signInFailed, error.localizedDescription)
        }
        return (error.localizedDescription, nil)
    }
}
