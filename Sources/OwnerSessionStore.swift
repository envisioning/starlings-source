import Foundation
import Security

struct OwnerProfile: Codable, Equatable, Sendable {
    let sub: String
    let email: String
    let name: String
    let picture: String?

    init(sub: String, email: String, name: String, picture: String?) {
        self.sub = sub
        self.email = email
        self.name = name
        self.picture = picture
    }

    init(wire: OwnerSessionResponseOwner) {
        self.init(sub: wire.sub, email: wire.email, name: wire.name, picture: wire.picture)
    }
}

struct OwnerSessionCredentials: WorkspaceStampedCredential, Equatable {
    let accessToken: String
    /// Renews the 8h access token without another Google sign-in. Optional
    /// because a session stored by a build that predates renewal has none, and
    /// so does a Debug dev session: that owner signs in once more and then
    /// stops being asked. Single use — the Worker records which token is
    /// current for this device and refuses the rest — so it is replaced, never
    /// kept, after a renewal.
    let refreshToken: String?
    let owner: OwnerProfile
    /// API base that minted this JWT (the workspace's `<apiOrigin>/api`). Each endpoint now
    /// has its own Keychain item; the stamp remains so a pre-split item can be
    /// claimed by the build it belongs to and by nobody else.
    let apiEndpoint: String?

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case refreshToken = "refresh_token"
        case owner
        case apiEndpoint = "api_endpoint"
    }

    init(accessToken: String, refreshToken: String? = nil, owner: OwnerProfile, apiEndpoint: String? = nil) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.owner = owner
        self.apiEndpoint = apiEndpoint
    }

    /// What a sign-in or a renewal answers (`OwnerSessionResponse`), as the
    /// Keychain keeps it. Codable above is the Keychain's format, not the wire.
    init(wire: OwnerSessionResponse) {
        self.init(accessToken: wire.accessToken, refreshToken: wire.refreshToken, owner: OwnerProfile(wire: wire.owner))
    }
}

struct OwnerSessionStore: Sendable {
    /// Posted on the main queue after the API layer drops a session the server
    /// no longer honours. Every surface that reads the Keychain to decide what
    /// it is looking at — launch surface, menu bar, Settings, Work — redraws on
    /// it. Manual sign-out does not post this: it already has a caller who
    /// knows, and the two paths must not both drop the window to onboarding.
    static let didExpireNotification = Notification.Name("MeetOwnerSessionDidExpire")

    private let service: String
    /// Nil follows the active workspace, read per call.
    private let fixedScope: WorkspaceScope?

    init(keychainService: String = "\(ContractConstants.nativeAppBundleID).owner-session", scope: WorkspaceScope? = nil) {
        service = keychainService
        fixedScope = scope
    }

    private var scope: WorkspaceScope { fixedScope ?? .active }

    /// One item per workspace: `owner@<webOrigin>`. Before the
    /// scope, one item per API endpoint (`google-owner@<endpoint>`), and
    /// before that one item every build shared (`google-owner`). Each is
    /// adopted once, by the workspace whose API minted it.
    private var keychain: WorkspaceCredentialKeychain<OwnerSessionCredentials> {
        let scope = scope
        return WorkspaceCredentialKeychain(
            service: service,
            name: "owner",
            legacyAccounts: ["google-owner@\(scope.apiEndpoint)", "google-owner"],
            apiEndpoint: scope.apiEndpoint,
            scope: scope
        )
    }

    func load() throws -> OwnerSessionCredentials? {
        let credentials: OwnerSessionCredentials?
        do {
            credentials = try keychain.load()
        } catch let failure as StarlingsKeychain.Failure {
            throw OwnerSessionStoreError.keychain(failure.status)
        }
        expectsOwnerSession = credentials != nil
        return credentials
    }

    /// Whether the last Keychain read or write left a session behind. Not a
    /// secret — a bool in defaults — so the first window can be drawn as Home
    /// without touching the Keychain, which is what stopped the launch from
    /// flashing the sign-in card at an owner who is still signed in. A stale
    /// `true` costs one Home frame before onboarding; a stale `false` the
    /// reverse. Both are corrected by the next `load()`.
    var expectsOwnerSession: Bool {
        get {
            let defaults = UserDefaults.standard
            if defaults.object(forKey: expectsSessionKey) == nil {
                // The flag kept before the scope, so the first launch after
                // the move still draws Home.
                return defaults.bool(forKey: "MeetExpectsOwnerSession@google-owner@\(scope.apiEndpoint)")
            }
            return defaults.bool(forKey: expectsSessionKey)
        }
        nonmutating set { UserDefaults.standard.set(newValue, forKey: expectsSessionKey) }
    }

    private var expectsSessionKey: String { scope.defaultsKey(Self.expectsSessionName) }

    private static let expectsSessionName = "MeetExpectsOwnerSession"

    func save(_ credentials: OwnerSessionCredentials) throws {
        let keychain = keychain
        let stamped = OwnerSessionCredentials(
            accessToken: credentials.accessToken,
            refreshToken: credentials.refreshToken,
            owner: credentials.owner,
            apiEndpoint: keychain.apiEndpoint
        )
        do {
            try keychain.save(stamped)
        } catch let failure as StarlingsKeychain.Failure {
            throw OwnerSessionStoreError.keychain(failure.status)
        }
        expectsOwnerSession = true
    }

    /// The server rejected the stored session. Clear it and say so, because a
    /// window that keeps drawing an email and a Start button off a Keychain
    /// item that no longer exists is the "half signed in" state.
    func expire() throws {
        try clear()
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: Self.didExpireNotification, object: nil)
        }
    }

    func clear() throws {
        do {
            try keychain.clear()
        } catch let failure as StarlingsKeychain.Failure {
            throw OwnerSessionStoreError.keychain(failure.status)
        }
        expectsOwnerSession = false
        QuickNoteDestinationOptionsCache.shared.clear()
    }

    /// What Settings › Devices calls this Mac, here and on the other devices.
    /// The same name Core's token list shows.
    static var deviceName: String { Host.current().localizedName ?? String(localized: "Mac") }

    /// This Mac's id for the workspace (`StarlingsKeychain.deviceID`). Kept across
    /// sign-outs: `clear()` removes a session, never this.
    func deviceID() -> String {
        StarlingsKeychain.deviceID(service: service, scope: scope)
    }
}

private enum OwnerSessionStoreError: LocalizedError {
    case keychain(OSStatus)

    var errorDescription: String? {
        switch self {
        case .keychain(let status): String(localized: "The owner session couldn’t be stored securely (Keychain status \(status)).")
        }
    }
}

extension DocsOwnerSession {
    /// The Mac's stored owner session, as Docs needs it; nil when signed out
    /// or when the Keychain does not answer.
    init?(_ store: OwnerSessionStore) {
        guard let stored = try? store.load() else { return nil }
        self.init(accessToken: stored.accessToken, email: stored.owner.email)
    }
}
