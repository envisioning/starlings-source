import AppKit

/// Work's home — the middle pane when nothing is chosen ( slice 3d).
/// Team opens on a grid of who is around; this is the same idea for work:
/// today's meetings, then what needs you and what you owe side by side,
/// with room to read. The rows are the rail's own row views, built a second
/// time for this column, so a proposal reads and resolves the same way in
/// both places. The subjects you were just in are in Home's Quick Access now,
/// not a row of tiles here.
///
/// UNOWNED sits below MINE in its column, the way QUICK NOTES sits below
/// INBOX: open work nobody on our side holds (docs/BOARD.md §Unowned).
///
/// INBOX and MINE are the two panes of `StarlingsHalvesSplitView`, the same
/// split a subject's Talk | Work uses: each scrolls on its own under a pinned
/// header, MINE sits on the panel ground, and the divider keeps its
/// proportion when the window resizes. TODAY spans both, above them.
///
/// This view owns no data. The controller hands it rows; it only lays them
/// out and scrolls.
@MainActor
final class WorkOverviewView: NSView {
    /// The empty state's one door: Browse.
    var onBrowse: (() -> Void)?

    private let column = NSStackView()
    private let todayHeader = WorkOverviewView.header("TODAY")
    private let todayStack = NSStackView()
    private let inboxHeader = OverviewFoldHeader(.workOverview, "inbox")
    private lazy var inboxHeaderRow = WorkOverviewView.headerRow(inboxHeader)
    private let inboxStack = NSStackView()
    private let inboxRowsStack = NSStackView()
    private let quickNotesHeader = OverviewFoldHeader(.workOverview, "quickNotes")
    private let quickNotesSection = NSStackView()
    private let quickNotesStack = NSStackView()
    private let activityHeader = OverviewFoldHeader(.workOverview, "activity")
    private let activitySection = NSStackView()
    private let activityStack = NSStackView()
    private let inboxScroll = NSScrollView()
    private let mineHeader = OverviewFoldHeader(.workOverview, "mine")
    private lazy var mineHeaderRow = WorkOverviewView.headerRow(mineHeader)
    private let mineStack = NSStackView()
    private let mineRowsStack = NSStackView()
    private let unownedHeader = OverviewFoldHeader(.workOverview, "unowned")
    private lazy var unownedHeaderRow = WorkOverviewView.headerRow(unownedHeader)
    private let unownedSection = NSStackView()
    private let unownedStack = NSStackView()
    private let mineScroll = NSScrollView()
    /// Nothing today, nothing in INBOX, nothing in MINE: one line and the
    /// door to Browse, instead of three headers over nothing.
    private let emptyLabel = StarlingsTypography.wrappingLabel(String(localized: "Nothing needs you."))
    private let browseButton = NSButton(title: String(localized: "Browse Subjects"), target: nil, action: nil)
    private let columns: StarlingsHalvesSplitView

