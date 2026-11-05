import Combine
import CoreKit
import Foundation
import Security

/// This device's standing with Core: the token, the registry it unlocks, and
/// the one `CRMRepository` every Core screen in Meet reads through.
///
/// Meet's own Work surfaces keep talking to the Worker. This is the layer
/// beneath them — the Core block in Work's sidebar, Fields on a subject,
/// registry search — and it talks to `the Core host` directly, as the
/// Core app does, under the same per-entity permissions. Connecting is one
/// act: the Worker proves the owner to Core and Core mints the token. The
/// Mac and the phone share this file whole; only the broker — how each asks
/// its Worker — and the screens differ. See docs/CORE_REGISTRY.md.

extension StarlingsWorkspace {
    /// This workspace's Core, or nil. Before the descriptor is read, the
    /// build's own workspace keeps core-kit's host.
    var coreOrigin: URL? { origin(of: .core, builtInDefault: ServerConfig.baseURL) }
}

/// What the Worker brokers for this device: the generated `CoreTokenResponse`.
typealias CoreToken = CoreTokenResponse

/// The token this device holds for Core, as stored. Stamped with the Meet API
/// endpoint that brokered it, the same way the owner session is, so a Debug
/// build against a local Worker never presents a token minted for production.
struct CoreCredential: WorkspaceStampedCredential, Equatable {
    let token: String
    let scopes: [String]
    let expiresAt: String
    let email: String
    let apiEndpoint: String?

    enum CodingKeys: String, CodingKey {
        case token
        case scopes
        case expiresAt = "expires_at"
        case email
        case apiEndpoint = "api_endpoint"
    }

    init(_ issued: CoreToken, apiEndpoint: String?) {
        token = issued.token
        scopes = issued.scopes
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

    /// Renew ahead of expiry rather than on it: a token that dies mid-edit is
    /// a lost edit. A week is well inside the 90-day life and well outside
    /// any plausible gap between launches.
    var expiresSoon: Bool {
        guard let expiryDate else { return true }
        return expiryDate.timeIntervalSinceNow < 7 * 24 * 60 * 60
    }
}

struct CoreCredentialStoreError: LocalizedError, Equatable {
    let message: String
    var errorDescription: String? { message }
}

/// Keychain home for the Core token. One item per workspace, app-private,
/// never in a shared access group: nothing else on this device has business
/// reading it.
struct CoreCredentialStore: Sendable {
    /// The Meet API this build talks to. A token stamped for another one is
    /// dropped on read rather than presented to the wrong Core.
    let apiEndpoint: String
    /// `pat@<webOrigin>`; the one `pat` item from before the scope is
    /// adopted once, by the workspace whose API minted it.
    private let keychain: WorkspaceCredentialKeychain<CoreCredential>

    init(apiEndpoint: String, scope: WorkspaceScope = .active) {
        self.apiEndpoint = apiEndpoint
        keychain = WorkspaceCredentialKeychain(
            service: "\(ContractConstants.nativeAppBundleID).core-token",
            name: "pat",
            legacyAccounts: ["pat"],
            apiEndpoint: apiEndpoint,
            scope: scope
        )
    }

    func load() throws -> CoreCredential? {
        do {
            return try keychain.load()
        } catch is StarlingsKeychain.Failure {
            throw CoreCredentialStoreError(message: String(localized: "The records token couldn’t be read from Keychain."))
        }
    }

    /// The bearer for Core, or nil. What `CRMRepository` asks on every call,
    /// the way the Core app reads its own Keychain item — so a disconnect
    /// takes effect on the very next request, with no cached copy to outlive it.
    func token() -> String? {
        (try? load())?.token
    }

    func save(_ credential: CoreCredential) throws {
        do {
            try keychain.save(credential)
        } catch is StarlingsKeychain.Failure {
            throw CoreCredentialStoreError(message: String(localized: "The records token couldn’t be saved to Keychain."))
        }
    }

