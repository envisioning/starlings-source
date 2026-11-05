import Foundation

/// What a sign-out leaves on this device (slice G;
/// docs/CENTRAL_AUTH.md). Signing out of one workspace clears that
/// workspace's caches only: another signed-in workspace keeps its own. A
/// sign-out of every workspace clears them all. Both apps call this after
/// they clear the session; each clears its own Keychain item.
///
/// A sign-out keeps the workspace on the list, signed out; Remove takes it
/// off.
enum WorkspaceSignOut {
    static func purgeLocalData(allWorkspaces: Bool) {
        if allWorkspaces {
            CalendarEventCache.purgeEveryWorkspace()
            SnapshotStore.purgeEveryWorkspace()
            SearchRecents.purgeAll()
        } else {
            purgeLocalData(of: .active)
        }
    }

    /// One workspace's caches: the current one, or another on the list.
    static func purgeLocalData(of scope: WorkspaceScope) {
        // The cached week belongs to whoever just left. The next owner
        // starts on an empty grid, not on someone else's calendar.
        CalendarEventCache.purge(scope: scope)
        SnapshotStore.purgeAll(scope: scope)
        SearchRecents.purge(scope: scope)
    }

    /// After a sign-out of the active workspace: the next signed-in
    /// workspace on the list becomes active. With none, nothing moves and
    /// the app stays on the door, which lists every row. Choosing it
    /// relaunches the Mac and rebuilds the phone (slice E).
    @MainActor
    static func moveToNextWorkspace(hasSession: (StarlingsWorkspace) -> Bool) {
        let store = StarlingsWorkspaceStore.shared
        guard let next = store.nextSignedIn(where: hasSession) else { return }
        store.choose(next)
    }
}
