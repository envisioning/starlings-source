import AppKit

/// The one shape a Meet destination has *under* its chrome: a sidebar, the
/// thing chosen, and an inspector.
///
/// `StarlingsWindowChrome` dresses the titlebar; this is the body beneath it.
/// Calendar, Work, Team and Docs wear it, and before they did each had grown its own
/// — Work a real three-pane split, Calendar a fixed 220pt column drawn by hand
/// with a popover where the inspector should be — so the same gesture
/// (collapse the sidebar, put the inspector away) worked in one window and
/// did not exist in the other. Everything here is what the three now share:
/// the column widths, which columns collapse, the sidebar surface, and the
/// two toolbar bookends. A surface supplies three views and nothing else.
///
/// The Room window wears it too, with no left sidebar: the stage is the thing
/// chosen and the meeting rail is the inspector
/// (`StarlingsRoomShellViewController`). Before
/// that the rail was a pane of a hand-rolled split view inset inside the
/// window, which is why it sat a margin away from every edge with a divider
/// of its own.
///
/// See docs/SURFACES.md §Window chrome.
@MainActor
class StarlingsShellViewController: NSSplitViewController, NSMenuItemValidation, StarlingsWindowSizing {
    enum Column {
        /// The floor is what the content needs — Calendar's mini month and a
        /// Work row both stop reading below it. The ceiling is only a ceiling:
        /// it was 380, which is 140pt of travel, tight enough that the drag
        /// hit a wall almost at once and the column read as fixed. A sidebar
        /// is resizable; this is where it stops, not how wide it is.
        static let sidebarMinimum: CGFloat = 240
        static let sidebarMaximum: CGFloat = 520
        static let detailMinimum: CGFloat = 360
        static let inspectorMinimum: CGFloat = 280
        // Documents are written here, so the ceiling is a reading column,
        // not a sidebar: 68 characters of prose at body size plus the panel's
        // insets. The middle column's own minimum is what keeps a wide
        // inspector from swallowing the window; the divider remembers.
        static let inspectorMaximum: CGFloat = 1000
        /// An inspector that floats over the middle column has no divider to
        /// drag, so it has one width rather than a floor and a ceiling.
        static let inspectorOverlayWidth: CGFloat = 320
        /// The gap a middle column's content keeps from the pane's edges,
        /// and so from the column beside it: Calendar's grid, and Home's
        /// call stage against the meeting rail.
        static let contentGutter: CGFloat = 12
        /// The glass floater's stand-off from the pane's edges and its
        /// corner. The same gutter Calendar's grid keeps from the pane.
        static let inspectorOverlayInset: CGFloat = contentGutter
        static let inspectorOverlayCornerRadius: CGFloat = 14
        /// The sidebar's content sits this far inside its panel surface. One value,
        /// so a Calendar header and a Work header start at the same x.
        static let sidebarInsets = NSEdgeInsets(top: 10, left: 8, bottom: 8, right: 8)
    }

    /// **The columns that are actually standing, and only those.**
    ///
    /// This was the sum of all three minimums whether or not the panels were on
    /// screen — a window with both panels collapsed still refused to go under
    /// 880pt, describing a state it was not in. The correction went one step
    /// too far and answered `detailMinimum` *always*, on the premise that
    /// AppKit sheds a side panel when its minimum no longer fits. AppKit does
    /// not: both panels are installed with `canCollapseFromWindowResize =
    /// false`, precisely so revealing one cannot silently take the other. So
    /// the window advertised a 360pt floor it could never reach, and every
    /// drag between the real floor and the advertised one was a fight —
    /// `minSize` saying keep going, the split view refusing — which is what a
    /// window that "won't resize" is made of.
    ///
    /// A panel that is away costs nothing; a panel that is there costs its
    /// minimum and its divider. `StarlingsWindowMetrics.refresh` re-reads this on
    /// every toggle, so the floor moves with the panels: put both away and the
    /// window really does go down to one column.
    var minimumContentSize: NSSize {
        let divider = splitView.dividerThickness
        var width = detailMinimumWidth
        if let sidebarItem, !sidebarItem.isCollapsed {
            width += Column.sidebarMinimum + divider
        }
        if let inspectorItem, !inspectorItem.isCollapsed {
            width += Column.inspectorMinimum + divider
        }
        return NSSize(width: width, height: Self.minimumContentHeight)
    }

