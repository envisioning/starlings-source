import AppKit

/// Which sidebar sections the owner has folded away, remembered across launches.
///
/// Folds are a preference, not meeting state: someone who never files CRM leaves
/// that block shut for good, and reopening the app should not undo that. One
/// namespace for every rail — Calendar, the in-meeting rail, Work, Team — so a
/// fold key can never collide or drift between two stores.
enum MeetingSidebarFoldPreferences {
    private static let prefix = RailBlock.foldDefaultsPrefix

    static func isCollapsed(_ key: String) -> Bool {
        UserDefaults.standard.bool(forKey: prefix + key)
    }

    static func setCollapsed(_ collapsed: Bool, for key: String) {
        UserDefaults.standard.set(collapsed, forKey: prefix + key)
    }

    /// A section that ships folded. Registered rather than written, so it is
    /// only the answer until the owner gives one of their own.
    static func registerDefaultCollapsed(_ keys: [String]) {
        UserDefaults.standard.register(
            defaults: Dictionary(uniqueKeysWithValues: keys.map { (prefix + $0, true) })
        )
    }

    /// One-time carry-over from a rail that kept its own fold store. Reads
    /// the old array of folded keys, writes each under `prefix + newKey`, and
    /// removes the old value so this runs once. Team used
    /// `team.sidebar.collapsedSections` before every rail shared this store.
    static func migrate(legacyArrayKey: String, keyPrefix: String) {
        let defaults = UserDefaults.standard
        guard let folded = defaults.stringArray(forKey: legacyArrayKey) else { return }
        for key in folded {
            setCollapsed(true, for: keyPrefix + key)
        }
        defaults.removeObject(forKey: legacyArrayKey)
    }
}

/// Document view for the rail's scroll view. Flipped so the content sits at the
/// top of the clip view and scrolls downwards; an unflipped document pins short
/// content to the bottom, which would leave the rail's headers floating.
@MainActor
final class SidebarDocumentView: NSView {
    override var isFlipped: Bool { true }
}

/// **The** foldable block of every left rail — Calendar, the in-meeting rail,
/// Work and Team all build from this one class. Uppercase header
/// that toggles its own body; on the header row, in shedding order: the
/// sort, filter, and an optional accessory control. No total: a count on a
/// rail header is noise nobody acts on.
/// Fold state lives in `MeetingSidebarFoldPreferences`, one namespace for all.
///
/// Two ways to fill it:
///
/// - **Fixed body** (`init(title:key:accessory:body:)`) — the meeting rail and
///   Calendar hand over views once and hide rows individually. The header
///   follows the body: when every row is hidden the whole block is, so a title
///   never floats over blank rail. `refresh()` re-reads that after a change.
/// - **Rows** (`init(title:key:hidesWhenEmpty:startsCollapsed:)` + `setRows`)
///   — Work and Team rebuild the list when it changes and say how many rows
///   are things, so the block knows when it is empty.
///   `hidesWhenEmpty` is that rail's own judgement about a block with nothing
///   in it: UNREAD goes away, MINE stays and says so.
///
/// The fold only ever touches the body *container*. State that hides rows
/// keeps doing so on the rows themselves, so a collapsed section can never
/// resurrect a row its owner says is not there.
@MainActor
final class SidebarSection: NSStackView {
    /// Set by the meeting when the header itself does not belong on screen —
    /// IDENTITY mid-call, WAITING ROOM for a guest. A hidden header takes the
    /// fold out of play: there would be no triangle left to click to undo it.
    var isHeaderHidden = false {
        didSet {
            guard isHeaderHidden != oldValue else { return }
            apply()
        }
    }

    var isCollapsed: Bool {
        didSet {
            guard isCollapsed != oldValue else { return }
            MeetingSidebarFoldPreferences.setCollapsed(isCollapsed, for: key)
            apply()
            onFoldChange?()
        }
    }

