import CryptoKit
import Foundation
import Security

/// What one workspace's state on this device is filed under: Keychain
/// accounts, defaults keys and cache folders (docs/CENTRAL_AUTH.md
/// §Security rules). Keyed by the workspace's web origin, so two workspaces
/// on one install never read each other's session, token, cache or queue.
///
/// Items written before the scope existed carry no origin. Each store adopts
/// them once, into the scope whose API they were minted for, so a current
/// member upgrades without signing in again.
struct WorkspaceScope: Equatable, Sendable {
    /// The workspace's web origin; every key below ends with it.
    let webOrigin: String
    /// `<apiOrigin>/api`: the stamp that items written before the scope carry.
    let apiEndpoint: String
    /// The build's own workspace: the only one items without a stamp can
    /// belong to, and the one that inherits this install's device id.
    let isBuiltIn: Bool

    init(_ workspace: StarlingsWorkspace) {
        webOrigin = workspace.webOrigin
        apiEndpoint = workspace.apiBaseURL.absoluteString
        isBuiltIn = workspace.isBuiltIn
    }

    /// The active workspace's scope (`StarlingsWorkspace.active`).
    static var active: WorkspaceScope { WorkspaceScope(.active) }

    /// `<name>@<webOrigin>`.
    func keychainAccount(_ name: String) -> String { "\(name)@\(webOrigin)" }

    /// `<name>@<webOrigin>`.
    func defaultsKey(_ name: String) -> String { "\(name)@\(webOrigin)" }

    /// A folder name for this workspace under a cache or support folder. The
    /// origin itself carries `:` and `/`, so the name is a digest of it.
    var folderName: String { Self.folderName(webOrigin: webOrigin) }

    static func folderName(webOrigin: String) -> String {
        SHA256.hash(data: Data(webOrigin.utf8)).prefix(12).map { String(format: "%02x", $0) }.joined()
    }

    /// `base/<folderName>/`, created.
    func directory(in base: URL) -> URL {
        let directory = base.appendingPathComponent(folderName, isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }
}

/// The generic-password calls every Meet Keychain item makes. App-private
/// items, never in a shared access group.
enum StarlingsKeychain {
    struct Failure: Error, Equatable {
        let status: OSStatus
    }

    static func read(service: String, account: String) throws -> Data? {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw Failure(status: status) }
        return data
    }

    /// Replaces the item, or adds it. Readable after the first unlock and
    /// never in a backup: a phone keeps hosting behind the lock screen and
    /// must be able to write a renewed pair there, and a restore onto
    /// another device starts signed out. The phone sets the class on update
    /// too, so an item saved before this rule moves to it on its next save.
    static func write(_ data: Data, service: String, account: String) throws {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
        ]
        var attributes: [CFString: Any] = [kSecValueData: data]
        #if os(iOS)
        attributes[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        #endif
        let update = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if update == errSecItemNotFound {
            var insertion = query
            insertion[kSecValueData] = data
            insertion[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let add = SecItemAdd(insertion as CFDictionary, nil)
            guard add == errSecSuccess else { throw Failure(status: add) }
        } else if update != errSecSuccess {
            throw Failure(status: update)
        }
    }

    /// Every generic-password item whose account ends with `suffix`, by
    /// service and account. Attributes only: no item's data is read.
    static func accounts(endingWith suffix: String) throws -> [(service: String, account: String)] {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecMatchLimit: kSecMatchLimitAll,
            kSecReturnAttributes: true,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return [] }
        guard status == errSecSuccess, let rows = result as? [[String: Any]] else { throw Failure(status: status) }
        return rows.compactMap { row in
            guard let account = row[kSecAttrAccount as String] as? String, account.hasSuffix(suffix),
                  let service = row[kSecAttrService as String] as? String
            else { return nil }
            return (service, account)
        }
    }