    func clear() throws {
        do {
            try keychain.clear()
        } catch is StarlingsKeychain.Failure {
            throw CoreCredentialStoreError(message: String(localized: "The records token couldn’t be removed from Keychain."))
        }
    }
}

/// What a broker's failure has to say for itself: the Worker's stable code,
/// so `core_account_missing` can be told from a plain outage, and the prose
/// for people. `StarlingsError` answers it on both clients.
protocol CoreBrokerFailure {
    var coreErrorCode: String? { get }
    var coreFailureMessage: String { get }
}

extension StarlingsError: CoreBrokerFailure {
    var coreErrorCode: String? { serverCode }
    var coreFailureMessage: String { message }
}

@MainActor
final class CoreSession: ObservableObject {
    @Published private(set) var credential: CoreCredential?
    /// The registry: every entity Core publishes to this account, with its
    /// fields, capabilities and access. Cached on disk by the repository, so
    /// a cold start draws the block before Core answers.
    @Published private(set) var contracts: [CRMEntityContract] = []
    @Published private(set) var grantedScopes: [String]?
    /// How many records each entity holds, by entity id — what a row in the
    /// Core block says under its name. One light request per entity, asked
    /// after the registry lands; absent until Core answers, never guessed.
    @Published private(set) var recordCounts: [String: Int] = [:]
    @Published private(set) var isLoading = false
    @Published private(set) var isLinking = false
    @Published private(set) var errorMessage: String?
    /// Core answered that this address has no Core account. Not an error to
    /// retry: the owner signs in to Core on the web once, then connects.
    @Published private(set) var needsCoreAccount = false

    let repository: CRMRepository
    /// Asks this platform's Worker for a token. Set by the platform once it
    /// has an API and a signed-in owner to ask on behalf of.
    var broker: (@MainActor @Sendable () async throws -> CoreToken)?
    /// Platform glue's subscriptions — the sign-out watch — live here so an
    /// extension can own them without a stored property of its own.
    var cancellables: Set<AnyCancellable> = []

    private let store: CoreCredentialStore
    private let apiEndpoint: String
    let deviceName: String

    /// The Core this session's client calls, fixed when the session is made;
    /// nil when the workspace has no Core.
    private let origin: URL?

    init(apiEndpoint: String, deviceName: String) {
        self.apiEndpoint = apiEndpoint
        self.deviceName = deviceName
        let store = CoreCredentialStore(apiEndpoint: apiEndpoint)
        self.store = store
        let origin = StarlingsWorkspace.active.coreOrigin
        self.origin = origin
        let tokenProvider: @Sendable () -> String? = { store.token() }
        repository = CRMRepository(
            space: .crm,
            client: CoreAgentClient(baseURL: origin ?? StarlingsWorkspace.unreachableOrigin, space: .crm, tokenProvider: tokenProvider),
            tokenProvider: tokenProvider
        )
        credential = origin == nil ? nil : try? store.load()
    }

    /// True while the active workspace has Core at the origin this session
    /// calls. Every Core request and every Core screen checks it.
    var isAvailable: Bool { origin != nil && StarlingsWorkspace.active.coreOrigin == origin }

    var isLinked: Bool { isAvailable && credential != nil }

    /// What Other records lists: everything this account may list, minus the
    /// records Work already has doors for. One door per object. Organizations
    /// and contacts are Work's too, on the Worker's routes. A table
    /// whose group moved to D1 also leaves: Core's copy of it is stale
    /// (`coreHolds`, #1262).
    var entities: [CRMEntityContract] {
        let services = StarlingsWorkspace.active.services
        return contracts.filter {
            $0.canList && !Self.workEntities.contains($0.id) && (services?.coreHolds(collection: $0.id) ?? true)
        }
    }

    /// The Core entities Work reads and writes through the Worker.
    static let workEntities: Set<String> = ["projects", "leads", "organizations", "contacts"]

    func contract(id: String) -> CRMEntityContract? {
        contracts.first { $0.id == id }
    }

