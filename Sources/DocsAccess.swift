import Combine
import DocsKit
import Foundation
import Security
import SwiftUI

/// This device's line to Docs: the one `DocsClient` every Documents surface
/// in Starlings writes through.
///
/// The client reads and writes Docs through the workspace's Worker
///: its base URL is `<api origin>/api/docs-service`, where the
/// Worker answers Docs' own paths, and its bearer is the member's owner
/// session. The Worker leaves out every document on a subject the member
/// cannot see and refuses writes to them (docs/ACCESS.md). The device holds
/// no Docs token. The Mac and the phone share this file whole; only how
/// each reads and renews its owner session differs. See docs/DOCS.md.

/// The owner session as Docs needs it: the bearer, and the address the
/// snapshot cache is kept under.
struct DocsOwnerSession: Sendable, Equatable {
    let accessToken: String
    let email: String
}

/// `DocsClient`'s snapshot tier, on Starlings' `SnapshotStore` (docs/CACHING.md):
/// every Docs list read paints its last body before Docs answers. Keyed by
/// the signed-in owner, read on every call like the bearer itself, so a
/// second account on the device never sees the first's lists.
struct StarlingsDocsSnapshots: DocsSnapshotStore {
    let owner: @Sendable () -> String?

    func load(key: String) -> Data? {
        guard let owner = owner() else { return nil }
        return SnapshotStore.load(key: key, owner: owner)?.data
    }

    func save(_ data: Data, key: String) {
        guard let owner = owner() else { return }
        SnapshotStore.save(data, key: key, owner: owner)
    }

    func invalidate(prefix: String) {
        guard let owner = owner() else { return }
        SnapshotStore.invalidate(prefixes: [prefix], owner: owner)
    }
}

extension StarlingsWorkspace {
    /// This workspace's Docs, or nil. Before the descriptor is read, the
    /// build's own workspace keeps DocsKit's host. Whether the workspace
    /// has Docs at all; the apps reach it through the Worker.
    var docsOrigin: URL? { origin(of: .docs, builtInDefault: DocsClient.productionURL) }
}

/// Where `DocsClient` sends its requests: the Worker's copy of Docs' paths,
/// on the API that minted the owner session.
enum DocsServiceAddress {
    /// `apiEndpoint` is `<api origin>/api`; the base is
    /// `<api origin>` + `ContractConstants.docsServicePath`.
    static func baseURL(apiEndpoint: String) -> URL? {
        guard let api = URL(string: apiEndpoint),
              var components = URLComponents(url: api, resolvingAgainstBaseURL: false) else { return nil }
        components.path = ContractConstants.docsServicePath
        components.query = nil
        return components.url
    }
}

@MainActor
final class DocsSession: ObservableObject {
    /// The signed-in owner Docs is read for, or nil before sign-in.
    @Published private(set) var owner: String?
    @Published private(set) var isLinking = false
    @Published private(set) var errorMessage: String?

    /// The one client every Documents surface uses. Reads the owner session
    /// on every request, never a cached copy of the token.
    let client: DocsClient
    /// Renews this platform's owner session when it is near its end, and
    /// answers it. Set by the platform once it has an API to ask.
    var broker: (@MainActor @Sendable () async throws -> DocsOwnerSession?)?
    var cancellables: Set<AnyCancellable> = []

    let deviceName: String
    private let ownerSession: @Sendable () -> DocsOwnerSession?

    /// The Docs this session was made for; nil when the workspace has no Docs.
    private let origin: URL?

    /// `ownerSession` reads the stored owner session, synchronously, on every
    /// request: a renewal elsewhere in the app reaches the next request.
    init(apiEndpoint: String, deviceName: String, ownerSession: @escaping @Sendable () -> DocsOwnerSession?) {
        self.deviceName = deviceName
        self.ownerSession = ownerSession
        let origin = StarlingsWorkspace.active.docsOrigin
        self.origin = origin
        let base = origin == nil ? nil : DocsServiceAddress.baseURL(apiEndpoint: apiEndpoint)
        client = DocsClient(
            baseURL: base ?? StarlingsWorkspace.unreachableOrigin,
            snapshots: StarlingsDocsSnapshots(owner: { ownerSession()?.email }),
            tokenProvider: { ownerSession()?.accessToken }
        )
        owner = base == nil ? nil : ownerSession()?.email
        Self.forgetDeviceToken()
    }

    /// True while the active workspace has Docs, as it did when this session
    /// was made. Every Docs request and every Docs screen checks it.
    var isAvailable: Bool { origin != nil && StarlingsWorkspace.active.docsOrigin == origin }

    var isLinked: Bool { isAvailable && owner != nil }

    /// Make sure the owner session is there and fresh. Never silent
    ///: a session that cannot try says why, so the Docs screen
    /// shows a reason beside Retry, not a bare button.
    func link() async {
        guard !isLinking else { return }
        guard isAvailable else {
            errorMessage = String(localized: "Couldn’t connect Docs")
            return
        }
        guard let broker else {
            errorMessage = String(localized: "Sign in to Starlings before connecting Docs.")
            return
        }
        isLinking = true
        errorMessage = nil
        defer { isLinking = false }
        do {
            guard let session = try await broker() ?? ownerSession() else {
                owner = nil
                errorMessage = String(localized: "Sign in to Starlings before connecting Docs.")
                return
            }
            owner = session.email
        } catch {
            errorMessage = (error as? CoreBrokerFailure)?.coreFailureMessage
                ?? (error as? LocalizedError)?.errorDescription
                ?? error.localizedDescription
        }
    }

    /// Signing out of Starlings signs out of Docs on this device too.
    func ownerSignedOut() {
        owner = nil
        errorMessage = nil
    }

    /// Called after sign-in, on foreground and after attach, only while an
    /// owner is signed in: Docs comes with the Starlings session, with no
    /// Connect step in Settings.
    func ensureLinked() async {
        // Unavailable is a reason, not a quiet return: `link()` says it,
        // so a Docs screen never spins on nothing.
        guard isAvailable else {
            if StarlingsWorkspace.active.has(.docs) { await link() }
            return
        }
        if let session = ownerSession(), owner == session.email { return }
        await link()
    }

    /// Builds before kept a Docs device token in the Keychain and
    /// called Docs directly. Nothing reads it now; it goes from the device
    /// on the first launch. Docs still honours it until it expires or Docs
    /// revokes it (docs/ACCESS.md).
    private static func forgetDeviceToken() {
        let service = "\(ContractConstants.nativeAppBundleID).docs-token"
        try? StarlingsKeychain.delete(service: service, account: WorkspaceScope.active.keychainAccount("device"))
        try? StarlingsKeychain.delete(service: service, account: "device")
    }
}

/// Docs before the owner session is confirmed. Docs comes with
/// the Starlings session, so this asks on appear and shows progress while
/// it does; a failure is red with Copy, and Retry asks again. No bare
/// Connect button: on a workspace with Docs there is nothing for a person
/// to connect.
struct DocsLinkStatusView: View {
    @ObservedObject var session: DocsSession
    /// A line above, where a screen has something to say about Docs.
    var headline: String? = nil

    var body: some View {
        VStack(spacing: 12) {
            if let headline {
                Text(headline).font(.headline).multilineTextAlignment(.center)
            }
            if let message = session.errorMessage, !session.isLinking {
                StarlingsErrorNotice(message: message, alignment: .center) {
                    Task { await session.link() }
                }
            } else {
                ProgressView()
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task { await session.ensureLinked() }
    }
}
