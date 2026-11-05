import AppKit

/// The Mac's answer to a room or invite link for another workspace (slice F,
///): name the workspace and offer to open the link there. Opening
/// it carries the link and chooses the workspace; the app relaunches on it
/// (slice E) and puts the link back in the join field.
@MainActor
enum LinkWorkspaceOffer {
    /// True when `link` belongs to another workspace and was handled here: an
    /// offer, or a refusal. False lets the caller go on with the link.
    static func handle(_ link: String, in window: NSWindow?) async -> Bool {
        guard !StarlingsWorkspaceLink.isActive(link) else { return false }
        switch await StarlingsWorkspaceLink.resolve(link) {
        case .active:
            return false
        case .other(let workspace):
            let alert = NSAlert()
            alert.messageText = String(localized: "This link is for \(workspace.name).")
            alert.addButton(withTitle: String(localized: "Open in \(workspace.name)"))
            alert.addButton(withTitle: String(localized: "Cancel"))
            guard await run(alert, in: window) == .alertFirstButtonReturn else { return true }
            StarlingsWorkspaceLink.carry(link, to: workspace)
            StarlingsWorkspaceStore.shared.choose(workspace)
            return true
        case .unknown:
            let alert = NSAlert()
            alert.messageText = String(localized: "This link isn’t for a workspace this app can open.")
            alert.alertStyle = .warning
            alert.addButton(withTitle: String(localized: "OK"))
            _ = await run(alert, in: window)
            return true
        }
    }

    private static func run(_ alert: NSAlert, in window: NSWindow?) async -> NSApplication.ModalResponse {
        guard let window else { return alert.runModal() }
        return await withCheckedContinuation { continuation in
            alert.beginSheetModal(for: window) { continuation.resume(returning: $0) }
        }
    }
}