    /// Connect, or reconnect: mint a token for this device through the Worker.
    func link() async {
        guard isAvailable, let broker, !isLinking else { return }
        isLinking = true
        errorMessage = nil
        needsCoreAccount = false
        defer { isLinking = false }
        do {
            let issued = try await broker()
            let credential = CoreCredential(issued, apiEndpoint: apiEndpoint)
            try store.save(credential)
            self.credential = credential
            await loadContracts(forceRefresh: true)
        } catch {
            let failure = error as? CoreBrokerFailure
            if failure?.coreErrorCode == "core_account_missing" { needsCoreAccount = true }
            errorMessage = needsCoreAccount
                ? String(localized: "This address has no records account yet. Sign in once at \(origin?.host ?? ""), then try again.")
                : failure?.coreFailureMessage
                    ?? (error as? LocalizedError)?.errorDescription
                    ?? error.localizedDescription
        }
    }

    /// Forget the token on this device and the cache it filled. The token
    /// itself stays valid until Core revokes it; that is done in Core's own
    /// token list, not here.
    func unlink() async {
        let accountKey = repository.accountKey
        try? store.clear()
        credential = nil
        contracts = []
        grantedScopes = nil
        recordCounts = [:]
        errorMessage = nil
        needsCoreAccount = false
        if let accountKey {
            try? await CRMCacheStore.shared.purge(accountKey: accountKey)
        }
    }

    /// Signing out of Meet signs out of Core on this device too: the token
    /// was issued on the strength of that session, and nothing should
    /// outlive it.
    func ownerSignedOut() async {
        guard credential != nil else { return }
        await unlink()
    }

    /// Called on foreground and after attach: renews a token inside its last
    /// week, and fills an empty registry. Quiet — failures wait for the next
    /// explicit act rather than nagging on every return to the app.
    func refreshIfNeeded() async {
        guard isAvailable, let credential else { return }
        if credential.expiresSoon {
            await link()
        } else if contracts.isEmpty {
            await loadContracts()
        }
    }

    /// Cached registry first, then Core's. A stale registry is still a
    /// registry: the block draws immediately and corrects itself.
    func loadContracts(forceRefresh: Bool = false) async {
        guard isAvailable, repository.hasToken else { return }
        isLoading = true
        defer { isLoading = false }
        if !forceRefresh, contracts.isEmpty, let cached = try? await repository.cachedContracts() {
            contracts = cached.entities
            grantedScopes = cached.grantedScopes
        }
        do {
            let fresh = try await repository.refreshContracts()
            contracts = fresh.entities
            grantedScopes = fresh.grantedScopes
            errorMessage = nil
        } catch is CancellationError {
            return
        } catch {
            // The block has cached rows to draw; only an empty registry needs
            // to explain itself.
            if contracts.isEmpty { errorMessage = error.localizedDescription }
        }
        await loadCounts()
    }

    /// One count per listed entity, all at once. A count that fails stays
    /// absent rather than stale-or-zero; the next registry load asks again.
    func loadCounts() async {
        guard isAvailable else { return }
        let repository = repository
        let ids = entities.map(\.id)
        guard !ids.isEmpty else { return }
        let counts = await withTaskGroup(of: (String, Int?).self, returning: [String: Int].self) { group in
            for id in ids {
                group.addTask { (id, await repository.recordCount(entity: id)) }
            }
            var result: [String: Int] = [:]
            for await (id, count) in group {
                if let count { result[id] = count }
            }
            return result
        }
        guard !Task.isCancelled else { return }
        recordCounts.merge(counts) { _, fresh in fresh }
    }

    /// "128 entries", or nil while Core has not said. The one phrasing for
    /// the count under an entity's name, on the rail and in the list.
    func countLabel(for entityID: String) -> String? {
        guard let count = recordCounts[entityID] else { return nil }
        let formatted = count.formatted(.number)
        return count == 1 ? String(localized: "\(formatted) entry") : String(localized: "\(formatted) entries")
    }
}

// MARK: - Organization directory

extension CoreSession {
    /// `crmOrganizationCreateSchema`'s cap, from `FormFieldRegistry`: the
    /// web's route and the native pickers keep a new organization's name to
    /// the same length.
    nonisolated static var organizationNameLimit: Int { FormFieldRegistry.organization.name.maxLength ?? 200 }
}

