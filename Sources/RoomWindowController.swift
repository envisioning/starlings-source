import AppKit

/// The room, in a window of its own: the stage, the control row and the rail.
///
/// Home starts the room; it does not hold it. This window opens when the
/// stage has something to show (a meeting, an admission, the Join form) and
/// closes when it no longer does. It shares the surfaces' tabbing identity,
/// so with Use tabs on it opens as a tab beside Home. It is not a sixth
/// surface: it has no place in the switcher, and the Home card's Start brings
/// it back when it was closed during a meeting. See docs/SURFACES.md §Window
/// chrome.
@MainActor
final class RoomWindowController: NSWindowController, NSToolbarDelegate {
    private static let frameAutosaveName = "StarlingsRoomWindow"

    init(meeting: MeetingViewController) {
        let shell = StarlingsRoomShellViewController(meeting: meeting)
        let window = NSWindow(contentViewController: shell)
        window.setContentSize(StarlingsSurface.meet.openingContentSize)
        window.isReleasedWhenClosed = false
        super.init(window: window)
        StarlingsWindowChrome.apply(
            to: window,
            surface: .meet,
            toolbarIdentifier: "MeetRoomToolbar",
            delegate: self,
            contentUnderToolbar: true
        )
        window.title = String(localized: "Room")
        if !window.setFrameUsingName(Self.frameAutosaveName) {
            window.center()
        }
        windowFrameAutosaveName = Self.frameAutosaveName
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    var isShowing: Bool {
        guard let window else { return false }
        return window.isVisible || window.isMiniaturized
    }

    func show() {
        guard let window else { return }
        StarlingsWindowMetrics.refresh(window)
        showWindow(nil)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// The stage has nothing left to show. A tab leaves its group.
    func hide() {
        guard isShowing else { return }
        window?.close()
    }

    /// The rail's toggle, and nothing else: the room is not a surface, so it
    /// carries no switcher. Returning `nil` for `.toggleInspector` lets
    /// AppKit draw the standard button, as Calendar and Work do;
    /// `MeetingViewController.validateUserInterfaceItem(_:)` disables it
    /// before the meeting is live.
    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [.flexibleSpace, .toggleInspector]
    }

    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        toolbarDefaultItemIdentifiers(toolbar)
    }

    func toolbar(
        _ toolbar: NSToolbar,
        itemForItemIdentifier identifier: NSToolbarItem.Identifier,
        willBeInsertedIntoToolbar flag: Bool
    ) -> NSToolbarItem? {
        nil
    }
}