    /// Called after a fold, so the rail can settle its scroll view.
    var onFoldChange: (() -> Void)?
    /// The rail's own menu, asked for at click time so the state it draws —
    /// which sections are on, where this one sits — is never a stale copy.
    var contextMenuProvider: (() -> NSMenu?)?
    var onFilterChange: ((String) -> Void)?
    var onSortChange: ((String) -> Void)?

    /// What this section is filed under in preferences. The rail hands it
    /// back when a menu acts on the section it was opened over.
    var sectionKey: String { key }

    /// Kept off the rail by the owner. Distinct from `hidesWhenEmpty`, which
    /// is the rail's own judgement about a block with nothing in it: this one
    /// is a decision, and a section put away stays away even when it fills up.
    var isOnRail = true {
        didSet {
            guard isOnRail != oldValue else { return }
            apply()
        }
    }

    var title: String {
        get { titleText }
        set {
            guard newValue != titleText else { return }
            titleText = newValue
            apply()
        }
    }

    /// The rows this block is holding, for a selection pass over the rail.
    var rows: [NSView] { bodyStack.arrangedSubviews }

    /// A truncating popup will shed to nothing if it is allowed to — 5pt, in
    /// a narrow rail, which is a control nobody can hit. This is where the two
    /// stop. All of the row's floors together still come to 183pt, under the
    /// 240pt the sidebar itself stops at, so the column reaches its minimum
    /// with both popups still clickable and the section's name truncating.
    private static let popupFloor: CGFloat = 44
    /// Tall enough for the tallest header control (26pt) plus breathing room.
    static let headerHeight: CGFloat = 28
    /// The fold header is a pill, not a bare label: a 24pt bubble with room
    /// either side of the chevron and title, so the target is the whole
    /// word and its hover reads as one shape. Every rail's fold wears it.
    private static let disclosureHeight: CGFloat = 24
    private static let disclosurePadding: CGFloat = 10

    private let key: String
    private var titleText: String
    /// Fixed-body mode: the header follows the rows' own visibility.
    private let followsBodyVisibility: Bool
    private let hidesWhenEmpty: Bool
    private let startsCollapsed: Bool
    private let disclosure = NSButton()
    /// The pill's side padding. Below the title's own resistance (251) and
    /// the sort and filter (250, 249), so a narrow rail sheds the padding
    /// before any of them truncate.
    private lazy var disclosurePad = disclosure.widthAnchor.constraint(greaterThanOrEqualToConstant: 0)
    private let sortButton = NSPopUpButton(frame: .zero, pullsDown: false)
    private let filterButton = NSPopUpButton(frame: .zero, pullsDown: false)
    private let badge = NSTextField(labelWithString: "")
    private var badgeText: String?
    private var badgeIsAccented = true
    private let headerRow = NSStackView()
    private let bodyStack = NSStackView()
    /// While a search is running every section draws open: a match hidden
    /// inside a folded block is the same as no match at all. The preference
    /// is untouched, so clearing the field puts the folds back.
    private var forcedExpanded = false
    private var rowCount = 0
    private var filterOptions: [CrmSubjectStatusOption] = []
    private var filterCounts: [String: CrmSubjectStatusCount] = [:]
    private var filterCountsLoading = true
    private var sortOptions: [CrmSubjectSortOption] = []

    /// Fixed body: the meeting rail's and Calendar's form.
    convenience init(title: String, key: String, accessory: NSView? = nil, body: [NSView]) {
        self.init(
            title: title,
            key: key,
            accessory: accessory,
            followsBodyVisibility: true,
            hidesWhenEmpty: false,
            startsCollapsed: false
        )
        for view in body {
            view.translatesAutoresizingMaskIntoConstraints = false
            bodyStack.addArrangedSubview(view)
            view.widthAnchor.constraint(equalTo: bodyStack.widthAnchor).isActive = true
        }
        apply()
    }

