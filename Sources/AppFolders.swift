import Foundation

/// The folders the apps write under the person's Library, named once
///. Since the Starlings release the two Mac folders are one,
/// `~/Library/Application Support/Starlings/`: the CLI socket, the
/// diagnostics, the transcript outbox, ambient captures, the custom
/// background and the update log. The spike reports go to
/// `~/Library/Logs/Starlings/`. On iOS the same name sits inside the app's own
/// container.
///
/// The names before the rename are here only for the moves that carry old
/// data across: `AppFolderMigration` and `SandboxMigration` (Mac).
enum AppFolders {
    /// `Starlings`, under Application Support and under Logs.
    static let name = ContractConstants.nativeAppName
    /// The Application Support folders of the builds before the rename.
    /// They held different files, so both empty into `name`.
    static let legacySupportNames = ["Envisioning Meet", "Meet"]
    /// The Logs folder of the builds before the rename.
    static let legacyLogsName = "Meet"
    /// The CLI socket, in `support`.
    static let socketName = "starlings.sock"

    /// `<Application Support>/Starlings`. Nothing here creates it.
    static var support: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return base.appendingPathComponent(name, isDirectory: true)
    }

    #if os(macOS)
    /// `~/Library/Logs/Starlings`. Nothing here creates it.
    static var logs: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs", isDirectory: true)
            .appendingPathComponent(name, isDirectory: true)
    }
    #endif
}
