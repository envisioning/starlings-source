import Combine
import Foundation
import os

/// The workspace this install signs in to ( points 1 and 2
/// v1: one workspace per install). The plan and the trust rules are in
/// docs/CENTRAL_AUTH.md §Native sign-in.
///
/// Not a secret and not a session: the name, the mark and the two origins a
/// workspace already publishes at `/.well-known/meet`. The session stays in
/// the Keychain, where it was.
struct StarlingsWorkspace: Codable, Equatable, Sendable {
    /// The workspace's own web origin, from its descriptor. Per-workspace
    /// state is keyed by it.
    var webOrigin: String
    /// The origin the API answers on (`<apiOrigin>/api/…`).
    var apiOrigin: String
    var name: String
    /// The mark on `webOrigin`, or nil to draw the built-in mark or the initial.
    var markURL: String?
    /// The origin room, booking and meeting links name (the descriptor's
    /// `public_web_origin`). Nil on a workspace stored before this field.
    var publicWebOrigin: String? = nil

    /// The origin every link this workspace hands out names. A
    /// workspace stored before `publicWebOrigin` existed keeps the build's
    /// public origin when it is the build's own, else its `webOrigin`; never
    /// another workspace's host.
    var publicOrigin: String {
        if let publicWebOrigin { return publicWebOrigin }
        if isBuiltIn, let builtIn = Self.builtIn.publicWebOrigin { return builtIn }
        return webOrigin
    }
    /// The address a member adds to Claude or any MCP client
    /// (docs/help/howto/connect-claude.md): the web origin and `/mcp`.
    var mcpAddress: String {
        webOrigin.replacingOccurrences(of: "/+$", with: "", options: .regularExpression) + ContractConstants.mcpPath
    }
    /// The name to give that connector, the name the server gives itself:
    /// "Starlings · HQ". Two connected workspaces read apart by it.
    var mcpServerName: String { ContractConstants.mcpServerNamePrefix + name }
    /// The help page that says where each Claude adds `mcpAddress`.
    var mcpConnectHelpURL: URL? {
        URL(string: publicOrigin + ContractConstants.mcpConnectHelpPath)
    }
    /// Where the workspace's mail and calendar live, from its descriptor. Nil
    /// before the first read, and from an older Worker: read it as Google.
    var suite: WorkspaceDescriptorSuite? = nil
    var workspaceDefaults: WorkspaceClientDefaults? = nil
    var projectGroupName: String { workspaceDefaults?.projectGroupName ?? name }
    /// The services the descriptor names. Nil before the first read and from
    /// an older Worker; `origin(of:builtInDefault:)` says what nil means.
    var services: Services? = nil
    /// Who is a member by address, from the descriptor. Nil before the first
    /// read and for a workspace stored before slice C.
    var identity: Identity? = nil
    /// Other hosts confirmed to serve this workspace: its public link host
    /// and its aliases, each kept only once that host's own descriptor named
    /// the same `web_origin` (slice F). A link on one of them opens
    /// here. Nil before the first read.
    var linkHosts: [String]? = nil
    /// Every shade of the workspace's accent, from the descriptor's
    /// `accent_palette` (`WorkspaceAccent`). Nil keeps the product's own.
    var accentPalette: WorkspaceDescriptorAccentPalette? = nil

    /// The services a native client calls directly (,
    /// docs/CENTRAL_AUTH.md slice C). Each value is an origin, or nil when the
    /// workspace does not have that service.
    struct Services: Codable, Equatable, Sendable {
        var core: String?
        /// The record groups Core still holds (`WORK_GROUPS`). Nil
        /// from an older Worker: read it as every group.
        var coreGroups: [String]? = nil
        var docs: String?
        var keep: String?

        /// True while Core still holds the group of `collection`
        /// (`CORE_COLLECTION_GROUPS`). A collection in no group (signals,
        /// events, offers) stays on Core. Once a group answers from D1, Core's
        /// page is a stale copy, so no client links there.
        func coreHolds(collection: String) -> Bool {
            guard let group = ContractConstants.coreCollectionGroups[collection], let coreGroups else { return true }
            return coreGroups.contains(group)
        }

