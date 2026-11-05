import AppKit
import KeepKit
import KeepUI
import SwiftUI

/// Keep on the Mac: the vaults in a window of their own, opened from Work ›
/// Keep…. Not one of the four destinations, so no surface switcher and no
/// ⌘-digit — a plain titled window on the shared canvas. See docs/KEEP.md.
@MainActor
final class KeepWindowController: NSWindowController {
    private let access: KeepAccess

    init(access: KeepAccess) {
        self.access = access
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1040, height: 660),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = String(localized: "Keep")
        window.minSize = NSSize(width: 820, height: 480)
        // Three columns: the split view brings the toolbar. The window keeps
        // its title bar — hiding it let the content columns slide under the
        // toolbar glass while the sidebar kept its inset.
        window.toolbarStyle = .unifiedCompact
        window.isReleasedWhenClosed = false
        super.init(window: window)
        let root = KeepStandaloneView(
            session: access.session,
            connect: { [weak access] in await access?.link() },
            anchor: { [weak window] in window ?? NSApp.keyWindow ?? NSWindow() }
        )
        window.contentViewController = NSHostingController(rootView: meetHosted(root))
        shouldCascadeWindows = false
        windowFrameAutosaveName = "MeetKeepWindow"
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func show(relativeTo host: NSWindow? = nil) {
        guard let window else { return }
        if !window.setFrameUsingName(windowFrameAutosaveName), let host {
            window.setFrameOrigin(NSPoint(
                x: host.frame.midX - window.frame.width / 2,
                y: host.frame.midY - window.frame.height / 2
            ))
        }
        showWindow(nil)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        Task { await access.session.refresh() }
    }
}
