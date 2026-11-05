import Foundation

/// Which workspace a room or invite link belongs to (slice F;
/// docs/CENTRAL_AUTH.md). A link names its workspace by its host. The apps
/// open a link only under the workspace that owns its host: a link for
/// another workspace offers that workspace, and is carried across the
/// change of workspace that follows.
enum StarlingsWorkspaceLink {
    enum Resolution: Equatable, Sendable {
        /// A typed room, or a link on one of the active workspace's hosts.
        case active
        /// A link for another workspace, read from that host's descriptor.
        case other(StarlingsWorkspace)
        /// A link on a host that names no workspace this build can open.
        case unknown
    }

    /// The `scheme://host[:port]` a pasted or opened link names, or nil for
    /// typed text with no scheme (a room name, or a `/room/<slug>` path).
    static func origin(of input: String) -> String? {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed),
              let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              url.host?.isEmpty == false
        else { return nil }
        return StarlingsWorkspaceAddress.origin(of: trimmed)
    }

    /// True when `input` is typed text, or a link on a host of `workspace`
    /// (the active one by default). Synchronous: nothing is read from the
    /// network.
    static func isActive(_ input: String, in workspace: StarlingsWorkspace = .active) -> Bool {
        guard let origin = origin(of: input) else { return true }
        return workspace.owns(origin: origin)
    }

    /// Where a link belongs. A foreign host is trusted only through its own
    /// descriptor, by the same rule as a typed workspace address.
    static func resolve(_ input: String) async -> Resolution {
        guard let origin = origin(of: input) else { return .active }
        let active = StarlingsWorkspace.active
        if active.owns(origin: origin) { return .active }
        guard let found = try? await StarlingsWorkspaceDirectory.lookUp(origin), found.canSignIn else { return .unknown }
        return found.webOrigin == active.webOrigin ? .active : .other(found)
    }

    // MARK: Across a change of workspace

    private static let pendingKey = "meet.workspace.pendingLink"

    private struct Pending: Codable {
        let link: String
        let webOrigin: String
    }

    /// Keeps `link` for the first launch or rebuild on `workspace`. The Mac
    /// relaunches and the phone rebuilds its root view on a change, so the
    /// link cannot stay in memory.
    static func carry(_ link: String, to workspace: StarlingsWorkspace, defaults: UserDefaults = .standard) {
        guard let data = try? JSONEncoder().encode(Pending(link: link, webOrigin: workspace.webOrigin)) else { return }
        defaults.set(data, forKey: pendingKey)
    }

    /// The carried link, once, and only on the workspace it was carried to.
    static func takeCarried(defaults: UserDefaults = .standard) -> String? {
        guard let data = defaults.data(forKey: pendingKey) else { return nil }
        defaults.removeObject(forKey: pendingKey)
        guard let pending = try? JSONDecoder().decode(Pending.self, from: data),
              pending.webOrigin == StarlingsWorkspace.active.webOrigin
        else { return nil }
        return pending.link
    }
}

extension StarlingsWorkspace {
    /// True when `origin` is one of this workspace's own hosts: its web or API
    /// origin, or a host confirmed to serve it (`linkHosts`). The build's own
    /// workspace also owns the hosts the build names for it
    /// (`PUBLIC_WEB_ORIGIN`, `SERVED_WEB_ORIGIN`).
    func owns(origin: String) -> Bool {
        guard let origin = Self.comparable(origin) else { return false }
        var hosts = [webOrigin, apiOrigin] + (linkHosts ?? [])
        if isBuiltIn { hosts += [ContractConstants.publicWebOrigin, ContractConstants.servedWebOrigin] }
        return hosts.compactMap(Self.comparable).contains(origin)
    }

    /// `scheme://host[:port]`. Debug reads the loopback names as one host,
    /// so a local link on `localhost` matches a stack on `127.0.0.1`.
    private static func comparable(_ value: String) -> String? {
        guard let origin = StarlingsWorkspaceAddress.origin(of: value) else { return nil }
        #if DEBUG
        for loopback in ["://localhost", "://[::1]"] where origin.contains(loopback) {
            return origin.replacingOccurrences(of: loopback, with: "://127.0.0.1")
        }
        #endif
        return origin
    }
}
