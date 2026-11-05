import Combine
import Foundation
import KeepKit
import Security

/// This device's standing with Keep: the token, and the `KeepSession` every
/// Keep screen in Meet drives.
///
/// The same arrangement as `DocsAccess`, against a different far end. The
/// Worker proves the owner to `the Keep host` and Keep mints a token
/// for this device; from then on the device talks to Keep directly, and
/// does every cryptographic operation itself — the Worker never sees a
/// vault key or a plaintext. The Mac and the phone share this file whole;
/// only the broker and the screens differ. See docs/KEEP.md.

/// What the Worker brokers for this device: the generated `KeepTokenResponse`.
typealias KeepToken = KeepTokenResponse

/// The token this device holds for Keep, as stored. Stamped with the Meet API
/// endpoint that brokered it, like the Docs credential, so a Debug build
/// against a local Worker never presents a token minted for production.
struct KeepCredential: WorkspaceStampedCredential, Equatable {
    let token: String
    let expiresAt: String
    let email: String
    let apiEndpoint: String?

    enum CodingKeys: String, CodingKey {
        case token
        case expiresAt = "expires_at"
        case email
        case apiEndpoint = "api_endpoint"
    }

    init(_ issued: KeepToken, apiEndpoint: String?) {
        token = issued.token
        expiresAt = issued.expiresAt
        email = issued.email
        self.apiEndpoint = apiEndpoint
    }

    var expiryDate: Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: expiresAt) { return date }
        return ISO8601DateFormatter().date(from: expiresAt)
    }

    /// Renew inside the last week.
    var expiresSoon: Bool {
        guard let expiryDate else { return true }
        return expiryDate.timeIntervalSinceNow < 7 * 24 * 60 * 60
    }
}

struct KeepCredentialStoreError: LocalizedError, Equatable {
    let message: String
    var errorDescription: String? { message }
}

/// Keychain home for the Keep token, one item per workspace. Its own item
/// beside Docs' and Core's; the three are minted, renewed and dropped
/// separately. The token is the only thing Keep ever puts in the Keychain:
/// the private key is memory.
struct KeepCredentialStore: Sendable {
    /// The Meet API this build talks to. A token stamped for another one is
    /// dropped on read rather than presented to the wrong Keep.
    let apiEndpoint: String
    /// `device@<webOrigin>`; the one `device` item from before the scope is
    /// adopted once, by the workspace whose API minted it.
    private let keychain: WorkspaceCredentialKeychain<KeepCredential>

    init(apiEndpoint: String, scope: WorkspaceScope = .active) {
        self.apiEndpoint = apiEndpoint
        keychain = WorkspaceCredentialKeychain(
            service: "\(ContractConstants.nativeAppBundleID).keep-token",
            name: "device",
            legacyAccounts: ["device"],
            apiEndpoint: apiEndpoint,
            scope: scope
        )
    }

    func load() throws -> KeepCredential? {
        do {
            return try keychain.load()
        } catch is StarlingsKeychain.Failure {
            throw KeepCredentialStoreError(message: String(localized: "The Keep token couldn’t be read from Keychain."))
        }
    }

    /// The bearer for Keep, or nil — read fresh on every call, so a
    /// disconnect takes effect on the very next request.
    func token() -> String? {
        (try? load())?.token
    }

    func save(_ credential: KeepCredential) throws {
        do {
            try keychain.save(credential)
        } catch is StarlingsKeychain.Failure {
            throw KeepCredentialStoreError(message: String(localized: "The Keep token couldn’t be saved to Keychain."))
        }
    }

    func clear() throws {
        do {
            try keychain.clear()
        } catch is StarlingsKeychain.Failure {
            throw KeepCredentialStoreError(message: String(localized: "The Keep token couldn’t be removed from Keychain."))
        }
    }
}

extension StarlingsWorkspace {
    /// This workspace's Keep, or nil. Before the descriptor is read, the
    /// build's own workspace keeps KeepKit's host.
    var keepOrigin: URL? { origin(of: .keep, builtInDefault: KeepClient.productionURL) }
}

/// The token half. `session` is the key half, from KeepKit: it reads the
/// Keychain through the store on every request and holds the unlocked
/// private key in memory until it locks.
@MainActor
final class KeepAccess: ObservableObject {
    @Published private(set) var credential: KeepCredential?
    @Published private(set) var isLinking = false
    @Published private(set) var errorMessage: String?

    let session: KeepSession
    /// Asks this platform's Worker for a token. Set by the platform once it
    /// has an API and a signed-in owner to ask on behalf of.
    var broker: (@MainActor @Sendable () async throws -> KeepToken)?
    var cancellables: Set<AnyCancellable> = []

    private let store: KeepCredentialStore
    private let apiEndpoint: String
    let deviceName: String

    init(apiEndpoint: String, deviceName: String) {
        self.apiEndpoint = apiEndpoint
        self.deviceName = deviceName
        let store = KeepCredentialStore(apiEndpoint: apiEndpoint)
        self.store = store
        let origin = StarlingsWorkspace.active.keepOrigin
        self.origin = origin
        session = KeepSession(client: KeepClient(baseURL: origin ?? StarlingsWorkspace.unreachableOrigin, tokenProvider: { store.token() }))
        credential = origin == nil ? nil : try? store.load()
    }

    /// The Keep this session's client calls, fixed when the session is made;
    /// nil when the workspace has no Keep.
    private let origin: URL?

    /// True while the active workspace has Keep at the origin this session
    /// calls. Every Keep request and every Keep screen checks it.
    var isAvailable: Bool { origin != nil && StarlingsWorkspace.active.keepOrigin == origin }

    var isLinked: Bool { isAvailable && credential != nil }

    /// Connect, or reconnect: mint a token for this device through the Worker,
    /// then let the session find out who we are.
    func link() async {
        guard isAvailable, let broker, !isLinking else { return }
        isLinking = true
        errorMessage = nil
        defer { isLinking = false }
        do {
            let issued = try await broker()
            let credential = KeepCredential(issued, apiEndpoint: apiEndpoint)
            try store.save(credential)
            self.credential = credential
            await session.refresh()
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    /// Forget the token on this device. It stays valid until Keep revokes it
    /// — on the next exchange for this device name, or in Keep's device list.
    func unlink() {
        try? store.clear()
        credential = nil
        errorMessage = nil
        session.disconnect()
    }

    /// Signing out of Meet signs out of Keep on this device too, and locks.
    func ownerSignedOut() {
        guard credential != nil else { return }
        unlink()
    }

    /// Called after sign-in, on foreground and after attach, only while an
    /// owner is signed in: Keep comes with the Meet session, with no Connect
    /// step in Settings. Gets a token when there is none and renews one
    /// inside its last week. The token proves who is asking; it opens
    /// nothing, so unlocking stays a separate act.
    func ensureLinked() async {
        guard isAvailable else { return }
        if let credential, !credential.expiresSoon { return }
        await link()
    }
}