    static func delete(service: String, account: String) throws {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw Failure(status: status) }
    }

    /// The item at `account`. When there is none, the first item at one of
    /// `legacyAccounts` that `adopt` accepts moves to `account` and leaves
    /// its old place: the one-time move into a workspace scope. An item
    /// `adopt` refuses belongs to another build or workspace and stays.
    static func readScoped(
        service: String,
        account: String,
        legacyAccounts: [String],
        adopt: (Data) -> Bool
    ) throws -> Data? {
        if let data = try read(service: service, account: account) { return data }
        for legacy in legacyAccounts {
            guard let data = try read(service: service, account: legacy), adopt(data) else { continue }
            try write(data, service: service, account: account)
            try delete(service: service, account: legacy)
            return data
        }
        return nil
    }

    /// This device's id for one workspace, read or minted and kept. The
    /// Worker rotates refresh tokens per device, so the id keeps a sign-in
    /// here from spending another device's token. One id per workspace, so
    /// two workspaces cannot match this device by it. The build's own
    /// workspace takes the id this install already had, which stays where it
    /// was for the other build (Debug or Release) on the same device. Never
    /// throws: a Keychain that refuses costs one fresh id per launch, which
    /// the Worker treats as a new device.
    static func deviceID(service: String, scope: WorkspaceScope) -> String {
        let account = scope.keychainAccount(legacyDeviceAccount)
        if let stored = (try? read(service: service, account: account)).flatMap(nonEmptyString) {
            return stored
        }
        let inherited = scope.isBuiltIn
            ? (try? read(service: service, account: legacyDeviceAccount)).flatMap(nonEmptyString)
            : nil
        let id = inherited ?? UUID().uuidString.lowercased()
        try? write(Data(id.utf8), service: service, account: account)
        return id
    }

    /// The one device id every workspace shared before the scope.
    private static let legacyDeviceAccount = "device-id"

    private static func nonEmptyString(_ data: Data?) -> String? {
        guard let data, let value = String(data: data, encoding: .utf8), !value.isEmpty else { return nil }
        return value
    }
}

/// A credential stamped with the Meet API that minted it: the owner
/// session and the Core, Docs and Keep tokens.
protocol WorkspaceStampedCredential: Codable, Sendable {
    var apiEndpoint: String? { get }
}

/// One workspace's Keychain item for a stamped credential. A credential
/// stamped for another API is not this workspace's and is dropped on read
/// rather than presented to the wrong server.
struct WorkspaceCredentialKeychain<Credential: WorkspaceStampedCredential>: Sendable {
    let service: String
    /// The account under the scope: `<name>@<webOrigin>`.
    let account: String
    /// Where this credential lived before the scope, adopted once when its
    /// stamp is this API's or absent.
    let legacyAccounts: [String]
    /// The API this credential is for.
    let apiEndpoint: String

    init(service: String, name: String, legacyAccounts: [String], apiEndpoint: String, scope: WorkspaceScope) {
        self.service = service
        account = scope.keychainAccount(name)
        self.legacyAccounts = legacyAccounts
        self.apiEndpoint = apiEndpoint
    }

    /// Keychain failures throw `StarlingsKeychain.Failure`; a stored item that
    /// does not decode throws its decoding error.
    func load() throws -> Credential? {
        let data = try StarlingsKeychain.readScoped(service: service, account: account, legacyAccounts: legacyAccounts) { data in
            guard let legacy = try? JSONDecoder().decode(Credential.self, from: data) else { return false }
            return legacy.apiEndpoint == nil || legacy.apiEndpoint == apiEndpoint
        }
        guard let data else { return nil }
        let credential = try JSONDecoder().decode(Credential.self, from: data)
        if let stamped = credential.apiEndpoint, stamped != apiEndpoint {
            try clear()
            return nil
        }
        return credential
    }

    func save(_ credential: Credential) throws {
        try StarlingsKeychain.write(try JSONEncoder().encode(credential), service: service, account: account)
    }

    func clear() throws {
        try StarlingsKeychain.delete(service: service, account: account)
    }
}

/// A workspace that moved to a new web origin (Envisioning, from
/// a legacy alias to `the built-in workspace's host`). Everything
/// this device filed under the old origin moves to the new one, so the member
/// stays signed in and nothing is kept under the old address (MZ, 2026-10-20):
/// Keychain items (`<name>@<origin>`, with each stamped credential's
/// `apiEndpoint` rewritten), defaults keys, the scoped cache and support
/// folders, and unsent Quick Notes. A session token names no host, so one
/// minted through the old origin renews at the new one.
///
/// Copies come first; the old items go only after every copy succeeded. A
/// failure leaves the old items and the move runs again on the next launch.
enum WorkspaceOriginMove {
    /// Hosts the Worker still serves for the build's own workspace. A stored
    /// entry on one of them moves to the build's origins at launch.
    static let builtInAliasHosts = ContractConstants.legacyAliasHosts