    override init(frame frameRect: NSRect) {
        let inboxPane = NSView()
        let minePane = NSView()
        columns = StarlingsHalvesSplitView(name: "WorkOverview", trailing: minePane)
        super.init(frame: frameRect)

        for stack in [todayStack, inboxStack, inboxRowsStack, quickNotesSection, quickNotesStack, activitySection, activityStack, mineStack, mineRowsStack, unownedSection, unownedStack] {
            stack.orientation = .vertical
            stack.alignment = .leading
            stack.spacing = 2
            stack.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        }
        // Every header folds its own rows, and the fold is kept per device
        // under the shared registry's key (`rail-blocks.ts`, `workOverview`).
        inboxHeader.body = inboxRowsStack
        quickNotesHeader.body = quickNotesStack
        mineHeader.body = mineRowsStack
        unownedHeader.body = unownedStack
        quickNotesSection.edgeInsets = NSEdgeInsets(top: 12, left: 0, bottom: 0, right: 0)
        quickNotesSection.addArrangedSubview(quickNotesHeader)
        quickNotesSection.addArrangedSubview(quickNotesStack)
        inboxStack.addArrangedSubview(inboxRowsStack)
        inboxStack.addArrangedSubview(quickNotesSection)
        activityHeader.text = String(localized: "ACTIVITY")
        activityHeader.body = activityStack
        activitySection.edgeInsets = NSEdgeInsets(top: 12, left: 0, bottom: 0, right: 0)
        activitySection.addArrangedSubview(activityHeader)
        activitySection.addArrangedSubview(activityStack)
        inboxStack.addArrangedSubview(activitySection)
        unownedSection.edgeInsets = NSEdgeInsets(top: 12, left: 0, bottom: 0, right: 0)
        unownedSection.addArrangedSubview(unownedHeaderRow)
        unownedSection.addArrangedSubview(unownedStack)
        mineStack.addArrangedSubview(mineRowsStack)
        mineStack.addArrangedSubview(unownedSection)
        WorkOverviewView.fill(inboxPane, header: inboxHeaderRow, scroll: inboxScroll, list: inboxStack)
        WorkOverviewView.fill(minePane, header: mineHeaderRow, scroll: mineScroll, list: mineStack)
        columns.setLeading(inboxPane)

        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 10
        column.edgeInsets = NSEdgeInsets(top: 18, left: 20, bottom: 14, right: 20)
        column.addArrangedSubview(todayHeader)
        column.addArrangedSubview(todayStack)
        emptyLabel.textColor = StarlingsColors.secondaryText
        browseButton.bezelStyle = .rounded
        browseButton.target = self
        browseButton.action = #selector(browsePressed)
        let empty = NSStackView(views: [emptyLabel, browseButton])
        empty.orientation = .vertical
        empty.alignment = .leading
        empty.spacing = 10
        emptyStack = empty
        column.addArrangedSubview(empty)
        column.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        column.setContentHuggingPriority(.defaultHigh, for: .vertical)

        // TODAY (or the empty line) above; the split takes the rest. A
        // hidden TODAY lets the split reach the top, so MINE's ground does.
        let page = NSStackView(views: [column, columns])
        page.orientation = .vertical
        page.alignment = .leading
        page.spacing = 0
        page.distribution = .fill
        page.detachesHiddenViews = true
        page.translatesAutoresizingMaskIntoConstraints = false
        columns.setContentHuggingPriority(.defaultLow, for: .vertical)
        addSubview(page)
        NSLayoutConstraint.activate([
            page.leadingAnchor.constraint(equalTo: leadingAnchor),
            page.trailingAnchor.constraint(equalTo: trailingAnchor),
            page.topAnchor.constraint(equalTo: topAnchor),
            page.bottomAnchor.constraint(equalTo: bottomAnchor),
            column.widthAnchor.constraint(equalTo: page.widthAnchor),
            columns.widthAnchor.constraint(equalTo: page.widthAnchor),
            todayStack.widthAnchor.constraint(equalTo: column.widthAnchor, constant: -40),
            inboxRowsStack.widthAnchor.constraint(equalTo: inboxStack.widthAnchor, constant: -40),
            quickNotesSection.widthAnchor.constraint(equalTo: inboxStack.widthAnchor, constant: -40),
            quickNotesStack.widthAnchor.constraint(equalTo: quickNotesSection.widthAnchor),
            activitySection.widthAnchor.constraint(equalTo: inboxStack.widthAnchor, constant: -40),
            activityStack.widthAnchor.constraint(equalTo: activitySection.widthAnchor),
            mineRowsStack.widthAnchor.constraint(equalTo: mineStack.widthAnchor, constant: -40),
            unownedSection.widthAnchor.constraint(equalTo: mineStack.widthAnchor, constant: -40),
            unownedStack.widthAnchor.constraint(equalTo: unownedSection.widthAnchor),
        ])
        setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// Replace everything. Quick Notes is its own list below INBOX in the
    /// same scroll column; MINE remains beside it, with UNOWNED below it.
    func setContent(
        today: [NSView],
        inbox: [NSView],
        inboxCount: Int,
        quickNotes: [NSView],
        quickNotesCount: Int,
        activity: [NSView],
        mine: [NSView],
        mineCount: Int,
        unowned: [NSView],
        unownedCount: Int
    ) {
        replace(todayStack, with: today)
        todayHeader.isHidden = today.isEmpty
        todayStack.isHidden = today.isEmpty

        let nothing = today.isEmpty && inboxCount == 0 && quickNotesCount == 0 && mineCount == 0 && unowned.isEmpty && activity.isEmpty
        emptyStack?.isHidden = !nothing
        columns.isHidden = nothing
        column.isHidden = today.isEmpty && !nothing

        replace(inboxRowsStack, with: inbox)
        replace(quickNotesStack, with: quickNotes)
        replace(activityStack, with: activity)
        replace(mineRowsStack, with: mine)
        replace(unownedStack, with: unowned)
        inboxHeader.text = inboxCount == 0 ? String(localized: "INBOX") : String(localized: "INBOX · \(inboxCount)")
        quickNotesHeader.text = quickNotesCount == 0 ? String(localized: "QUICK NOTES") : String(localized: "QUICK NOTES · \(quickNotesCount)")
        quickNotesSection.isHidden = quickNotes.isEmpty
        mineHeader.text = mineCount == 0 ? String(localized: "MINE") : String(localized: "MINE · \(mineCount)")
        unownedHeader.text = unownedCount == 0 ? String(localized: "UNOWNED") : String(localized: "UNOWNED · \(unownedCount)")
        unownedSection.isHidden = unowned.isEmpty
        inboxScroll.reflectScrolledClipView(inboxScroll.contentView)
        mineScroll.reflectScrolledClipView(mineScroll.contentView)
    }

    private var emptyStack: NSStackView?

    /// INBOX's, MINE's and UNOWNED's filter menus, beside their headers.
    /// They are the controller's buttons: it owns the menus and tints them
    /// when a filter is on.
    func setFilterButtons(inbox: NSButton, mine: NSButton, unowned: NSButton) {
        inboxHeaderRow.addArrangedSubview(inbox)
        mineHeaderRow.addArrangedSubview(mine)
        unownedHeaderRow.addArrangedSubview(unowned)
    }

    @objc private func browsePressed() { onBrowse?() }

    private func replace(_ stack: NSStackView, with rows: [NSView]) {
        for view in stack.arrangedSubviews { view.removeFromSuperview() }
        for row in rows {
            row.translatesAutoresizingMaskIntoConstraints = false
            stack.addArrangedSubview(row)
            let insets = stack.edgeInsets.left + stack.edgeInsets.right
            row.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -insets).isActive = true
        }
    }

