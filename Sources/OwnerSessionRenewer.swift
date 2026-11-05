import AppKit
import Foundation

/// The Keychain half the renewer needs. `OwnerSessionStore` is the one the
/// app uses; tests pass a fake so the renewal rule runs without the Keychain
///.
protocol OwnerSessionKeychain: Sendable {
    func load() throws -> OwnerSessionCredentials?
    func save(_ credentials: OwnerSessionCredentials) throws
    func expire() throws
    func deviceID() -> String
}

extension OwnerSessionStore: OwnerSessionKeychain {}

/// Keeps the Mac signed in without asking for Google again.
///
/// The access token lasts 8h, and until now nothing on the Mac renewed it, so
/// daily use meant a Google sign-in most mornings — and, because refresh tokens
/// rotated per person, each of those sign-ins signed the phone out. This
/// spends the refresh token instead: on launch, on wake, on becoming active,
/// on a timer an hour before expiry, and the moment the API layer is told the
/// token is dead. One renewal at a time, whoever asks: two callers spending
/// the same single-use token would refuse the second and sign somebody out
/// for nothing.
///
/// Two kinds of failure, told apart on purpose. Offline or a Worker that is
/// down leaves the session in place — the token may still have hours left. A
/// refusal (401 or 403) is the Worker saying this token will never work again;
/// only that, or having no refresh token at all, expires the Keychain session.
actor OwnerSessionRenewer {
    static let shared = OwnerSessionRenewer()

    enum Outcome: Equatable, Sendable {
        /// A fresh pair is in the Keychain.
        case renewed
        /// Nothing to do yet: more than an hour left on the access token.
        case stillValid
        /// No session, or a session with no refresh token (pre-renewal build,
        /// or a Debug dev session).
        case nothingToRenew
        /// The Worker refused: expired, spent, revoked or off-domain.
        case refused
        /// Offline, or the Worker did not answer usefully. Try again later.
        case unavailable
    }

    private let store: any OwnerSessionKeychain
    private let session: URLSession
    /// Nil follows the active workspace, read per request.
    private let fixedAPIBaseURL: URL?
    private var apiBaseURL: URL { fixedAPIBaseURL ?? HTTPConnectionDetailsProvider.configuredAPIBase }
    private var inFlight: Task<Outcome, Never>?
    private var rejection: Task<Outcome, Never>?
    /// Fires an hour before the access token expires. A Mac that stays awake
    /// and active in Meet all day never posts wake or activate, and without
    /// this the first request past 8h was a 401 and a "Sign in again".
    private var scheduled: Task<Void, Never>?

    init(
        store: any OwnerSessionKeychain = OwnerSessionStore(),
        session: URLSession = .shared,
        apiBaseURL: URL? = nil
    ) {
        self.store = store
        self.session = session
        self.fixedAPIBaseURL = apiBaseURL
    }

    /// Renew at the moments a laptop comes back to life. The observers live as
    /// long as the process, which is as long as the shared renewer does.
    nonisolated func startObserving() {
        _ = NotificationCenter.default.addObserver(
            forName: NSApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { _ in Task { await OwnerSessionRenewer.shared.renewIfNeeded() } }
        _ = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification,
            object: nil,
            queue: .main
        ) { _ in Task { await OwnerSessionRenewer.shared.renewIfNeeded() } }
        Task { await renewIfNeeded() }
    }

    @discardableResult
    func renewIfNeeded(force: Bool = false) async -> Outcome {
        if let inFlight { return await inFlight.value }
        // A Keychain that will not answer (locked just after wake, a denied
        // prompt) is not an empty Keychain. Treating it as one made
        // `sessionRejected` expire a session that was still there.
        let stored: OwnerSessionCredentials?
        do {
            stored = try store.load()
        } catch {
            return .unavailable
        }
        guard let credentials = stored else { return .nothingToRenew }
        guard let refreshToken = credentials.refreshToken else {
            scheduleRenewal(for: credentials.accessToken)
            return .nothingToRenew
        }
        guard force || Self.expiresSoon(credentials.accessToken) else {
            scheduleRenewal(for: credentials.accessToken)
            return .stillValid
        }
        let task = Task { await renew(refreshToken: refreshToken) }
        inFlight = task
        let outcome = await task.value
        if inFlight == task { inFlight = nil }
        if let renewed = try? store.load() { scheduleRenewal(for: renewed.accessToken) }
        return outcome
    }

    /// The API layer got `owner_auth_required` for the stored token. Renew if
    /// the refresh token still can; otherwise expire the session so every
    /// surface stops drawing a member off a Keychain item the Worker no longer
    /// honours. Coalesced: a burst of failing polls is one renewal, one answer.
    /// Returns what happened so the caller can retry its request on
    /// `.renewed` instead of showing "Sign in again" for a session that is
    /// fine.
    @discardableResult
    func sessionRejected() async -> Outcome {
        if let rejection { return await rejection.value }
        let task = Task { () -> Outcome in
            let outcome = await renewIfNeeded(force: true)
            switch outcome {
            case .renewed, .stillValid, .unavailable:
                // Renewed, or the Worker could not be asked — the next request
                // will say which. Neither is a reason to sign anybody out.
                break
            case .nothingToRenew, .refused:
                try? store.expire()
            }
            return outcome
        }
        rejection = task
        let outcome = await task.value
        rejection = nil
        return outcome
    }

    /// Arm the timer for an hour before `accessToken` expires. Re-armed after
    /// every renewal and every look at the store, so a fresh sign-in is picked
    /// up by the activate that follows Google's window closing.
    private func scheduleRenewal(for accessToken: String) {
        scheduled?.cancel()
        guard let expiry = Self.expiry(of: accessToken) else { return }
        let delay = expiry.timeIntervalSinceNow - 3_600
        guard delay > 0 else { return }
        scheduled = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            await self?.renewIfNeeded()
        }
    }

    private func renew(refreshToken: String) async -> Outcome {
        // Built through the shared route and sent once, here: the refresh
        // token is single use, so the transport's retry never sees it.
        let route = StarlingsSettingsRoutes.refresh(SessionRefreshRequest(
            refreshToken: refreshToken,
            client: .mac,
            deviceID: store.deviceID(),
            deviceName: OwnerSessionStore.deviceName
        ))
        guard let request = try? StarlingsHTTPTransport(baseURL: apiBaseURL, session: session, webOrigin: "")
            .request(route, bearer: nil, timeout: 15) else { return .unavailable }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            return .unavailable
        }
        guard let http = response as? HTTPURLResponse else { return .unavailable }
        StarlingsHTTPTransport.observeUpgradeRecommendation(for: request, response: http)
        switch http.statusCode {
        case 200..<300:
            // Save before anything reads it: the token just spent is refused
            // from now on, so a pair that never reached the Keychain is lost.
            guard let renewed = (try? JSONDecoder().decode(OwnerSessionResponse.self, from: data)).map(OwnerSessionCredentials.init(wire:)),
                  (try? store.save(renewed)) != nil else { return .unavailable }
            return .renewed
        case 401, 403:
            return .refused
        default:
            return .unavailable
        }
    }

    /// True within an hour of expiry, or if the token cannot be read.
    ///
    /// Reads `exp` out of the JWT payload rather than tracking issue time: the
    /// Worker owns the lifetime, and a client that assumed 8h would renew at
    /// the wrong moment the day that changes.
    static func expiresSoon(_ accessToken: String, now: Date = Date()) -> Bool {
        OwnerAccessToken.expiresSoon(accessToken, now: now)
    }

    /// `exp` out of the JWT payload, or nil when the token cannot be read.
    static func expiry(of accessToken: String) -> Date? {
        OwnerAccessToken.expiry(of: accessToken)
    }
}