        func origin(of service: Service) -> String? {
            switch service {
            case .core: core
            case .docs: docs
            case .keep: keep
            }
        }
    }

    enum Service: Sendable {
        case core, docs, keep
    }

    /// The descriptor's `identity`: the member domains, and the one domain
    /// the account chooser is narrowed to (nil shows every account).
    struct Identity: Codable, Equatable, Sendable {
        var domains: [String]
        var signInHint: String?

        /// The build's own workspace before its descriptor is read.
        static let builtIn = Identity(domains: ContractConstants.identityDomains, signInHint: ContractConstants.signInDomain)
    }

    /// True when a member can connect a calendar: Meet speaks Google Calendar
    /// only, so Microsoft 365 and other suites hide Connect Calendar.
    var calendarConnectable: Bool { (suite ?? .google) == .google }

    /// The origin a client calls for `service`, or nil when this workspace
    /// does not have it. Fails closed: a descriptor that names its services
    /// decides; without one, the build's own workspace keeps the build's
    /// default and any other workspace has no service.
    func origin(of service: Service, builtInDefault: URL) -> URL? {
        guard let services else { return isBuiltIn ? builtInDefault : nil }
        return services.origin(of: service).flatMap(URL.init(string:))
    }

    /// The base URL a service client is built with when the workspace does not
    /// have that service. `.invalid` never resolves (RFC 6761), so a stray call
    /// fails on the device and reaches no host.
    static let unreachableOrigin = URL(string: "https://service.invalid")!

    /// True when this workspace has `service`. The same rule as `origin(of:)`.
    func has(_ service: Service) -> Bool {
        guard let services else { return isBuiltIn }
        return services.origin(of: service) != nil
    }

    /// The member domains and chooser hint this workspace uses. Without a
    /// descriptor, the build's own workspace keeps the build's; any other
    /// admits nobody by domain.
    var resolvedIdentity: Identity {
        identity ?? (isBuiltIn ? .builtIn : Identity(domains: [], signInHint: nil))
    }

    /// The host a person reads as the workspace's address:
    /// `your-team.<suffix>`. The port only on a local stack.
    var address: String {
        guard let components = URLComponents(string: webOrigin), let host = components.host else { return webOrigin }
        return components.port.map { "\(host):\($0)" } ?? host
    }

    /// The first letter of the name, for a workspace with no mark.
    var initial: String {
        name.trimmingCharacters(in: .whitespacesAndNewlines).first.map { String($0).uppercased() } ?? "?"
    }

    /// The workspace the build names (`MEET_WEB_ORIGIN`, `MEET_API_ENDPOINT`):
    /// Envisioning, so a current member starts where they were.
    static let builtIn: StarlingsWorkspace = {
        let bundle = Bundle.main
        let api = (bundle.object(forInfoDictionaryKey: "MEET_API_ENDPOINT") as? String)
            .flatMap(StarlingsWorkspaceAddress.origin(of:)) ?? "http://127.0.0.1:8787"
        let web = (bundle.object(forInfoDictionaryKey: "MEET_WEB_ORIGIN") as? String)
            .flatMap(StarlingsWorkspaceAddress.origin(of:)) ?? "http://127.0.0.1:5173"
        return StarlingsWorkspace(
            webOrigin: web, apiOrigin: api, name: "Starlings", markURL: nil,
            publicWebOrigin: ContractConstants.publicWebOrigin
        )
    }()

    /// True for the build's own workspace, however it was reached.
    var isBuiltIn: Bool {
        webOrigin == Self.builtIn.webOrigin || apiOrigin == Self.builtIn.apiOrigin
    }

    /// True when this build may talk to the workspace: the build's own, or
    /// one whose origins this build accepts (`https` in Release; loopback too
    /// in Debug). A Release run never restores a Debug run's local workspace.
    var canSignIn: Bool {
        isBuiltIn || (StarlingsWorkspaceAddress.origin(for: webOrigin) != nil && StarlingsWorkspaceAddress.origin(for: apiOrigin) != nil)
    }

