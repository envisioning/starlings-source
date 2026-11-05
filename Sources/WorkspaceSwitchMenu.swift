import AppKit

/// The app menu's Switch Workspace submenu (slice G): every
/// workspace signed in to on this Mac, the active one checked, then Add
/// Workspace. Each row shows the workspace's mark, name, address and the
/// account signed in to it, or Signed out. Refilled
/// each time it opens. A switch relaunches the app on the chosen workspace
/// (slice E), which then says "You're in <name>"; a signed-out row signs in
/// first. During a call the items are off.
@MainActor
final class WorkspaceSwitchMenuController: NSObject, NSMenuDelegate, NSMenuItemValidation {
    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let store = StarlingsWorkspaceStore.shared
        for workspace in store.known {
            let item = NSMenuItem(title: workspace.name, action: #selector(switchTo(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = workspace.webOrigin
            item.state = workspace.webOrigin == store.current.webOrigin ? .on : .off
            item.image = StarlingsWorkspaceMarkView.image(workspace: workspace, data: store.mark(for: workspace), size: 16)
            let detail = workspace.rowDetail(email: WorkspaceAccounts.email(workspace), saysSignedOut: true)
            if #available(macOS 14.4, *) {
                item.subtitle = detail
            } else {
                item.toolTip = detail
            }
            menu.addItem(item)
        }
        menu.addItem(.separator())
        let add = NSMenuItem(title: String(localized: "Add Workspace…"), action: #selector(addWorkspace(_:)), keyEquivalent: "")
        add.target = self
        menu.addItem(add)
        // Marks not read yet draw on the next open.
        Task { await store.loadMarks() }
    }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        // A switch relaunches the app: never under a live call.
        !StarlingsSurfaceActivity.isMeetLive
    }

    @objc private func switchTo(_ sender: NSMenuItem) {
        let store = StarlingsWorkspaceStore.shared
        guard let origin = sender.representedObject as? String,
              origin != store.current.webOrigin,
              let workspace = store.known.first(where: { $0.webOrigin == origin })
        else { return }
        WorkspaceAccounts.open(workspace, in: NSApp.keyWindow ?? NSApp.mainWindow)
    }

    /// The add sheet: an address, looked up as it is typed, then sign-in to
    /// it and a switch.
    @objc private func addWorkspace(_ sender: Any?) {
        guard !StarlingsSurfaceActivity.isMeetLive else { return }
        AddWorkspaceSheet.present(over: NSApp.keyWindow ?? NSApp.mainWindow)
    }
}

/// What the Mac does with one row of the workspace list: open
/// it, sign out of it, or remove it from this Mac, without switching to it
/// first. The current workspace signs out through the app's own Sign Out;
/// these are for the others.
@MainActor
enum WorkspaceAccounts {
    static func sessions(_ workspace: StarlingsWorkspace) -> OwnerSessionStore {
        OwnerSessionStore(scope: WorkspaceScope(workspace))
    }

    /// The account signed in to `workspace` on this Mac, or nil.
    static func email(_ workspace: StarlingsWorkspace) -> String? {
        (try? sessions(workspace).load())?.owner.email
    }

    static func hasSession(_ workspace: StarlingsWorkspace) -> Bool {
        email(workspace) != nil
    }

    /// Switches to `workspace`, signing in to it first when it is signed
    /// out. A cancel stays where it was; a failure says why.
    static func open(_ workspace: StarlingsWorkspace, in window: NSWindow?) {
        let store = StarlingsWorkspaceStore.shared
        guard !StarlingsSurfaceActivity.isMeetLive, workspace.webOrigin != store.current.webOrigin else { return }
        if hasSession(workspace) {
            store.enter(workspace)
            return
        }
        guard let window else { return }
        Task {
            do {
                _ = try await GoogleOwnerAuthenticator(store: sessions(workspace))
                    .authenticate(workspace, in: window, requireActive: false)
                guard !StarlingsSurfaceActivity.isMeetLive else { return }
                store.enter(workspace)
            } catch {
                guard !SignInOutcome.isCancel(error) else { return }
                present(StarlingsError.wrapping(error, code: "auth.sign_in_failed", title: String(localized: "Sign-in didn’t finish")), in: window)
            }
        }
    }

    /// Sign out of a workspace that is not the current one: its Worker is
    /// told first, best effort, then its session, caches and captures go.
    /// The row stays, signed out.
    static func signOut(_ workspace: StarlingsWorkspace) throws {
        guard workspace.webOrigin != StarlingsWorkspaceStore.shared.current.webOrigin else { return }
        let store = sessions(workspace)
        MeetingControlAPI(apiBaseURL: workspace.apiBaseURL, ownerSessionStore: store, webOrigin: workspace.webOrigin)
            .revokeOwnDeviceBestEffort(deviceID: store.deviceID())
        try store.clear()
        WorkspaceSignOut.purgeLocalData(of: WorkspaceScope(workspace))
        AmbientCaptureStore.removeAll(workspaceOrigin: workspace.webOrigin)
    }

    /// Remove from this Mac: a sign-out when it is signed in, then the row goes.
    static func remove(_ workspace: StarlingsWorkspace) throws {
        if hasSession(workspace) { try signOut(workspace) }
        StarlingsWorkspaceStore.shared.forget(workspace)
    }

    static func present(_ error: StarlingsError, in window: NSWindow?) {
        StarlingsDiagnosticsLog.shared.record(error, context: "error")
        let alert = NSAlert()
        alert.messageText = error.title
        alert.informativeText = error.message
        alert.alertStyle = .warning
        alert.addButton(withTitle: String(localized: "OK"))
        let copyResponse = alert.addCopyErrorButton()
        let handle: (NSApplication.ModalResponse) -> Void = { response in
            if response == copyResponse { StarlingsErrorReport.copy(error) }
        }
        if let window {
            alert.beginSheetModal(for: window, completionHandler: handle)
        } else {
            handle(alert.runModal())
        }
    }
}
