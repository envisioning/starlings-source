import AppKit

/// Chat in its own movable, resizable panel.
///
/// It used to be a section of the meeting sidebar, then an overlay pinned to a
/// corner of the stage — both of which meant chat could only appear and
/// disappear, never be put where the participant wants it. A panel is the
/// AppKit surface for exactly that: floats above the meeting window, keeps its
/// own position and size across meetings, and never steals main-window status
/// while you type in it.
@MainActor
final class MeetingChatWindowController: NSWindowController, NSWindowDelegate {
    /// Called when the participant closes the window, so the Chat button and
    /// the controller's own visibility flag stay in sync with what's on screen.
    var onClose: (() -> Void)?

    private let panelView: MeetingChatPanelView

    init(panelView: MeetingChatPanelView) {
        self.panelView = panelView
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 340, height: 460),
            styleMask: [.titled, .closable, .resizable, .utilityWindow],
            backing: .buffered,
            defer: true
        )
        panel.title = String(localized: "Chat")
        panel.isFloatingPanel = true
        // Utility panels hide themselves when the app deactivates. Chat is a
        // live conversation, not an inspector — it should still be there when
        // you come back from the browser or a shared window.
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.backgroundColor = StarlingsColors.panel
        panel.minSize = NSSize(width: 300, height: 320)
        panel.animationBehavior = .utilityWindow

        panelView.contentInsets = NSEdgeInsets(top: 12, left: 14, bottom: 14, right: 14)
        // In-call Chat floats over the meeting: glass on macOS 26, the way
        // the iOS half sheet is, with the bubbles keeping their own ground.
        StarlingsFloatingGlass.dress(panel, content: panelView, cornerRadius: 0)

        super.init(window: panel)
        panel.delegate = self
        // Position and size survive quits, so chat reopens where you left it —
        // which only holds if the controller stops cascading it on each show.
        shouldCascadeWindows = false
        windowFrameAutosaveName = "MeetingChatPanel"
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    var isPanelVisible: Bool { window?.isVisible ?? false }

    /// First open sits the panel off the meeting window's trailing edge; later
    /// opens reuse wherever it was dragged to.
    func show(relativeTo host: NSWindow?) {
        guard let panel = window as? NSPanel else { return }
        if !panel.isVisible, !panel.setFrameUsingName(windowFrameAutosaveName) {
            positionAlongside(host, panel: panel)
        }
        panel.makeKeyAndOrderFront(nil)
        panelView.showLatest()
        panelView.focusComposer()
    }

    func hide() {
        window?.orderOut(nil)
    }

    private func positionAlongside(_ host: NSWindow?, panel: NSPanel) {
        guard let hostFrame = host?.frame else {
            panel.center()
            return
        }
        var frame = panel.frame
        frame.origin = NSPoint(
            x: hostFrame.maxX - frame.width - 24,
            y: hostFrame.minY + 24
        )
        // Keep it on screen if the meeting window is hugging a display edge.
        if let visible = (host?.screen ?? NSScreen.main)?.visibleFrame {
            frame.origin.x = min(max(frame.origin.x, visible.minX), visible.maxX - frame.width)
            frame.origin.y = min(max(frame.origin.y, visible.minY), visible.maxY - frame.height)
        }
        panel.setFrame(frame, display: false)
    }

    func windowWillClose(_ notification: Notification) {
        onClose?()
    }
}