    /// True when sign-in goes through the workspace's own web sign-in
    /// (`/api/auth/native/start`, slice D). The build's own
    /// workspace keeps the native Google flow until it moves to central
    /// sign-in.
    var signsInThroughWorkspace: Bool { !isBuiltIn }

    /// `<apiOrigin>/api`, the base every API path hangs off.
    var apiBaseURL: URL {
        URL(string: apiOrigin).map { $0.appending(path: "api") } ?? URL(string: "http://127.0.0.1:8787/api")!
    }

    /// The workspace every request, session and store reads its origins from.
    /// The only source: nothing else reads `MEET_API_ENDPOINT` or
    /// `MEET_WEB_ORIGIN`, so a workspace change reaches every client at once.
    /// Any thread may read it; only `StarlingsWorkspaceStore.shared` writes it,
    /// and the hosted test bundle, which pins it once before any test runs
    /// (`Tests/HostedTestWorkspace.swift`).
    static var active: StarlingsWorkspace { activeState.withLock { $0 } }

    static func setActive(_ workspace: StarlingsWorkspace) {
        activeState.withLock { $0 = workspace }
    }

    /// Posted on the main actor when the shared store's workspace moves to
    /// another origin.
    static let didChangeNotification = Notification.Name("MeetWorkspaceDidChange")

    /// Where `StarlingsWorkspaceStore` keeps the workspace. No secret in it.
    fileprivate static let storageKey = "meet.workspace.current"

    private static let activeState = OSAllocatedUnfairLock(initialState: restored(from: .standard))

    /// The stored workspace, or the build's own when none is stored or this
    /// build cannot sign in to the stored one, so a Debug run never strands a
    /// Release one.
    fileprivate static func restored(from defaults: UserDefaults) -> StarlingsWorkspace {
        // A workspace that moved origin moves its items first, before any
        // store reads them under the old one.
        WorkspaceOriginMove.migrateStoredWorkspaces(
            defaults: defaults, currentKey: storageKey, knownKey: StarlingsWorkspaceStore.knownKey
        )
        let stored = defaults.data(forKey: storageKey)
            .flatMap { try? JSONDecoder().decode(StarlingsWorkspace.self, from: $0) }
        return stored.flatMap { $0.canSignIn ? $0 : nil } ?? .builtIn
    }
}

/// What a person types to name a workspace: `<slug>`, a host, or a pasted URL.
enum StarlingsWorkspaceAddress {
    /// The workspace origin the input names, or nil. A bare slug is
    /// `<slug>.<suffix>`. Release takes `https` only; Debug also takes
    /// a loopback or `.local` host over `http`, for the local stack.
    static func origin(for input: String) -> URL? {
        var value = input.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !value.isEmpty, !value.contains(where: { $0.isWhitespace }) else { return nil }
        if !value.contains("://") {
            let host = value.split(separator: "/", maxSplits: 1).first.map(String.init) ?? value
            if !host.contains("."), !host.contains(":") {
                guard isSlug(host) else { return nil }
                value = "\(host).\(ContractConstants.workspaceHostSuffix)"
            }
            value = "https://\(value)"
        }
        guard let components = URLComponents(string: value),
              let scheme = components.scheme,
              let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil
        else { return nil }
        let local = isDevelopmentHost(host)
        switch scheme {
        case "https":
            guard components.port == nil || local else { return nil }
        case "http":
            guard local else { return nil }
        default:
            return nil
        }
        var origin = URLComponents()
        origin.scheme = scheme
        origin.host = host
        origin.port = components.port
        return origin.url
    }

