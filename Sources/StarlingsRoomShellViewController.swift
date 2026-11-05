import AppKit

/// The Room window under its chrome: the stage in the middle, the meeting
/// rail as the inspector, and no left sidebar. Home is its own window
/// (`StarlingsHomeViewController`); this one opens when a meeting or a Join
/// needs the stage and closes when it no longer does.
///
/// The meeting used to be the one surface that was not a
/// `StarlingsShellViewController` — `MeetingViewController` drew its own
/// two-pane split, inset 28pt inside the window, with the rail as the
/// right-hand pane. That gave the rail a
/// margin on three sides, a divider of its own against the stage, and a
/// second implementation of collapse, drag bounds and remembered width. Now
/// the rail is the same inspector column Calendar, Work, Team and Docs have,
/// and the window's floor, ⌃⌘I, and the toolbar's trailing button are the
/// shell's.
///
/// `MeetingViewController` still decides *whether* the rail stands — the
/// preference, the live phase, and the launch card all bear on it — so this
/// shell forwards the inspector gesture to it instead of flipping the column
/// itself. See docs/SURFACES.md §Window chrome.
@MainActor
final class StarlingsRoomShellViewController: StarlingsShellViewController {
    let meetingViewController: MeetingViewController

    init(meeting: MeetingViewController) {
        meetingViewController = meeting
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        meetingViewController.loadViewIfNeeded()
        installColumns(
            sidebar: nil,
            detail: meetingViewController,
            inspector: StarlingsShellPaneViewController(view: meetingViewController.railView),
            detailMinimum: MeetingViewController.detailMinimumWidth,
            inspectorMaximum: MeetingPanelPreferences.railMaximumWidth,
            columnsName: "MeetHomeSplit"
        )
        // Where the rail starts before the divider has been dragged once;
        // the autosave takes over after that.
        inspectorItem?.preferredThicknessFraction = 330 / StarlingsSurface.meet.openingContentSize.width
        // `render(phase:)` ran inside the meeting surface's `loadView`, before
        // it had a column to show or hide.
        meetingViewController.syncMeetingPanelVisibility()
    }

    /// The column is the meeting surface's to open and close: it owns the
    /// preference and the live-only rule. Idle, the gesture does nothing —
    /// `MeetingViewController.validateUserInterfaceItem` disables the button.
    override func toggleInspector(_ sender: Any?) {
        meetingViewController.toggleInspector(sender)
    }

    override func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        if menuItem.action == #selector(toggleInspector(_:)) {
            return meetingViewController.validateMenuItem(menuItem)
        }
        return super.validateMenuItem(menuItem)
    }

    /// The toolbar's inspector button reaches this controller when the first
    /// responder is inside the rail, not the stage. Same answer as the stage's.
    override func validateUserInterfaceItem(_ item: NSValidatedUserInterfaceItem) -> Bool {
        if item.action == #selector(toggleInspector(_:)) {
            return meetingViewController.validateUserInterfaceItem(item)
        }
        return super.validateUserInterfaceItem(item)
    }
}