    /// Rows: Work's and Team's form. Fill with `setRows`.
    convenience init(
        title: String,
        key: String,
        accessory: NSView? = nil,
        hidesWhenEmpty: Bool = false,
        startsCollapsed: Bool = false
    ) {
        self.init(
            title: title,
            key: key,
            accessory: accessory,
            followsBodyVisibility: false,
            hidesWhenEmpty: hidesWhenEmpty,
            startsCollapsed: startsCollapsed
        )
    }

    private init(
        title: String,
        key: String,
        accessory: NSView?,
        followsBodyVisibility: Bool,
        hidesWhenEmpty: Bool,
        startsCollapsed: Bool
    ) {
        self.key = key
        titleText = title
        self.followsBodyVisibility = followsBodyVisibility
        self.hidesWhenEmpty = hidesWhenEmpty
        self.startsCollapsed = startsCollapsed
        isCollapsed = startsCollapsed || MeetingSidebarFoldPreferences.isCollapsed(key)
        super.init(frame: .zero)

        disclosure.bezelStyle = .inline
        SettingsChrome.applyQuietButton(disclosure, cornerRadius: Self.disclosureHeight / 2)
        disclosure.heightAnchor.constraint(equalToConstant: Self.disclosureHeight).isActive = true
        disclosurePad.priority = NSLayoutConstraint.Priority(248)
        disclosurePad.isActive = true
        disclosure.font = StarlingsTypography.sectionLabelFont
        disclosure.contentTintColor = StarlingsColors.secondaryText
        disclosure.imagePosition = .imageLeading
        disclosure.imageHugsTitle = true
        disclosure.target = self
        disclosure.action = #selector(toggleFold)
        disclosure.setContentHuggingPriority(.required, for: .horizontal)
        // **A header may not decide how wide the rail is.** Every control on
        // this row hugs at `.required`, which is right — none of them should
        // be stretched — but hugging says nothing about being *squeezed*, and
        // at the default resistance the row's intrinsic width became the
        // column's real floor. ENVISIONING measured 401pt with a long lead
        // status in the filter, against a documented sidebar minimum of 240:
        // the divider was pinned against a constraint it could not satisfy,
        // and the sidebar would not drag at all. The titles truncate instead.
        // Distinct priorities so the row sheds in a stated order rather than
        // whichever control AppKit reaches first: the filter goes, then the
        // sort, and the section's own name is the last thing to truncate.
        disclosure.setContentCompressionResistancePriority(
            NSLayoutConstraint.Priority(251), for: .horizontal
        )
        disclosure.cell?.lineBreakMode = .byTruncatingTail

        badge.font = StarlingsTypography.sectionLabelFont
        badge.wantsLayer = true
        badge.layer?.cornerRadius = 8
        badge.isHidden = true
        badge.setContentHuggingPriority(.required, for: .horizontal)
        badge.setContentCompressionResistancePriority(.required, for: .horizontal)

        for popup in [sortButton, filterButton] {
            popup.bezelStyle = .inline
            popup.isBordered = false
            popup.controlSize = .small
            popup.font = .systemFont(ofSize: StarlingsTypography.scaled(10), weight: .medium)
            popup.contentTintColor = StarlingsColors.secondaryText
            popup.target = self
            SettingsChrome.applyQuietButton(popup)
            popup.setContentHuggingPriority(.required, for: .horizontal)
            (popup.cell as? NSPopUpButtonCell)?.lineBreakMode = .byTruncatingTail
            popup.widthAnchor.constraint(greaterThanOrEqualToConstant: Self.popupFloor).isActive = true
            popup.isHidden = true
        }
        sortButton.action = #selector(sortChanged)
        sortButton.setContentCompressionResistancePriority(NSLayoutConstraint.Priority(250), for: .horizontal)
        filterButton.action = #selector(filterChanged)
        // The widest thing on the row: "Waiting on External Factor" alone is
        // 150pt. It is also the least important of the three, so it gives
        // first.
        filterButton.setContentCompressionResistancePriority(NSLayoutConstraint.Priority(249), for: .horizontal)

        headerRow.orientation = .horizontal
        headerRow.alignment = .centerY
        headerRow.spacing = 8
        headerRow.addArrangedSubview(disclosure)
        headerRow.addArrangedSubview(badge)
        headerRow.addArrangedSubview(NSView())
        headerRow.addArrangedSubview(sortButton)
        headerRow.addArrangedSubview(filterButton)
        if let accessory {
            headerRow.addArrangedSubview(accessory)
            accessory.setContentHuggingPriority(.required, for: .horizontal)
        }

        bodyStack.orientation = .vertical
        bodyStack.alignment = .leading
        bodyStack.spacing = 2

        orientation = .vertical
        alignment = .leading
        spacing = 4
        addArrangedSubview(headerRow)
        addArrangedSubview(bodyStack)
        headerRow.widthAnchor.constraint(equalTo: widthAnchor).isActive = true
        // One header height on every rail. The row is centre-aligned, so a
        // tall control (Team's 26pt New group button, Work's sort and
        // filter) would otherwise grow the row and move the chevron and
        // title down a few points relative to a rail whose header carries
        // only a count — Docs beside Team, at a glance.
        headerRow.heightAnchor.constraint(equalToConstant: Self.headerHeight).isActive = true
        bodyStack.widthAnchor.constraint(equalTo: widthAnchor).isActive = true
        apply()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    // MARK: - Rows

    /// `count` is the rows that are *things*, not the labels and empty lines
    /// between them, which is why it is passed rather than counted. The
    /// header never shows it; it says whether the block is empty.
    func setRows(_ rows: [NSView], count: Int) {
        bodyStack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        for row in rows {
            row.translatesAutoresizingMaskIntoConstraints = false
            bodyStack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: bodyStack.widthAnchor).isActive = true
        }
        rowCount = count
        apply()
    }

