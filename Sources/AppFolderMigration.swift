import AppKit
import Foundation

/// The one-time move of the Mac folders to their Starlings names.
///
/// Runs at launch, after `SandboxMigration` and before anything reads a file.
/// It empties `Envisioning Meet/` and `Meet/` under Application Support into
/// `Starlings/`, and `~/Library/Logs/Meet/` into `~/Library/Logs/Starlings/`,
/// one item at a time:
///
/// - an item the new folder already has stays where it is, and so does the
///   old folder;
/// - otherwise the item is copied, the copy is compared with the original,
///   and only then is the original removed. The transcript outbox and the
///   ambient captures hold work the server has not seen yet, so on any
///   failure the original stays, only the incomplete copy goes, and the next
///   launch tries again;
/// - a socket is the CLI endpoint of an app that is not running, not data, and
///   is removed; the app makes a new one in `Starlings/`;
/// - an old folder left empty is removed.
///
/// It does nothing while Meet.app (the build before the rename) runs, since
/// that app still writes these folders.
enum AppFolderMigration {
    static func runIfNeeded() {
        guard NSRunningApplication.runningApplications(withBundleIdentifier: SandboxMigration.legacyBundle).isEmpty else {
            NSLog("folder migration: Meet is running; the folders move at the next launch")
            return
        }
        let supportBase = AppFolders.support.deletingLastPathComponent()
        for name in AppFolders.legacySupportNames {
            move(contentsOf: supportBase.appendingPathComponent(name, isDirectory: true), into: AppFolders.support)
        }
        let logsBase = AppFolders.logs.deletingLastPathComponent()
        move(contentsOf: logsBase.appendingPathComponent(AppFolders.legacyLogsName, isDirectory: true), into: AppFolders.logs)
    }

    /// Moves every item of `old` into `new` by copy, compare, remove. Never
    /// removes an original whose copy did not compare equal.
    static func move(contentsOf old: URL, into new: URL) {
        let manager = FileManager.default
        var isDirectory: ObjCBool = false
        guard manager.fileExists(atPath: old.path, isDirectory: &isDirectory), isDirectory.boolValue else { return }
        // The names differ ("Meet" and "Starlings"), so on a case-insensitive
        // volume too `old` is never `new`. Checked anyway: a move into itself
        // would remove what it copied.
        guard old.standardizedFileURL.path.lowercased() != new.standardizedFileURL.path.lowercased() else { return }

        let items: [URL]
        do {
            items = try manager.contentsOfDirectory(at: old, includingPropertiesForKeys: [.fileResourceTypeKey])
            try manager.createDirectory(at: new, withIntermediateDirectories: true)
        } catch {
            NSLog("folder migration: kept %@: %@", old.lastPathComponent, error.localizedDescription)
            return
        }

        for item in items {
            let name = item.lastPathComponent
            let target = new.appendingPathComponent(name)
            if (try? item.resourceValues(forKeys: [.fileResourceTypeKey]))?.fileResourceType == .socket || name == ".DS_Store" {
                try? manager.removeItem(at: item)
                continue
            }
            // `fileExists` follows links; a dangling link at the target is
            // still something there.
            if manager.fileExists(atPath: target.path) || (try? manager.destinationOfSymbolicLink(atPath: target.path)) != nil {
                NSLog("folder migration: kept %@/%@: %@ already has one", old.lastPathComponent, name, new.lastPathComponent)
                continue
            }
            do {
                try manager.copyItem(at: item, to: target)
            } catch {
                // Nothing was at `target` before the copy, so whatever is
                // there now is the incomplete copy.
                try? manager.removeItem(at: target)
                NSLog("folder migration: kept %@/%@: the copy failed: %@", old.lastPathComponent, name, error.localizedDescription)
                continue
            }
            guard manager.contentsEqual(atPath: item.path, andPath: target.path) else {
                try? manager.removeItem(at: target)
                NSLog("folder migration: kept %@/%@: the copy differs from the original", old.lastPathComponent, name)
                continue
            }
            do {
                try manager.removeItem(at: item)
            } catch {
                // The copy is whole; the original stays beside it.
                NSLog("folder migration: copied %@/%@ but could not remove the original: %@", old.lastPathComponent, name, error.localizedDescription)
            }
        }

        if let left = try? manager.contentsOfDirectory(atPath: old.path), left.isEmpty {
            try? manager.removeItem(at: old)
        }
    }
}