    /// A move the current workspace's descriptor asked for, applied at the
    /// next launch, before any store reads (`pendingKey`).
    struct Pending: Codable, Equatable, Sendable {
        let fromWeb: String
        let toWeb: String
        let toAPI: String
    }

    static let pendingKey = "meet.workspace.pendingMove"

    static func markerKey(fromWeb: String) -> String { "meet.workspace.migrated.\(fromWeb)" }

    /// Moves every item filed under `from` to `to`. True when done, now or on
    /// an earlier launch.
    @discardableResult
    static func move(
        from: (web: String, api: String),
        to: (web: String, api: String),
        defaults: UserDefaults,
        fileManager: FileManager = .default
    ) -> Bool {
        guard from.web != to.web else { return true }
        let marker = markerKey(fromWeb: from.web)
        if defaults.bool(forKey: marker) { return true }
        let oldEndpoint = endpoint(from.api)
        let newEndpoint = endpoint(to.api)
        let replacements = [oldEndpoint: newEndpoint, from.web: to.web, from.api: to.api]
        var emails = Set<String>()

        // Keychain: copy every item, then delete the old ones.
        let oldSuffix = "@\(from.web)"
        guard let items = try? StarlingsKeychain.accounts(endingWith: oldSuffix) else { return false }
        for item in items {
            let newAccount = String(item.account.dropLast(oldSuffix.count)) + "@\(to.web)"
            guard let data = try? StarlingsKeychain.read(service: item.service, account: item.account) else { return false }
            let moved = rewritten(data, replacing: replacements, emails: &emails)
            // An item already under the new origin is newer: keep it.
            if (try? StarlingsKeychain.read(service: item.service, account: newAccount)) == nil {
                guard (try? StarlingsKeychain.write(moved, service: item.service, account: newAccount)) != nil else { return false }
            }
        }
        for item in items {
            try? StarlingsKeychain.delete(service: item.service, account: item.account)
        }

        // Defaults keyed by origin (`WorkspaceScope.defaultsKey`), and the
        // legacy keys stamped with the API endpoint.
        for (fromSuffix, toSuffix) in [(oldSuffix, "@\(to.web)"), ("@\(oldEndpoint)", "@\(newEndpoint)")] {
            for (key, value) in defaults.dictionaryRepresentation() where key.hasSuffix(fromSuffix) {
                let newKey = String(key.dropLast(fromSuffix.count)) + toSuffix
                if defaults.object(forKey: newKey) == nil { defaults.set(value, forKey: newKey) }
                defaults.removeObject(forKey: key)
            }
        }

        // Folders named by a digest of the origin (`WorkspaceScope.directory`).
        let oldFolder = WorkspaceScope.folderName(webOrigin: from.web)
        let newFolder = WorkspaceScope.folderName(webOrigin: to.web)
        for base in scopedBases(fileManager) {
            rename(base.appendingPathComponent(oldFolder, isDirectory: true), to: base.appendingPathComponent(newFolder, isDirectory: true), fileManager)
        }

        // Unsent Quick Notes: one file per `<email>@<webOrigin>`. The emails
        // come from the credentials just moved.
        let notes = QuickNoteOutbox.folder(in: AppFolders.support)
        for email in emails {
            rename(
                notes.appendingPathComponent(QuickNoteOutbox.fileName(owner: "\(email)@\(from.web)")),
                to: notes.appendingPathComponent(QuickNoteOutbox.fileName(owner: "\(email)@\(to.web)")),
                fileManager
            )
        }

        defaults.set(true, forKey: marker)
        return true
    }

    /// `<apiOrigin>/api`, as `StarlingsWorkspace.apiBaseURL` spells it.
    private static func endpoint(_ apiOrigin: String) -> String {
        URL(string: apiOrigin).map { $0.appending(path: "api").absoluteString } ?? "\(apiOrigin)/api"
    }

    /// The folders that hold one subfolder per workspace: the snapshot and
    /// calendar caches, and the two support folders.
    private static func scopedBases(_ fileManager: FileManager) -> [URL] {
        var bases: [URL] = [AppFolders.support]
        if let caches = fileManager.urls(for: .cachesDirectory, in: .userDomainMask).first {
            bases.append(caches.appendingPathComponent("MeetSnapshots", isDirectory: true))
            bases.append(caches.appendingPathComponent("StarlingsCalendar", isDirectory: true))
        }
        if let support = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first {
            bases.append(support)
        }
        return bases
    }