    /// Re-reads the body's own visibility and applies the fold on top of it.
    /// Fixed-body sections call this after anything shows or hides a row.
    func refresh() {
        apply()
    }

    // MARK: - Header controls

    func setFilter(
        options: [CrmSubjectStatusOption],
        selectedID: String,
        onChange: @escaping (String) -> Void
    ) {
        filterOptions = options
        onFilterChange = onChange
        filterCounts = [:]
        filterCountsLoading = true
        rebuildFilterItems(selectedID: selectedID)
        filterButton.isHidden = options.isEmpty
    }

    func setFilterCounts(
        _ counts: [String: CrmSubjectStatusCount],
        loading: Bool = false
    ) {
        let selectedID = filterButton.selectedItem?.representedObject as? String
        filterCounts = counts
        filterCountsLoading = loading
        rebuildFilterItems(selectedID: selectedID)
    }

    /// Order, not filter — no counts on the options, since a sort never
    /// changes which subjects show, only what order they're in.
    func setSort(
        options: [CrmSubjectSortOption],
        selectedID: String,
        onChange: @escaping (String) -> Void
    ) {
        sortOptions = options
        onSortChange = onChange
        sortButton.removeAllItems()
        for option in options {
            sortButton.addItem(withTitle: option.title)
            sortButton.lastItem?.representedObject = option.id
        }
        if let index = options.firstIndex(where: { $0.id == selectedID }) {
            sortButton.selectItem(at: index)
        }
        sortButton.isHidden = options.isEmpty
    }

    /// What the header says while the section is folded shut — "2 WAITING" over
    /// a closed WAITING ROOM. Folding a block is a decision about clutter, not
    /// about being told things: news inside a shut section still has to reach
    /// the owner, and an accented pill is loud enough to act on. Nil clears it.
    ///
    /// Only shown while the body is hidden. An open section is already showing
    /// the rows the pill would be counting. Distinct from the plain count,
    /// which reports size and shows either way.
    func setBadge(_ text: String?, accented: Bool = true) {
        guard text != badgeText || accented != badgeIsAccented else { return }
        badgeText = text
        badgeIsAccented = accented
        applyBadgeStyle()
        apply()
    }

