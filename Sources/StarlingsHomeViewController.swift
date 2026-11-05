import AppKit

/// Home's window content: the launch card `MeetingViewController` builds as
/// `homeView`. The meeting itself stands in the Room window
/// (`RoomWindowController`), so Home stays on screen while a meeting runs.
/// See docs/SURFACES.md §Window chrome.
@MainActor
final class StarlingsHomeViewController: NSViewController, StarlingsWindowSizing {
    private let meetingViewController: MeetingViewController

    init(meeting: MeetingViewController) {
        meetingViewController = meeting
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func loadView() {
        meetingViewController.loadViewIfNeeded()
        view = meetingViewController.homeView
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        StarlingsWindowMetrics.refresh(view.window)
        meetingViewController.surfaceDidAppear()
    }

    /// The launch card, a 420pt strip in a scroller with 56pt around it.
    var minimumContentSize: NSSize {
        NSSize(width: MeetingViewController.detailMinimumWidth, height: StarlingsShellViewController.minimumContentHeight)
    }
}