    /// Moves `old` to `new` when only `old` exists. When both exist the new
    /// one is kept and the old one stays, so nothing is lost.
    private static func rename(_ old: URL, to new: URL, _ fileManager: FileManager) {
        guard fileManager.fileExists(atPath: old.path), !fileManager.fileExists(atPath: new.path) else { return }
        try? fileManager.moveItem(at: old, to: new)
    }

    /// The item with each string equal to a key of `replacing` swapped for its
    /// value, and every address it holds added to `emails`. An item that is
    /// not a JSON object or array (a device id) is returned as it is.
    static func rewritten(_ data: Data, replacing: [String: String], emails: inout Set<String>) -> Data {
        guard let object = try? JSONSerialization.jsonObject(with: data),
              object is [String: Any] || object is [Any]
        else { return data }
        func walk(_ value: Any) -> Any {
            switch value {
            case let string as String:
                if string.contains("@"), !string.contains("/"), !string.contains(":"), !string.contains(" ") {
                    emails.insert(string.lowercased())
                }
                return replacing[string] ?? string
            case let dictionary as [String: Any]:
                return dictionary.mapValues(walk)
            case let array as [Any]:
                return array.map(walk)
            default:
                return value
            }
        }
        return (try? JSONSerialization.data(withJSONObject: walk(object))) ?? data
    }

    /// Runs at launch, before the current and known workspaces are read: an
    /// entry on one of `builtInAliasHosts` moves to the build's own origins,
    /// and a move the descriptor asked for (`pendingKey`) is applied. The
    /// stored entries are rewritten only after their items moved.
    static func migrateStoredWorkspaces(defaults: UserDefaults, currentKey: String, knownKey: String) {
        let builtIn = StarlingsWorkspace.builtIn
        var moves: [String: (web: String, api: String)] = [:]
        // A Debug build's own workspace is local: never move a Release entry there.
        if builtIn.webOrigin.hasPrefix("https://") {
            for host in builtInAliasHosts { moves["https://\(host)"] = (builtIn.webOrigin, builtIn.apiOrigin) }
        }
        let pending = defaults.data(forKey: pendingKey).flatMap { try? JSONDecoder().decode(Pending.self, from: $0) }
        if let pending { moves[pending.fromWeb] = (pending.toWeb, pending.toAPI) }

        var current = defaults.data(forKey: currentKey).flatMap { try? JSONDecoder().decode(StarlingsWorkspace.self, from: $0) }
        var known = defaults.data(forKey: knownKey).flatMap { try? JSONDecoder().decode([StarlingsWorkspace].self, from: $0) } ?? []
        func target(of workspace: StarlingsWorkspace) -> (from: String, to: (web: String, api: String))? {
            if let to = moves[workspace.webOrigin] { return (workspace.webOrigin, to) }
            if let host = URL(string: workspace.apiOrigin)?.host, builtInAliasHosts.contains(host),
               let to = moves["https://\(host)"] { return (workspace.webOrigin, to) }
            return nil
        }
        func moved(_ workspace: StarlingsWorkspace) -> StarlingsWorkspace? {
            guard let target = target(of: workspace),
                  move(from: (workspace.webOrigin, workspace.apiOrigin), to: target.to, defaults: defaults)
            else { return nil }
            var updated = workspace
            updated.webOrigin = target.to.web
            updated.apiOrigin = target.to.api
            return updated
        }
        var changed = false
        if let entry = current, let updated = moved(entry) {
            current = updated
            changed = true
        }
        for index in known.indices {
            if let updated = moved(known[index]) {
                known[index] = updated
                changed = true
            }
        }
        if let pending, current?.webOrigin != pending.fromWeb, !known.contains(where: { $0.webOrigin == pending.fromWeb }) {
            defaults.removeObject(forKey: pendingKey)
        }
        guard changed else { return }
        // Two entries that now share an origin are one workspace.
        var seen = Set<String>()
        known = known.filter { seen.insert($0.webOrigin).inserted }
        if let current, let data = try? JSONEncoder().encode(current) { defaults.set(data, forKey: currentKey) }
        if let data = try? JSONEncoder().encode(known) { defaults.set(data, forKey: knownKey) }
        if let arrival = defaults.string(forKey: arrivalKey), let to = moves[arrival] { defaults.set(to.web, forKey: arrivalKey) }
    }

    /// `StarlingsWorkspaceStore.arrivalKey`: an origin, moved with the rest.
    static let arrivalKey = "meet.workspace.arrival"
}