    // MARK: - Fold

    func setForcedExpanded(_ forced: Bool) {
        guard forced != forcedExpanded else { return }
        forcedExpanded = forced
        apply()
    }

    /// Somewhere else in the app named a row in this block. Whatever the
    /// fold said, it has to be visible now.
    func expand() {
        isCollapsed = false
    }

    /// An optional section starts quiet whenever its window is brought
    /// forward. This does not remove the user's ability to open it for the
    /// current visit.
    func startCollapsed() {
        guard startsCollapsed else { return }
        isCollapsed = true
    }

    // MARK: - Layout

    private func apply() {
        let bodyIsEmpty = followsBodyVisibility
            // A body whose every row is hidden — or which has no rows yet —
            // has nothing to head, so the header goes with it rather than
            // leaving a title over blank rail.
            ? bodyStack.arrangedSubviews.allSatisfy(\.isHidden)
            : (hidesWhenEmpty && rowCount == 0)
        let expanded = forcedExpanded || !isCollapsed
        headerRow.isHidden = isHeaderHidden || bodyIsEmpty
        bodyStack.isHidden = bodyIsEmpty || (!expanded && !headerRow.isHidden)
        isHidden = !isOnRail || (headerRow.isHidden && bodyStack.isHidden)

        badge.isHidden = badgeText == nil || !bodyStack.isHidden || headerRow.isHidden

        disclosure.title = titleText
        disclosure.image = NSImage(
            systemSymbolName: bodyStack.isHidden ? "chevron.right" : "chevron.down",
            accessibilityDescription: nil
        )?.withSymbolConfiguration(.init(pointSize: 9, weight: .semibold))
        disclosurePad.constant = disclosure.intrinsicContentSize.width + Self.disclosurePadding * 2
        disclosure.setAccessibilityLabel(titleText)
        disclosure.setAccessibilityExpanded(!bodyStack.isHidden)
    }

    private func applyBadgeStyle() {
        guard let badgeText else { return }
        // Padded with spaces rather than insets — same trick the stage's name
        // badge uses, and the only one an NSTextField takes without a wrapper.
        badge.stringValue = "  \(badgeText.uppercased())  "
        badge.textColor = badgeIsAccented ? StarlingsColors.accentInk : StarlingsColors.primaryText
        // The quiet badge is a surface rung, not a white veil: a 12% white chip
        // on a white panel is invisible in light.
        badge.layer?.backgroundColor = StarlingsColors.resolved(
            badgeIsAccented ? StarlingsColors.accent : StarlingsColors.elevated,
            for: badge
        ).cgColor
        badge.setAccessibilityLabel(badgeText)
    }

    private func rebuildFilterItems(selectedID: String? = nil) {
        let selected = selectedID ?? (filterButton.selectedItem?.representedObject as? String)
        filterButton.removeAllItems()
        for option in filterOptions {
            let suffix: String
            if let count = filterCounts[option.id] {
                suffix = count.displayText
            } else if filterCountsLoading {
                suffix = "…"
            } else {
                // A failed facet request stays visibly unavailable instead of
                // silently looking like an empty category.
                suffix = "—"
            }
            filterButton.addItem(withTitle: "\(option.title) (\(suffix))")
            filterButton.lastItem?.representedObject = option.id
        }
        if let selected,
           let index = filterOptions.firstIndex(where: { $0.id == selected }) {
            filterButton.selectItem(at: index)
        }
    }

    // MARK: - Actions

    @objc private func toggleFold() {
        isCollapsed.toggle()
    }

    @objc private func filterChanged() {
        guard let value = filterButton.selectedItem?.representedObject as? String else { return }
        onFilterChange?(value)
    }

    @objc private func sortChanged() {
        guard let value = sortButton.selectedItem?.representedObject as? String else { return }
        onSortChange?(value)
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        contextMenuProvider?() ?? super.menu(for: event)
    }
}