    /// What each surface stops making sense below. Width is the shell's;
    /// height is the surface's, because a month grid and a list of tasks do
    /// not run out of room at the same place.
    class var minimumContentHeight: CGFloat { 420 }

    /// The toolbar's bookends. The surface switcher first — it is the same
    /// first item in all four windows — a hairline, then the sidebar toggle,
    /// where every Mac keeps it; the inspector toggle is last. A surface lays its own items
    /// between the two.
    ///
    /// **Neither tracking separator is asked for**, and both omissions are the
    /// same omission: a tracking separator ties the run beside it to a column's
    /// edge, so the sidebar's moved everything before it whenever the sidebar
    /// collapsed, and the inspector's laid out everything after it inside the
    /// inspector's region rather than against the window edge. Both made a
    /// toolbar item's x an answer to *how wide is that column*. The two toggles
    /// give up being pinned to their columns so the switcher can be at one x in
    /// every window; that trade is the whole point of the switcher.
    static let leadingToolbarItems: [NSToolbarItem.Identifier] = [
        .meetSurfaces, .meetSurfacesDivider, .toggleSidebar,
    ]
    static let trailingToolbarItems: [NSToolbarItem.Identifier] = [
        .toggleInspector,
    ]

    private(set) var sidebarItem: NSSplitViewItem?
    private(set) var inspectorItem: NSSplitViewItem?
    /// The inspector when it floats over the middle column instead of standing
    /// beside it (`installColumns(inspectorOverlays:)`). `nil` when it is a
    /// split item.
    private var overlayInspector: NSView?
    private var overlayInspectorTrailing: NSLayoutConstraint?
    private var overlayInspectorInset: CGFloat = 0
    private var overlayInspectorVisible = false
    /// The middle column's floor, as installed. `Column.detailMinimum` for a
    /// list; Home's stage asks for more.
    private(set) var detailMinimumWidth: CGFloat = Column.detailMinimum

    var isInspectorVisible: Bool {
        if let inspectorItem { return !inspectorItem.isCollapsed }
        return overlayInspector != nil && overlayInspectorVisible
    }

    /// How far the inspector reaches into the middle column from its trailing
    /// edge while it is open — the width of a floating inspector, nothing for
    /// a split item, which takes its own column. A surface reads this to keep
    /// what it just chose out from under the panel.
    var inspectorOverlayWidth: CGFloat {
        overlayInspector == nil ? 0 : Column.inspectorOverlayWidth + overlayInspectorInset
    }

