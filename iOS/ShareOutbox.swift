import Foundation

/// A page shared to Starlings from Safari or another app (the share
/// extension, docs/DOCS.md, link saves).
///
/// The extension has no session, and gets none: the owner token is
/// app-private (`StarlingsKeychain`), and the App Group never holds it. So the
/// extension only writes the page here, one JSON file each, and the app
/// saves it through the Worker's link save the next time it is active
/// (`StarlingsAppModel.drainShareOutbox`). The page's HTML rides along, so the
/// Worker reads the article as Safari drew it, as the web's bookmarklet does.
struct ShareOutboxItem: Codable, Equatable, Identifiable, Sendable {
    var id: UUID
    var createdAt: Date
    /// The workspace the person saw named when they saved. The app files the
    /// page there, and waits while another workspace is active.
    var workspaceOrigin: String
    var url: String
    var title: String?
    var note: String
    var pageHTML: String?
}

/// The workspace the app is signed in to, as the extension names it. No
/// secret: an address and a name.
struct ShareWorkspace: Codable, Equatable, Sendable {
    var webOrigin: String
    var name: String
}

enum ShareOutbox {
    /// `web/src/page-capture.ts` sends the same: the Worker refuses more
    /// (`DOCS_PAGE_HTML_MAX_CHARS`), and the save then reads the page itself.
    static let pageHTMLMaxCharacters = 2_000_000

    /// The App Group every target's entitlements name (project.yml); the
    /// same value as `WatchBridgeSnapshot.appGroup`, which the extension does
    /// not compile.
    static let appGroup = ContractConstants.nativeAppGroup

    private static let workspaceKey = "share.workspace"

    private static var defaults: UserDefaults? {
        UserDefaults(suiteName: appGroup)
    }

    private static var directory: URL? {
        FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: appGroup)?
            .appendingPathComponent("ShareOutbox", isDirectory: true)
    }

    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()

    private static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()

    // MARK: The workspace

    /// The app says where a share goes; nil when it is signed out.
    static func publish(_ workspace: ShareWorkspace?) {
        guard let defaults else { return }
        if let workspace, let data = try? encoder.encode(workspace) {
            defaults.set(data, forKey: workspaceKey)
        } else {
            defaults.removeObject(forKey: workspaceKey)
        }
    }

    static func workspace() -> ShareWorkspace? {
        defaults?.data(forKey: workspaceKey).flatMap { try? decoder.decode(ShareWorkspace.self, from: $0) }
    }

    // MARK: The pages

    static func write(_ item: ShareOutboxItem) throws {
        guard let directory else { throw CocoaError(.fileNoSuchFile) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try encoder.encode(item).write(
            to: directory.appendingPathComponent("\(item.id.uuidString).json"),
            options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
        )
    }

    /// Every page waiting, oldest first. A file that no longer reads is
    /// removed: it would wait forever.
    static func pending() -> [ShareOutboxItem] {
        guard let directory,
              let files = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        else { return [] }
        var items: [ShareOutboxItem] = []
        for file in files where file.pathExtension == "json" {
            if let data = try? Data(contentsOf: file), let item = try? decoder.decode(ShareOutboxItem.self, from: data) {
                items.append(item)
            } else {
                try? FileManager.default.removeItem(at: file)
            }
        }
        return items.sorted { $0.createdAt < $1.createdAt }
    }

    static func remove(_ id: UUID) {
        guard let directory else { return }
        try? FileManager.default.removeItem(at: directory.appendingPathComponent("\(id.uuidString).json"))
    }
}