    /// `scheme://host[:port]` of a configured URL, or nil.
    static func origin(of configured: String) -> String? {
        guard let components = URLComponents(string: configured.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = components.scheme?.lowercased(),
              let host = components.host?.lowercased(), !host.isEmpty
        else { return nil }
        return components.port.map { "\(scheme)://\(host):\($0)" } ?? "\(scheme)://\(host)"
    }

    /// ADR 0004 decision 4's shape: `a-z0-9-`, no hyphen at either end.
    /// Reserved names are the server's to refuse; they have no descriptor.
    private static func isSlug(_ value: String) -> Bool {
        value.range(of: #"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$"#, options: .regularExpression) != nil
    }

    private static func isDevelopmentHost(_ host: String) -> Bool {
        #if DEBUG
        host == "127.0.0.1" || host == "localhost" || host == "::1" || host.hasSuffix(".local")
        #else
        false
        #endif
    }
}

enum StarlingsWorkspaceLookupError: LocalizedError, Equatable {
    case invalidAddress
    case notFound
    /// The device could not reach the network: not an answer about the address.
    case unreachable
    /// The workspace answered with a descriptor this build cannot read, and
    /// says why: a newer descriptor `version`, or a `min_client` above this
    /// build. The app asks to be updated instead of failing.
    case updateRequired

    var errorDescription: String? {
        switch self {
        case .invalidAddress:
            return String(localized: "Enter a workspace address.")
        case .notFound:
            return String(localized: "No workspace at that address.")
        case .unreachable:
            return String(localized: "Couldn’t reach that workspace. Check your connection.")
        case .updateRequired:
            return String(localized: "This workspace needs a newer version of Starlings. Update the app, then try again.")
        }
    }

    /// The transport failures that say nothing about the address.
    /// A host that does not resolve is an answer: no workspace there.
    static func reading(_ error: Error) -> StarlingsWorkspaceLookupError {
        guard let url = error as? URLError else { return .notFound }
        switch url.code {
        case .notConnectedToInternet, .networkConnectionLost, .timedOut, .dataNotAllowed,
             .internationalRoamingOff, .callIsActive, .cannotConnectToHost:
            return .unreachable
        default:
            return .notFound
        }
    }
}

/// Reads workspace descriptors. Stateless; the store keeps the answer.
enum StarlingsWorkspaceDirectory {
    /// The workspace an address names.
    ///
    /// Trust rule (docs/CENTRAL_AUTH.md §Choosing the workspace): a workspace
    /// speaks for itself only from its own `web_origin`. When the typed host
    /// names another, the descriptor is read again from that origin and must
    /// name the same origin, so a host cannot dress itself up as another
    /// workspace.
    static func lookUp(_ input: String, session: URLSession = .shared) async throws -> StarlingsWorkspace {
        guard let typed = StarlingsWorkspaceAddress.origin(for: input) else { throw StarlingsWorkspaceLookupError.invalidAddress }
        var descriptor = try await read(at: typed, session: session)
        guard let canonical = canonicalOrigin(descriptor.webOrigin) else { throw StarlingsWorkspaceLookupError.notFound }
        if canonical.absoluteString != typed.absoluteString {
            descriptor = try await read(at: canonical, session: session)
            guard canonicalOrigin(descriptor.webOrigin)?.absoluteString == canonical.absoluteString else {
                throw StarlingsWorkspaceLookupError.notFound
            }
        }
        guard var workspace = workspace(from: descriptor) else { throw StarlingsWorkspaceLookupError.notFound }
        workspace.linkHosts = await verifiedHosts(of: descriptor, session: session)
        return workspace
    }

    /// The workspace a descriptor describes, or nil when its origins are not
    /// ones this build may talk to. A mark off the workspace's origin is dropped.
    static func workspace(from descriptor: WorkspaceDescriptor) -> StarlingsWorkspace? {
        guard descriptor.version == ContractConstants.workspaceDescriptorVersion,
              let web = canonicalOrigin(descriptor.webOrigin)?.absoluteString,
              let api = canonicalOrigin(descriptor.apiOrigin)?.absoluteString
        else { return nil }
        let name = descriptor.name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return nil }
        let mark = descriptor.brand.markURL.flatMap { value -> String? in
            guard let url = URL(string: value), StarlingsWorkspaceAddress.origin(of: value) == web else { return nil }
            return url.absoluteString
        }
        return StarlingsWorkspace(
            webOrigin: web,
            apiOrigin: api,
            name: String(name.prefix(80)),
            markURL: mark,
            publicWebOrigin: canonicalOrigin(descriptor.publicWebOrigin)?.absoluteString,
            suite: descriptor.suite,
            workspaceDefaults: descriptor.defaults,
            services: descriptor.services.map(services(from:)),
            identity: identity(from: descriptor.identity),
            accentPalette: descriptor.accentPalette
        )
    }

    /// The descriptor's `public_web_origin` and `aliases` that speak for the
    /// same workspace: each host's own descriptor names the same
    /// `web_origin`. A workspace cannot claim another workspace's hosts.
    static func verifiedHosts(of descriptor: WorkspaceDescriptor, session: URLSession = .shared) async -> [String] {
        guard let web = canonicalOrigin(descriptor.webOrigin)?.absoluteString else { return [] }
        func confirmed(_ value: String) async -> String? {
            guard let claimed = canonicalOrigin(value) else { return nil }
            if claimed.absoluteString == web { return web }
            guard let answer = try? await read(at: claimed, session: session),
                  canonicalOrigin(answer.webOrigin)?.absoluteString == web
            else { return nil }
            return claimed.absoluteString
        }
        var hosts: [String] = []
        for claimed in [descriptor.publicWebOrigin] + (descriptor.aliases ?? []).prefix(8) {
            if let host = await confirmed(claimed), host != web, !hosts.contains(host) { hosts.append(host) }
        }
        return hosts
    }

    /// Each service origin this build may call, or nil. An origin that does
    /// not parse, or is not `https` in Release, is no service: fail closed.
    private static func services(from wire: WorkspaceDescriptorServices) -> StarlingsWorkspace.Services {
        func checked(_ value: String?) -> String? { value.flatMap { canonicalOrigin($0)?.absoluteString } }
        return StarlingsWorkspace.Services(
            core: checked(wire.core),
            coreGroups: wire.coreGroups?.map(\.rawValue),
            docs: checked(wire.docs),
            keep: checked(wire.keep)
        )
    }

    private static func identity(from wire: WorkspaceDescriptorIdentity) -> StarlingsWorkspace.Identity {
        let domains = wire.domains
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
            .filter { !$0.isEmpty }
        let hint = wire.signInHint?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return StarlingsWorkspace.Identity(domains: domains, signInHint: hint?.isEmpty == false ? hint : nil)
    }

    /// `GET <origin>/.well-known/meet`, strictly decoded. No cookies ride along.
    static func read(at origin: URL, session: URLSession = .shared) async throws -> WorkspaceDescriptor {
        guard let url = URL(string: ContractConstants.workspaceDescriptorPath, relativeTo: origin)?.absoluteURL else {
            throw StarlingsWorkspaceLookupError.invalidAddress
        }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpShouldHandleCookies = false
        let result: (Data, URLResponse)
        do {
            result = try await session.data(for: request)
        } catch {
            throw StarlingsWorkspaceLookupError.reading(error)
        }
        let data = result.0
        // A redirect may only stay on the origin that was asked.
        guard let http = result.1 as? HTTPURLResponse, http.statusCode == 200,
              http.url.flatMap({ StarlingsWorkspaceAddress.origin(of: $0.absoluteString) }) == origin.absoluteString,
              data.count <= 64 * 1024
        else { throw StarlingsWorkspaceLookupError.notFound }
        guard let descriptor = try? JSONDecoder().decode(WorkspaceDescriptor.self, from: data),
              descriptor.version == ContractConstants.workspaceDescriptorVersion
        else {
            if asksForUpdate(data) {
                await MainActor.run { StarlingsUpgradeRecommendation.shared.receiveFloor(below: true) }
                throw StarlingsWorkspaceLookupError.updateRequired
            }
            throw StarlingsWorkspaceLookupError.notFound
        }
        return descriptor
    }

    /// This build's floor in a descriptor's `min_client`.
    static func floor(in minClient: WorkspaceDescriptorMinClient) -> String? {
        #if os(macOS)
        minClient.macos
        #else
        minClient.ios
        #endif
    }

    /// The handshake for a descriptor this build cannot decode.
    /// Only `version` and `min_client` are read, the two fields every
    /// descriptor version keeps: a newer version, or a floor above this
    /// build, says update. Anything else is no workspace.
    static func asksForUpdate(_ data: Data) -> Bool {
        guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return false }
        if let version = object["version"] as? Int, version > ContractConstants.workspaceDescriptorVersion { return true }
        guard let minClient = object["min_client"] as? [String: Any] else { return false }
        #if os(macOS)
        let floor = minClient["macos"] as? String
        #else
        let floor = minClient["ios"] as? String
        #endif
        return StarlingsUpgradeRecommendation.isBelow(floor: floor)
    }