    /// Put the three columns in place. Called once, from the subclass's
    /// `viewDidLoad`, after it has built what goes in them.
    ///
    /// `sidebar` is content only — this wraps it in the shared panel surface and
    /// the shared insets; `nil` installs no left column at all, and the
    /// sidebar toggle then validates to nothing. The inspector starts
    /// collapsed: it is for the one thing chosen, and nothing is chosen yet.
    /// `detailMinimum` and `inspectorMaximum` are the two bounds a surface may
    /// move — a stage needs more than a list, and a meeting rail is narrower
    /// than a document editor.
    ///
    /// `inspectorOverlays` puts the inspector over the middle column's
    /// trailing edge instead of beside it. Calendar asks for this: a third
    /// column takes its width from the grid, and seven days that narrow every
    /// time an event opens is the grid changing shape for a panel. The overlay
    /// covers the last day or two instead; the surface scrolls a covered day
    /// out from under it when that day is what was chosen. Everything the
    /// toolbar toggle, the View menu and `setInspector` do is the same in
    /// both placements.
    ///
    /// **The split view owns its geometry.** Each item states its floor and
    /// ceiling, the middle column is the remainder, and `autosaveName` keeps
    /// the divider positions between launches. Nothing here re-places a
    /// divider, re-sizes the window, or corrects AppKit after a layout pass;
    /// a pane that needs more room than the window has says so through its
    /// item's `minimumThickness`, not through a required width chain.
    func installColumns(
        sidebar: NSView?,
        detail: NSViewController,
        inspector: NSViewController,
        detailMinimum: CGFloat = Column.detailMinimum,
        inspectorMaximum: CGFloat = Column.inspectorMaximum,
        inspectorOverlays: Bool = false,
        columnsName: String
    ) {
        splitView.dividerStyle = .thin
        splitView.autosaveName = "MeetShell.\(columnsName)"
        detailMinimumWidth = detailMinimum

        let sidebarItem = sidebar.map { sidebar in
            let item = NSSplitViewItem(
                sidebarWithViewController: StarlingsShellPaneViewController(view: Self.sidebarSurface(holding: sidebar))
            )
            item.minimumThickness = Column.sidebarMinimum
            item.maximumThickness = Column.sidebarMaximum
            item.canCollapse = true
            // Visibility is the user's: revealing one panel never sheds the other.
            item.canCollapseFromWindowResize = false
            return item
        }

        let detailItem = NSSplitViewItem(viewController: detail)
        detailItem.minimumThickness = detailMinimum
        detailItem.canCollapse = false
        // The middle column is the remainder. Its content may prefer to be
        // wider; it may never require it, or AppKit grows the window to pay.
        detail.view.setContentHuggingPriority(.defaultLow, for: .horizontal)
        detail.view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        self.sidebarItem = sidebarItem
        if let sidebarItem { addSplitViewItem(sidebarItem) }
        addSplitViewItem(detailItem)

        if inspectorOverlays {
            installOverlayInspector(inspector, over: detail)
            return
        }

        let inspectorItem = NSSplitViewItem(inspectorWithViewController: inspector)
        inspectorItem.minimumThickness = Column.inspectorMinimum
        inspectorItem.maximumThickness = inspectorMaximum
        inspectorItem.canCollapse = true
        inspectorItem.canCollapseFromWindowResize = false
        inspectorItem.isCollapsed = true
        inspector.view.setContentHuggingPriority(.defaultLow, for: .horizontal)
        inspector.view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        // The ceiling has to be a constraint, not a preference: a panel whose
        // content pins itself edge to edge at required priority outvotes the
        // priorities above, and this is what stops that chain at the window.
        inspector.view.widthAnchor.constraint(
            lessThanOrEqualToConstant: inspectorMaximum
        ).isActive = true

        self.inspectorItem = inspectorItem
        addSplitViewItem(inspectorItem)
    }

    /// The floating placement: the inspector's view pinned to the middle
    /// column's top, trailing and bottom, one width, a hairline on the edge it
    /// shares with the content under it. Out of view it sits its own width
    /// past the trailing edge; opening slides it in over the same distance
    /// the split item's collapse would have moved.
    private func installOverlayInspector(_ inspector: NSViewController, over detail: NSViewController) {
        // The middle pane's child, not this controller's: a split view
        // controller turns every child it is handed into a column.
        detail.addChild(inspector)
        let panel = inspector.view
        panel.translatesAutoresizingMaskIntoConstraints = false

        // On macOS 26 the floater is Liquid Glass and stands off the pane's
        // edges as a rounded shape so the grid shows through around it. Below
        // 26 it is the flat panel rung, edge to edge, with a hairline.
        let floater: NSView
        let inset: CGFloat
        if let glass = StarlingsFloatingGlass.wrap(panel, cornerRadius: Column.inspectorOverlayCornerRadius) {
            floater = glass
            inset = Column.inspectorOverlayInset
        } else {
            let edge = StarlingsShellBackdrop(ground: StarlingsColors.border)
            edge.translatesAutoresizingMaskIntoConstraints = false
            panel.addSubview(edge)
            NSLayoutConstraint.activate([
                edge.leadingAnchor.constraint(equalTo: panel.leadingAnchor),
                edge.topAnchor.constraint(equalTo: panel.topAnchor),
                edge.bottomAnchor.constraint(equalTo: panel.bottomAnchor),
                edge.widthAnchor.constraint(equalToConstant: 1),
            ])
            floater = panel
            inset = 0
        }
        floater.translatesAutoresizingMaskIntoConstraints = false
        detail.view.addSubview(floater)

        let trailing = floater.trailingAnchor.constraint(
            equalTo: detail.view.trailingAnchor,
            constant: Column.inspectorOverlayWidth
        )
        NSLayoutConstraint.activate([
            trailing,
            floater.topAnchor.constraint(equalTo: detail.view.topAnchor, constant: inset),
            floater.bottomAnchor.constraint(equalTo: detail.view.bottomAnchor, constant: -inset),
            floater.widthAnchor.constraint(equalToConstant: Column.inspectorOverlayWidth),
        ])
        floater.isHidden = true
        overlayInspector = floater
        overlayInspectorTrailing = trailing
        overlayInspectorInset = inset
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        guard let window = view.window else { return }
        StarlingsWindowMetrics.refresh(window)
        prepareForOpening(in: window)
    }

