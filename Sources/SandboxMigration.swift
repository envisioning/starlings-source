import Foundation

/// Meet stopped being App Sandboxed in 3.8.3. A sandboxed app's files live in
/// its container; an unsandboxed one reads the home directory. Without this,
/// the first launch after the change would come up with no settings, no
/// pending outbox, no captures, and re-download half a gigabyte of speech
/// models. Runs once, before anything reads a default or a file; moves
/// (same volume) rather than copies; never overwrites what the home already
/// has; leaves the container in place for a rollback.
///
/// The container is the one of the build before the rename, and
/// its folders go straight to their Starlings names (,
/// `AppFolderMigration`). A Mac that ran this move as Meet has the done flag
/// in Meet's defaults, not in Starlings', so that flag counts too: without it
/// the first Starlings launch would copy 3.8.3's settings over fresh ones.
enum SandboxMigration {
    private static let doneKey = "meet.sandboxMigration.done"
    /// The bundle ID of the app before the rename: its container and its
    /// defaults domain. The one place the old bundle ID is written in Swift.
    static let legacyBundle = "com.envisioning.meet"

    static func runIfNeeded() {
        let defaults = UserDefaults.standard
        guard !defaults.bool(forKey: doneKey) else { return }
        if UserDefaults(suiteName: legacyBundle)?.bool(forKey: doneKey) == true {
            defaults.set(true, forKey: doneKey)
            return
        }
        // Not sandboxed now; if this process somehow still is, there is
        // nothing to migrate from.
        guard ProcessInfo.processInfo.environment["APP_SANDBOX_CONTAINER_ID"] == nil else { return }
        let home = FileManager.default.homeDirectoryForCurrentUser
        let container = home.appendingPathComponent("Library/Containers/\(legacyBundle)/Data", isDirectory: true)
        guard FileManager.default.fileExists(atPath: container.path) else {
            defaults.set(true, forKey: doneKey)
            return
        }

        // Settings: the container's plist read as a dictionary and written
        // key by key, because cfprefsd will not notice a copied file.
        let plist = container.appendingPathComponent("Library/Preferences/\(legacyBundle).plist")
        if let data = try? Data(contentsOf: plist),
           let stored = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any] {
            for (key, value) in stored where defaults.object(forKey: key) == nil {
                defaults.set(value, forKey: key)
            }
        }

        // Files: everything under the container's Application Support that
        // is ours, moved beside where the unsandboxed app now looks. The two
        // app folders go into Starlings/ by copy, compare, remove.
        let fromSupport = container.appendingPathComponent("Library/Application Support", isDirectory: true)
        let toSupport = home.appendingPathComponent("Library/Application Support", isDirectory: true)
        for name in AppFolders.legacySupportNames {
            AppFolderMigration.move(contentsOf: fromSupport.appendingPathComponent(name, isDirectory: true), into: AppFolders.support)
        }
        for name in ["FluidAudio", "crm-cache-v2.store", "crm-cache-v2.store-shm", "crm-cache-v2.store-wal"] {
            let source = fromSupport.appendingPathComponent(name)
            let target = toSupport.appendingPathComponent(name)
            guard FileManager.default.fileExists(atPath: source.path), !FileManager.default.fileExists(atPath: target.path) else { continue }
            try? FileManager.default.createDirectory(at: toSupport, withIntermediateDirectories: true)
            do {
                try FileManager.default.moveItem(at: source, to: target)
            } catch {
                NSLog("sandbox migration: couldn’t move %@: %@", name, error.localizedDescription)
            }
        }
        // Logs the spikes wrote, for the record.
        let fromLogs = container.appendingPathComponent("Library/Logs", isDirectory: true)
            .appendingPathComponent(AppFolders.legacyLogsName, isDirectory: true)
        AppFolderMigration.move(contentsOf: fromLogs, into: AppFolders.logs)
        defaults.set(true, forKey: doneKey)
        NSLog("sandbox migration: done")
    }
}