    /// The image bytes of a workspace's mark: on its own origin, PNG or SVG,
    /// no larger than the server lets an admin upload.
    static func markData(for workspace: StarlingsWorkspace, session: URLSession = .shared) async -> Data? {
        guard let value = workspace.markURL, let url = URL(string: value),
              StarlingsWorkspaceAddress.origin(of: value) == workspace.webOrigin
        else { return nil }
        var request = URLRequest(url: url, cachePolicy: .useProtocolCachePolicy, timeoutInterval: 10)
        request.httpShouldHandleCookies = false
        guard let result = try? await session.data(for: request),
              let http = result.1 as? HTTPURLResponse, http.statusCode == 200,
              let type = http.mimeType, type == "image/png" || type == "image/svg+xml",
              result.0.count <= ContractConstants.workspaceMarkMaxBytes
        else { return nil }
        return result.0
    }

    private static func canonicalOrigin(_ value: String) -> URL? {
        guard let origin = StarlingsWorkspaceAddress.origin(of: value) else { return nil }
        return StarlingsWorkspaceAddress.origin(for: origin)
    }
}

/// The current workspace, and the address signed in to it.
///
/// One per process. The workspace is kept in `UserDefaults` (no secret in
/// it) and published to `StarlingsWorkspace.active`.
@MainActor
final class StarlingsWorkspaceStore: ObservableObject {
    static let shared = StarlingsWorkspaceStore()