    /// One column: its header pinned at the top, its rows scrolling under it.
    private static func fill(_ pane: NSView, header: NSStackView, scroll: NSScrollView, list: NSStackView) {
        list.edgeInsets = NSEdgeInsets(top: 0, left: 20, bottom: 24, right: 20)
        list.translatesAutoresizingMaskIntoConstraints = false
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.borderType = .noBorder
        let clip = WorkFlippedClipView()
        clip.drawsBackground = false
        scroll.contentView = clip
        scroll.documentView = list
        header.translatesAutoresizingMaskIntoConstraints = false
        scroll.translatesAutoresizingMaskIntoConstraints = false
        pane.addSubview(header)
        pane.addSubview(scroll)
        NSLayoutConstraint.activate([
            header.leadingAnchor.constraint(equalTo: pane.leadingAnchor, constant: 20),
            header.trailingAnchor.constraint(lessThanOrEqualTo: pane.trailingAnchor, constant: -20),
            header.topAnchor.constraint(equalTo: pane.topAnchor, constant: 16),
            scroll.leadingAnchor.constraint(equalTo: pane.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: pane.trailingAnchor),
            scroll.topAnchor.constraint(equalTo: header.bottomAnchor, constant: 8),
            scroll.bottomAnchor.constraint(equalTo: pane.bottomAnchor),
            list.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
        ])
        for view in [pane, scroll, list] as [NSView] {
            view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            view.setContentHuggingPriority(.defaultLow, for: .horizontal)
        }
    }

    private static func headerRow(_ header: NSView) -> NSStackView {
        let row = NSStackView(views: [header])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 4
        return row
    }

    private static func header(_ text: String) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.font = StarlingsTypography.sectionLabelFont
        label.textColor = StarlingsColors.secondaryText
        return label
    }
}

/// An Overview header that folds its rows: chevron and title, the rail
/// block's look (`SidebarSection`'s disclosure), the fold kept in
/// `MeetingSidebarFoldPreferences` under the registry's key so the phone
/// and the web fold the same block under the same name.
@MainActor
private final class OverviewFoldHeader: NSButton {
    private let key: String
    /// The rows this header shows and hides.
    weak var body: NSView? {
        didSet { apply() }
    }
    var text = "" {
        didSet { apply() }
    }
    private var isFolded: Bool {
        didSet {
            MeetingSidebarFoldPreferences.setCollapsed(isFolded, for: key)
            apply()
        }
    }

    init(_ surface: RailSurface, _ id: String) {
        key = RailBlockRegistry.block(surface, id).key
        isFolded = MeetingSidebarFoldPreferences.isCollapsed(key)
        super.init(frame: .zero)
        bezelStyle = .inline
        SettingsChrome.applyQuietButton(self, cornerRadius: 12)
        font = StarlingsTypography.sectionLabelFont
        contentTintColor = StarlingsColors.secondaryText
        imagePosition = .imageLeading
        imageHugsTitle = true
        target = self
        action = #selector(toggle)
        setContentHuggingPriority(.required, for: .horizontal)
        setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        apply()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    @objc private func toggle() { isFolded.toggle() }

    private func apply() {
        title = text
        image = NSImage(
            systemSymbolName: isFolded ? "chevron.right" : "chevron.down",
            accessibilityDescription: nil
        )?.withSymbolConfiguration(.init(pointSize: 9, weight: .semibold))
        body?.isHidden = isFolded
        setAccessibilityLabel(text)
        setAccessibilityExpanded(!isFolded)
    }
}