    /// A panel opening or closing moves the window's floor; nothing else
    /// about the window changes. The user's frame is the user's.
    override func viewDidLoad() {
        super.viewDidLoad()
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(shellColumnsChanged(_:)),
            name: NSSplitView.didResizeSubviewsNotification,
            object: splitView
        )
    }

    @objc private func shellColumnsChanged(_ notification: Notification) {
        StarlingsWindowMetrics.refresh(view.window)
    }

    /// The View menu says which way the two items go, rather than naming a
    /// gesture: *Show* it when it is away, *Hide* it when it is there.
    /// `dynamic` so a surface can add its own cases from an extension, which
    /// is where Calendar keeps its menu answers.
    @objc dynamic func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        switch menuItem.action {
        case #selector(toggleSidebar(_:)):
            guard let sidebarItem else { return false }
            menuItem.title = sidebarItem.isCollapsed ? String(localized: "Show Left Sidebar") : String(localized: "Hide Left Sidebar")
            return true
        case #selector(toggleInspector(_:)):
            guard inspectorItem != nil || overlayInspector != nil else { return false }
            menuItem.title = isInspectorVisible ? String(localized: "Hide Right Sidebar") : String(localized: "Show Right Sidebar")
            return true
        case #selector(floatDocument(_:)):
            return documentInspector?.openDocument != nil
        default:
            return true
        }
    }

    /// The inspector that edits documents in this window, for Window ›
    /// Float Document. Nil where no document is ever opened.
    var documentInspector: WorkInspectorViewController? { nil }

    /// Window › Float Document (⇧⌘F): the document open in this window's
    /// inspector, in a window of its own.
    @objc func floatDocument(_ sender: Any?) {
        documentInspector?.floatOpenDocument()
    }

    /// The window's search box. ⌘F is what hands it the caret, and the Edit
    /// menu's Find reaches whichever shell window is frontmost through the
    /// responder chain — one item for both, the way one shell holds both.
    var surfaceSearchField: NSSearchField? { nil }

    /// Set this before `showWindow` so AppKit has a non-search answer before
    /// the new tab becomes key. The deferred repair covers an existing tab:
    /// its toolbar can restore the search field as first responder while the
    /// tab is being activated.
    func prepareForOpening(in window: NSWindow) {
        loadViewIfNeeded()
        guard let opening = openingFirstResponder else { return }
        window.initialFirstResponder = opening
        DispatchQueue.main.async { [weak window] in
            guard let window, window.isVisible else { return }
            if Self.isSearch(window.firstResponder) {
                window.makeFirstResponder(opening)
            }
        }
    }

    @objc func findInSurface(_ sender: Any?) {
        guard let surfaceSearchField else { return }
        view.window?.makeFirstResponder(surfaceSearchField)
    }

    /// The view a shell window starts on, so search stays opt-in.
    ///
    /// Search is the only text field in this chrome, so AppKit hands it key
    /// focus on open and the first thing typed goes into a search nobody
    /// asked for. A surface names what it would rather start on; ⌘F is what
    /// hands the caret over. Overridden by both surfaces — this returning
    /// nil only means *leave AppKit to it*.
    var openingFirstResponder: NSView? { nil }

    /// The search field itself before it is typed in, its field editor after —
    /// the editor is the one that answers `firstResponder` once a caret is in
    /// the box, and it names the field it is editing as its delegate.
    private static func isSearch(_ responder: NSResponder?) -> Bool {
        if responder is NSSearchField { return true }
        if let editor = responder as? NSText { return editor.delegate is NSSearchField }
        return false
    }

    /// The same collapse the toolbar toggle performs, so a surface opening
    /// its inspector for a selection and the user opening it by hand are one
    /// motion. Unanimated is for a state set before the window is on screen.
    func setInspector(visible: Bool, animated: Bool = true) {
        if let inspectorItem {
            guard inspectorItem.isCollapsed == visible else { return }
            if animated {
                inspectorItem.animator().isCollapsed = !visible
            } else {
                inspectorItem.isCollapsed = !visible
            }
            return
        }
        guard let overlayInspector, let overlayInspectorTrailing, overlayInspectorVisible != visible else { return }
        overlayInspectorVisible = visible
        let restingConstant: CGFloat = visible ? -overlayInspectorInset : Column.inspectorOverlayWidth
        guard animated, !overlayInspector.isHidden || visible else {
            overlayInspectorTrailing.constant = restingConstant
            overlayInspector.isHidden = !visible
            return
        }
        overlayInspector.isHidden = false
        overlayInspector.superview?.layoutSubtreeIfNeeded()
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.2
            overlayInspectorTrailing.animator().constant = restingConstant
        }, completionHandler: { [weak self] in
            guard let self, !self.overlayInspectorVisible else { return }
            self.overlayInspector?.isHidden = true
        })
    }

    /// The split view controller's own toggle only knows its inspector item.
    /// The floating placement answers the same toolbar button and menu item.
    override func toggleInspector(_ sender: Any?) {
        guard inspectorItem == nil, overlayInspector != nil else {
            super.toggleInspector(sender)
            return
        }
        setInspector(visible: !isInspectorVisible)
    }

    /// The sidebar is the panel rung, not AppKit's `.sidebar` material. System
    /// materials are intentionally OS-dependent and can resolve to a gray that
    /// disagrees with Meet's canvas/panel ladder.
    private static func sidebarSurface(holding content: NSView) -> NSView {
        let surface = StarlingsShellBackdrop(ground: StarlingsColors.panel)
        content.translatesAutoresizingMaskIntoConstraints = false
        content.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        surface.addSubview(content)
        let insets = Column.sidebarInsets
        // The floor is the split item's `minimumThickness`; repeating it here as
        // a required constraint only gave the sidebar a second way to push the
        // window. The ceiling is what this pane owes the other two.
        NSLayoutConstraint.activate([
            surface.widthAnchor.constraint(lessThanOrEqualToConstant: Column.sidebarMaximum),
            content.topAnchor.constraint(equalTo: surface.topAnchor, constant: insets.top),
            content.leadingAnchor.constraint(equalTo: surface.leadingAnchor, constant: insets.left),
            content.trailingAnchor.constraint(equalTo: surface.trailingAnchor, constant: -insets.right),
            content.bottomAnchor.constraint(equalTo: surface.bottomAnchor, constant: -insets.bottom),
        ])
        return surface
    }
}

/// One pane of the shell, holding a view the surface already built.
@MainActor
final class StarlingsShellPaneViewController: NSViewController {
    private let pane: NSView

    init(view: NSView) {
        pane = view
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func loadView() {
        view = pane
    }
}

/// A flat ground that follows the appearance. Side surfaces sit on the panel
/// rung beside the canvas; the same view used *as* the canvas sits on the
/// canvas.
@MainActor
final class StarlingsShellBackdrop: NSView {
    /// Settable for the one case where a placement, not the surface, decides
    /// the ground: the shell's glass floater clears it so the glass shows.
    var ground: NSColor {
        didSet { layer?.backgroundColor = StarlingsColors.resolved(ground, for: self).cgColor }
    }

    init(ground: NSColor) {
        self.ground = ground
        super.init(frame: .zero)
        wantsLayer = true
        layer?.backgroundColor = StarlingsColors.resolved(ground, for: self).cgColor
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        layer?.backgroundColor = StarlingsColors.resolved(ground, for: self).cgColor
    }
}