    @Published private(set) var current: StarlingsWorkspace
    /// The workspaces signed in to on this device, most recent first (slice
    /// G). The current workspace is always in it. The door and the
    /// switchers list these. A sign-out keeps the row, signed out, so the
    /// next sign-in is one tap; only Remove takes it off. A
    /// lookup never adds one: `enter` does, after a sign-in.
    @Published private(set) var known: [StarlingsWorkspace]
    /// The signed-in address, set where a session is applied or dropped.
    @Published var signedInAddress: String?
    /// The current workspace's mark, once read.
    @Published private(set) var markData: Data?

    private let defaults: UserDefaults

    nonisolated fileprivate static let knownKey = "meet.workspace.known"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let current = StarlingsWorkspace.restored(from: defaults)
        self.current = current
        let stored = defaults.data(forKey: Self.knownKey)
            .flatMap { try? JSONDecoder().decode([StarlingsWorkspace].self, from: $0) } ?? []
        known = Self.listing(current, in: stored.filter(\.canSignIn))
    }

    /// `workspace` first, then every other entry once.
    private static func listing(_ workspace: StarlingsWorkspace, in list: [StarlingsWorkspace]) -> [StarlingsWorkspace] {
        [workspace] + list.filter { $0.webOrigin != workspace.webOrigin }
    }

    /// The first other workspace on the list that `hasSession` says is
    /// signed in: where a sign-out of the current one moves to. Nil when
    /// none is; the app then stays on the door.
    func nextSignedIn(where hasSession: (StarlingsWorkspace) -> Bool) -> StarlingsWorkspace? {
        known.first { $0.webOrigin != current.webOrigin && hasSession($0) }
    }

    /// Remove from this device: takes a workspace that is not
    /// the current one off the list. The caller has already cleared its
    /// session and caches. The current workspace is never removed here: the
    /// caller moves to another first.
    func forget(_ workspace: StarlingsWorkspace) {
        guard workspace.webOrigin != current.webOrigin else { return }
        known.removeAll { $0.webOrigin == workspace.webOrigin }
        marks[workspace.webOrigin] = nil
        saveKnown()
    }

    private func saveKnown() {
        guard let data = try? JSONEncoder().encode(known) else { return }
        defaults.set(data, forKey: Self.knownKey)
    }

    /// Makes `workspace` this install's workspace. Only one this build can
    /// sign in to; the caller has already checked.
    func choose(_ workspace: StarlingsWorkspace) {
        guard workspace.canSignIn else { return }
        let changed = workspace.markURL != current.markURL
        let moved = workspace.webOrigin != current.webOrigin
        current = workspace
        save()
        if changed {
            markData = nil
            Task { await loadMark() }
        }
        // Everything built for the old workspace must go (slice E): the phone
        // rebuilds its root view off `current`, the Mac relaunches on this.
        if moved, self === Self.shared {
            NotificationCenter.default.post(name: StarlingsWorkspace.didChangeNotification, object: nil)
        }
    }

    /// Makes `workspace` active and says so once it is: "You're in <name>"
    ///. The Mac relaunches and the phone rebuilds on a change, so
    /// the line waits in defaults for the runtime built for `workspace`,
    /// which reads it with `takeArrival()`.
    func enter(_ workspace: StarlingsWorkspace) {
        guard workspace.canSignIn else { return }
        defaults.set(workspace.webOrigin, forKey: Self.arrivalKey)
        choose(workspace)
    }

    /// The name to announce, once, and only on the workspace it was set for.
    func takeArrival() -> String? {
        guard let origin = defaults.string(forKey: Self.arrivalKey) else { return nil }
        defaults.removeObject(forKey: Self.arrivalKey)
        return origin == current.webOrigin ? current.name : nil
    }

    private static let arrivalKey = WorkspaceOriginMove.arrivalKey

    /// Each listed workspace's mark, by web origin, once read (the switchers'
    /// rows). The current workspace's is `markData`.
    @Published private(set) var marks: [String: Data] = [:]

    /// The mark a switcher row draws for `workspace`.
    func mark(for workspace: StarlingsWorkspace) -> Data? {
        workspace.webOrigin == current.webOrigin ? markData : marks[workspace.webOrigin]
    }

    /// Reads every listed workspace's mark that is not read yet, with the
    /// same checks as the current one's (`StarlingsWorkspaceDirectory.markData`).
    func loadMarks() async {
        for workspace in known where workspace.webOrigin != current.webOrigin && marks[workspace.webOrigin] == nil {
            if let data = await StarlingsWorkspaceDirectory.markData(for: workspace) {
                marks[workspace.webOrigin] = data
            }
        }
    }

    /// The lookup a sign-in screen runs: the workspace, or the error to show.
    func lookUp(_ input: String) async throws -> StarlingsWorkspace {
        try await StarlingsWorkspaceDirectory.lookUp(input)
    }

    /// Reads the current workspace's descriptor from its API origin, the
    /// origin its session goes to, and takes the new name, mark, suite,
    /// services and identity domains. Silent:
    /// offline keeps the last answer.
    func refresh() async {
        let workspace = current
        guard let origin = URL(string: workspace.apiOrigin),
              let descriptor = try? await StarlingsWorkspaceDirectory.read(at: origin),
              let fresh = StarlingsWorkspaceDirectory.workspace(from: descriptor),
              current == workspace
        else {
            if markData == nil { await loadMark() }
            await refreshOthers()
            return
        }
        guard fresh.webOrigin == workspace.webOrigin || fresh.apiOrigin == workspace.apiOrigin else {
            // The workspace moved to a new origin and still answers on the
            // old one. When the descriptor vouches for the old host, the move
            // waits for the next launch, before any store reads its items.
            if await Self.vouches(for: workspace, descriptor: descriptor) {
                let pending = WorkspaceOriginMove.Pending(fromWeb: workspace.webOrigin, toWeb: fresh.webOrigin, toAPI: fresh.apiOrigin)
                if let data = try? JSONEncoder().encode(pending) { defaults.set(data, forKey: WorkspaceOriginMove.pendingKey) }
            }
            if markData == nil { await loadMark() }
            await refreshOthers()
            return
        }
        // The version handshake: below the floor, the update banner.
        StarlingsUpgradeRecommendation.shared.receiveFloor(
            below: StarlingsUpgradeRecommendation.isBelow(floor: StarlingsWorkspaceDirectory.floor(in: descriptor.minClient))
        )
        let hosts = await StarlingsWorkspaceDirectory.verifiedHosts(of: descriptor)
        guard current == workspace else { return }
        var updated = workspace
        updated.name = fresh.name
        updated.markURL = fresh.markURL
        updated.suite = fresh.suite
        updated.services = fresh.services
        updated.identity = fresh.identity
        updated.publicWebOrigin = fresh.publicWebOrigin
        updated.linkHosts = hosts
        updated.accentPalette = fresh.accentPalette
        if updated != current {
            current = updated
            save()
        }
        await loadMark()
        await refreshOthers()
    }

    /// True when the descriptor read at `workspace`'s origin names that
    /// origin among its verified hosts: the workspace itself moved.
    private static func vouches(for workspace: StarlingsWorkspace, descriptor: WorkspaceDescriptor) async -> Bool {
        let hosts = await StarlingsWorkspaceDirectory.verifiedHosts(of: descriptor)
        return hosts.contains(workspace.webOrigin) || hosts.contains(workspace.apiOrigin)
    }

    /// Reads each other listed workspace's descriptor, silently: its name and
    /// mark, and a new origin it moved to, which moves its items at once
    /// (no store of it is open). Offline keeps the stored entry.
    private func refreshOthers() async {
        for workspace in known where workspace.webOrigin != current.webOrigin {
            guard let origin = URL(string: workspace.apiOrigin),
                  let descriptor = try? await StarlingsWorkspaceDirectory.read(at: origin),
                  let fresh = StarlingsWorkspaceDirectory.workspace(from: descriptor)
            else { continue }
            var updated = workspace
            if fresh.webOrigin != workspace.webOrigin, fresh.apiOrigin != workspace.apiOrigin {
                guard await Self.vouches(for: workspace, descriptor: descriptor),
                      WorkspaceOriginMove.move(
                          from: (workspace.webOrigin, workspace.apiOrigin),
                          to: (fresh.webOrigin, fresh.apiOrigin),
                          defaults: defaults
                      )
                else { continue }
                updated.webOrigin = fresh.webOrigin
                updated.apiOrigin = fresh.apiOrigin
            }
            updated.name = fresh.name
            updated.markURL = fresh.markURL
            updated.publicWebOrigin = fresh.publicWebOrigin
            guard updated != workspace, let index = known.firstIndex(where: { $0.webOrigin == workspace.webOrigin }),
                  updated.webOrigin != current.webOrigin
            else { continue }
            known[index] = updated
            if updated.webOrigin != workspace.webOrigin { marks[workspace.webOrigin] = nil }
            saveKnown()
        }
    }

    private func loadMark() async {
        let workspace = current
        let data = await StarlingsWorkspaceDirectory.markData(for: workspace)
        guard current == workspace else { return }
        markData = data
    }

    /// Keeps the workspace and, for the shared store, makes it the active one.
    private func save() {
        if self === Self.shared {
            StarlingsWorkspace.setActive(current)
            StarlingsLanguageLaunch.writeOverride(StarlingsLanguageCache.load(), defaults: .standard)
        }
        known = Self.listing(current, in: known)
        saveKnown()
        guard let data = try? JSONEncoder().encode(current) else { return }
        defaults.set(data, forKey: StarlingsWorkspace.storageKey)
    }
}
