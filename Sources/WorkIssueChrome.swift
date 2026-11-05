import AppKit

/// The native scope controls shared by Work's task and issue lists.
///
/// Status stays directly available, search fills the remaining first-row
/// space, and the less frequent facets live in one popover. Sorting is a
/// separate choice because it changes order rather than narrowing the list.
@MainActor
final class WorkFilterBar: NSView {
    struct Facet {
        let title: String
        let popup: NSPopUpButton
    }

    var onStateChange: ((Int) -> Void)?
    var onSearchChange: ((String) -> Void)?
    var onSortChange: ((Int) -> Void)?
    var onClearFilters: (() -> Void)?

    private let stateControl: NSSegmentedControl
    private let searchField = NSSearchField(frame: .zero)
    private let filterButton = NSButton(title: String(localized: "Filters"), target: nil, action: nil)
    private let sortLabel = NSTextField(labelWithString: String(localized: "Sort"))
    private let sortPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    private let clearButton = NSButton(title: String(localized: "Clear filters"), target: nil, action: nil)
    private let filterPopover = NSPopover()
    private let filterStack = NSStackView()
    private let popoverStack = NSStackView()
    private var facetWidthConstraints: [ObjectIdentifier: NSLayoutConstraint] = [:]
    private var hasFacets = false
    private var canClearFilters = false

    init(stateTitles: [String], searchPlaceholder: String, sortTitles: [String]) {
        stateControl = NSSegmentedControl(
            labels: stateTitles,
            trackingMode: .selectOne,
            target: nil,
            action: nil
        )
        super.init(frame: .zero)

        stateControl.controlSize = .small
        stateControl.selectedSegment = 0
        stateControl.setAccessibilityLabel(String(localized: "Status"))
        stateControl.target = self
        stateControl.action = #selector(stateChanged)
        stateControl.setContentHuggingPriority(.required, for: .horizontal)
        stateControl.setContentCompressionResistancePriority(.required, for: .horizontal)

        searchField.controlSize = .small
        searchField.placeholderString = searchPlaceholder
        searchField.setAccessibilityLabel(searchPlaceholder)
        searchField.sendsWholeSearchString = false
        searchField.sendsSearchStringImmediately = true
        searchField.target = self
        searchField.action = #selector(searchChanged)
        searchField.setContentHuggingPriority(.defaultLow, for: .horizontal)
        searchField.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        filterButton.controlSize = .small
        filterButton.bezelStyle = .rounded
        filterButton.image = NSImage(
            systemSymbolName: "line.3.horizontal.decrease.circle",
            accessibilityDescription: nil
        )
        filterButton.imagePosition = .imageLeading
        filterButton.setAccessibilityLabel(String(localized: "Filters"))
        filterButton.target = self
        filterButton.action = #selector(toggleFilterPopover)
        filterButton.setContentHuggingPriority(.required, for: .horizontal)

        sortPopup.controlSize = .small
        sortPopup.target = self
        sortPopup.action = #selector(sortChanged)
        sortPopup.setContentHuggingPriority(.required, for: .horizontal)
        sortTitles.forEach { sortPopup.addItem(withTitle: $0) }
        sortPopup.selectItem(at: 0)
        sortPopup.setAccessibilityLabel(String(localized: "Sort"))

        clearButton.controlSize = .small
        clearButton.bezelStyle = .rounded
        clearButton.target = self
        clearButton.action = #selector(clearFilters)
        clearButton.setContentHuggingPriority(.required, for: .horizontal)

        sortLabel.setContentHuggingPriority(.required, for: .horizontal)

        let scopeRow = NSStackView(views: [stateControl, searchField])
        scopeRow.orientation = .horizontal
        scopeRow.alignment = .centerY
        scopeRow.spacing = 8
        scopeRow.distribution = .fill

        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        spacer.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let optionsRow = NSStackView(views: [filterButton, spacer, sortLabel, sortPopup])
        optionsRow.orientation = .horizontal
        optionsRow.alignment = .centerY
        optionsRow.spacing = 8
        optionsRow.distribution = .fill

        let rows = NSStackView(views: [scopeRow, optionsRow])
        rows.orientation = .vertical
        rows.alignment = .leading
        rows.spacing = 6
        rows.translatesAutoresizingMaskIntoConstraints = false
        addSubview(rows)
        NSLayoutConstraint.activate([
            rows.leadingAnchor.constraint(equalTo: leadingAnchor),
            rows.trailingAnchor.constraint(equalTo: trailingAnchor),
            rows.topAnchor.constraint(equalTo: topAnchor),
            rows.bottomAnchor.constraint(equalTo: bottomAnchor),
            scopeRow.widthAnchor.constraint(equalTo: rows.widthAnchor),
            optionsRow.widthAnchor.constraint(equalTo: rows.widthAnchor),
            searchField.widthAnchor.constraint(greaterThanOrEqualToConstant: 80),
        ])

        filterStack.orientation = .vertical
        filterStack.alignment = .leading
        filterStack.spacing = 8
        filterStack.translatesAutoresizingMaskIntoConstraints = false

        let clearRow = NSStackView(views: [NSView(), clearButton])
        clearRow.orientation = .horizontal
        clearRow.alignment = .centerY
        clearRow.distribution = .fill
        clearRow.spacing = 8
        popoverStack.orientation = .vertical
        popoverStack.alignment = .leading
        popoverStack.spacing = 12
        popoverStack.edgeInsets = NSEdgeInsets(top: 14, left: 14, bottom: 14, right: 14)
        popoverStack.addArrangedSubview(filterStack)
        popoverStack.addArrangedSubview(clearRow)
        popoverStack.translatesAutoresizingMaskIntoConstraints = false

        let popoverController = NSViewController()
        popoverController.view = NSView(frame: NSRect(x: 0, y: 0, width: 300, height: 120))
        popoverController.view.addSubview(popoverStack)
        NSLayoutConstraint.activate([
            popoverStack.leadingAnchor.constraint(equalTo: popoverController.view.leadingAnchor),
            popoverStack.trailingAnchor.constraint(equalTo: popoverController.view.trailingAnchor),
            popoverStack.topAnchor.constraint(equalTo: popoverController.view.topAnchor),
            popoverStack.bottomAnchor.constraint(equalTo: popoverController.view.bottomAnchor),
        ])
        filterPopover.behavior = .transient
        filterPopover.contentViewController = popoverController
        filterPopover.contentSize = NSSize(width: 300, height: 120)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func selectState(_ index: Int) {
        guard stateControl.segmentCount > 0 else { return }
        stateControl.selectedSegment = min(max(index, 0), stateControl.segmentCount - 1)
    }

    func selectSort(_ index: Int) {
        guard sortPopup.numberOfItems > 0 else { return }
        sortPopup.selectItem(at: min(max(index, 0), sortPopup.numberOfItems - 1))
    }

    func setSearchText(_ text: String) {
        searchField.stringValue = text
    }

    func setFacets(_ facets: [Facet]) {
        for view in Array(filterStack.arrangedSubviews) {
            filterStack.removeArrangedSubview(view)
            view.removeFromSuperview()
        }

        for facet in facets {
            let label = NSTextField(labelWithString: facet.title)
            label.setContentHuggingPriority(.required, for: .horizontal)
            label.setContentCompressionResistancePriority(.required, for: .horizontal)
            facet.popup.controlSize = .small
            facet.popup.setAccessibilityLabel(facet.title)
            facet.popup.setContentHuggingPriority(.defaultLow, for: .horizontal)
            facet.popup.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            let popupID = ObjectIdentifier(facet.popup)
            if facetWidthConstraints[popupID] == nil {
                let constraint = facet.popup.widthAnchor.constraint(greaterThanOrEqualToConstant: 160)
                constraint.isActive = true
                facetWidthConstraints[popupID] = constraint
            }

            let row = NSStackView(views: [label, facet.popup])
            row.orientation = .horizontal
            row.alignment = .centerY
            row.spacing = 12
            row.distribution = .fill
            row.widthAnchor.constraint(equalToConstant: 270).isActive = true
            filterStack.addArrangedSubview(row)
        }

        hasFacets = !facets.isEmpty
        filterButton.isHidden = !hasFacets && !canClearFilters
        if !hasFacets, !canClearFilters, filterPopover.isShown {
            filterPopover.performClose(self)
        }
        updatePopoverSize()
    }

    func setActiveFilters(_ count: Int, canClear: Bool) {
        canClearFilters = canClear
        let symbol = count > 0
            ? "line.3.horizontal.decrease.circle.fill"
            : "line.3.horizontal.decrease.circle"
        filterButton.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
        filterButton.title = count > 0
            ? String.localizedStringWithFormat(String(localized: "Filters (%lld)"), Int64(count))
            : String(localized: "Filters")
        filterButton.setAccessibilityLabel(filterButton.title)
        filterButton.isHidden = !hasFacets && !canClearFilters
        clearButton.isEnabled = canClear
    }

    private func updatePopoverSize() {
        popoverStack.layoutSubtreeIfNeeded()
        let height = max(68, popoverStack.fittingSize.height)
        filterPopover.contentSize = NSSize(width: 300, height: height)
    }

    @objc private func stateChanged() {
        onStateChange?(stateControl.selectedSegment)
    }

    @objc private func searchChanged() {
        onSearchChange?(searchField.stringValue)
    }

    @objc private func sortChanged() {
        onSortChange?(sortPopup.indexOfSelectedItem)
    }

    @objc private func toggleFilterPopover() {
        if filterPopover.isShown {
            filterPopover.performClose(self)
        } else {
            filterPopover.show(relativeTo: filterButton.bounds, of: filterButton, preferredEdge: .minY)
        }
    }

    @objc private func clearFilters() {
        filterPopover.performClose(clearButton)
        onClearFilters?()
    }
}
/// The furniture an issue needs on both sides of the Work window: the coloured
/// label GitHub draws, and the bar that narrows a list the way GitHub's own
/// filters do.
///
/// Kept out of `WorkWindowController` because the list and the inspector both
/// draw labels, and a chip that looked different in the two columns would read
/// as two different things.

// MARK: - Labels

/// One GitHub label, in GitHub's colour, legible on either of this app's
/// grounds.
///
/// GitHub paints a label as flat colour with white or black text, which works
/// against its own two backgrounds and nowhere else: `#0e8a16` on this app's
/// dark panel is a solid green brick, and a pale `#fef2c0` is a white slab. So
/// the hue is kept and the treatment is the app's — a wash of the colour, a
/// border of it, and the colour itself as ink, lifted or darkened only as far
/// as it must be to stay readable on the ground it lands on.
@MainActor
final class StarlingsLabelChip: NSView {
    private let label: CrmIssueLabel
    private let text = NSTextField(labelWithString: "")
    private let onGround: NSColor
    private let emphasized: Bool

    init(
        _ label: CrmIssueLabel,
        displayName: String? = nil,
        font: NSFont = .systemFont(ofSize: StarlingsTypography.scaled(10), weight: .medium),
        ground: NSColor = StarlingsColors.panel,
        emphasized: Bool = false
    ) {
        self.label = label
        self.onGround = ground
        self.emphasized = emphasized
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 7
        layer?.borderWidth = 1

        text.stringValue = displayName ?? label.name
        text.font = font
        text.lineBreakMode = .byTruncatingTail
        text.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        text.translatesAutoresizingMaskIntoConstraints = false
        addSubview(text)
        NSLayoutConstraint.activate([
            text.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 6),
            text.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -6),
            text.centerYAnchor.constraint(equalTo: centerYAnchor),
            heightAnchor.constraint(equalToConstant: 15),
        ])
        setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        setAccessibilityLabel(String(localized: "Label \(displayName ?? label.name)"))
        recolour()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        recolour()
    }

    private func recolour() {
        // A label with no colour is one Core could not tell us about, not a
        // black one. It takes the app's own quiet treatment.
        let hue = StarlingsLabelChip.colour(from: label.color)
            ?? StarlingsColors.resolved(StarlingsColors.secondaryText, for: self)
        let dark = StarlingsColors.isDark(effectiveAppearance)
        let ink = StarlingsLabelChip.readable(hue, on: StarlingsColors.resolved(onGround, for: self), dark: dark)
        layer?.backgroundColor = hue.withAlphaComponent(dark ? 0.20 : 0.16).cgColor
        // The label a filter matched on reads as picked out, not just present
        // — a stronger border, not a second colour, so it stays this label's
        // own hue rather than borrowing the app's accent.
        layer?.borderWidth = emphasized ? 1.5 : 1
        layer?.borderColor = hue.withAlphaComponent(emphasized ? (dark ? 0.85 : 0.75) : (dark ? 0.42 : 0.36)).cgColor
        text.textColor = ink
    }

    /// A filled dot in a label's own colour, for a menu where the name alone
    /// is twenty rows of identical ink.
    static func swatch(_ colour: NSColor, size: CGFloat = 10) -> NSImage {
        let image = NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
            colour.setFill()
            NSBezierPath(ovalIn: rect.insetBy(dx: 0.5, dy: 0.5)).fill()
            return true
        }
        // Template rendering would flatten it to the menu's own ink, which is
        // the one thing a colour swatch must not become.
        image.isTemplate = false
        return image
    }

    /// `d73a4a`, with or without its hash. Anything else is no colour at all.
    static func colour(from hex: String?) -> NSColor? {
        guard var raw = hex?.trimmingCharacters(in: .whitespaces).lowercased() else { return nil }
        if raw.hasPrefix("#") { raw.removeFirst() }
        guard raw.count == 6, let value = UInt32(raw, radix: 16) else { return nil }
        return NSColor(
            srgbRed: CGFloat((value >> 16) & 0xFF) / 255,
            green: CGFloat((value >> 8) & 0xFF) / 255,
            blue: CGFloat(value & 0xFF) / 255,
            alpha: 1
        )
    }

    /// The label's own colour, moved toward or away from the ground until it
    /// carries enough contrast to read as text rather than as decoration.
    ///
    /// GitHub's palette runs from near-black to near-white, so neither
    /// lightening nor darkening alone is right — the direction depends on the
    /// ground, and the distance on how far the colour already is from it.
    static func readable(_ colour: NSColor, on ground: NSColor, dark: Bool) -> NSColor {
        guard let base = colour.usingColorSpace(.sRGB) else { return colour }
        var step = 0.0
        var candidate = base
        // Sixteen small moves rather than one guess: a colour already legible
        // is left exactly as it is, which keeps a brand red looking like it.
        while step <= 0.8 {
            if contrast(candidate, ground) >= 4.0 { return candidate }
            step += 0.05
            candidate = dark
                ? base.blended(withFraction: step, of: .white) ?? base
                : base.blended(withFraction: step, of: .black) ?? base
        }
        return candidate
    }

    private static func luminance(_ colour: NSColor) -> CGFloat {
        guard let srgb = colour.usingColorSpace(.sRGB) else { return 0 }
        let channel = { (value: CGFloat) -> CGFloat in
            value <= 0.03928 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * channel(srgb.redComponent)
            + 0.7152 * channel(srgb.greenComponent)
            + 0.0722 * channel(srgb.blueComponent)
    }

    private static func contrast(_ one: NSColor, _ other: NSColor) -> CGFloat {
        let first = luminance(one)
        let second = luminance(other)
        return (max(first, second) + 0.05) / (min(first, second) + 0.05)
    }
}

/// A row of chips that wraps rather than truncating, because a label nobody
/// can see is a filter nobody knows is available.
@MainActor
final class StarlingsLabelChipRow: NSView {
    private var rows: [NSStackView] = []
    private let column = NSStackView()
    private let labels: [CrmIssueLabel]
    private let ground: NSColor
    private var laidOutWidth: CGFloat = 0

    init(_ labels: [CrmIssueLabel], ground: NSColor = StarlingsColors.panel) {
        self.labels = labels
        self.ground = ground
        super.init(frame: .zero)
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 4
        column.translatesAutoresizingMaskIntoConstraints = false
        addSubview(column)
        column.pinToEdges(of: self)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func layout() {
        super.layout()
        // Re-flowing on every layout pass would rebuild the chips while the
        // divider is being dragged; only a real width change matters.
        guard abs(bounds.width - laidOutWidth) > 1, bounds.width > 0 else { return }
        laidOutWidth = bounds.width
        reflow(within: bounds.width)
    }

    private func reflow(within width: CGFloat) {
        rows.forEach { $0.removeFromSuperview() }
        rows = []
        var current = newRow()
        var used: CGFloat = 0
        for label in labels {
            let chip = StarlingsLabelChip(label, ground: ground)
            let needed = chip.fittingSize.width
            if used > 0 && used + needed + 4 > width {
                current = newRow()
                used = 0
            }
            current.addArrangedSubview(chip)
            used += needed + 4
        }
    }

    private func newRow() -> NSStackView {
        let row = NSStackView()
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 4
        rows.append(row)
        column.addArrangedSubview(row)
        return row
    }
}

/// A one-line issue summary for list rows. The detail pane remains the
/// complete label view; this is deliberately a summary so a repository with
/// many routing labels does not turn every 56-point row into a card.
@MainActor
final class StarlingsIssueSummaryPills: NSView {
    private static let maximumVisible = 3
    private let row = NSStackView()

    init(
        _ labels: [CrmIssueLabel],
        highlightedLabel: String? = nil,
        ground: NSColor = StarlingsColors.panel
    ) {
        super.init(frame: .zero)

        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 4
        row.translatesAutoresizingMaskIntoConstraints = false
        row.setContentHuggingPriority(.required, for: .horizontal)
        row.setContentCompressionResistancePriority(.required, for: .horizontal)
        addSubview(row)
        row.pinToEdges(of: self)

        let ordered = Self.orderedUnique(labels)
        var visible = Array(ordered.prefix(Self.maximumVisible))
        if let highlighted = ordered.first(where: { $0.name == highlightedLabel }),
           !visible.contains(where: { $0.name == highlighted.name }) {
            if visible.count == Self.maximumVisible {
                visible.removeLast()
            }
            visible.append(highlighted)
            visible.sort(by: Self.isHigherPriority)
        }

        for label in visible {
            let chip = StarlingsLabelChip(
                label,
                displayName: Self.displayName(for: label.name),
                ground: ground,
                emphasized: highlightedLabel.map {
                    label.name.localizedCaseInsensitiveCompare($0) == .orderedSame
                } ?? false
            )
            chip.setContentHuggingPriority(.required, for: .horizontal)
            chip.setContentCompressionResistancePriority(.required, for: .horizontal)
            row.addArrangedSubview(chip)
        }

        let hidden = ordered.count - visible.count
        if hidden > 0 {
            let hiddenLabels = ordered
                .filter { label in !visible.contains { shown in shown.name == label.name } }
                .map(\.name)
                .joined(separator: ", ")
            let overflow = CrmIssueLabel(name: "+\(hidden)", color: nil, description: nil)
            let chip = StarlingsLabelChip(overflow, ground: ground)
            chip.setAccessibilityLabel(String(localized: "More labels: \(hiddenLabels)"))
            chip.setContentHuggingPriority(.required, for: .horizontal)
            chip.setContentCompressionResistancePriority(.required, for: .horizontal)
            row.addArrangedSubview(chip)
        }

        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel(String(localized: "Labels: \(ordered.map(\.name).joined(separator: ", "))"))
    }

    override var intrinsicContentSize: NSSize {
        let size = row.fittingSize
        return NSSize(width: size.width, height: 15)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private static func orderedUnique(_ labels: [CrmIssueLabel]) -> [CrmIssueLabel] {
        var seen = Set<String>()
        return labels
            .filter { seen.insert($0.name).inserted }
            .sorted(by: isHigherPriority)
    }

    private static func isHigherPriority(_ lhs: CrmIssueLabel, _ rhs: CrmIssueLabel) -> Bool {
        let leftRank = rank(for: lhs.name)
        let rightRank = rank(for: rhs.name)
        if leftRank != rightRank { return leftRank < rightRank }
        return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
    }

    private static func rank(for name: String) -> Int {
        switch name {
        case "blocked": return 0
        case "needs-info": return 1
        case "needs-triage": return 2
        case "ready-for-review": return 3
        case "ready-for-human": return 4
        case "ready-for-agent": return 5
        case "priority:p0": return 10
        case "priority:p1": return 11
        case "priority:p2": return 12
        case "priority:p3": return 13
        case "bug": return 20
        case "enhancement": return 21
        case "tech-debt": return 22
        case "chore": return 23
        case "documentation": return 24
        case "question": return 25
        case let name where name.hasPrefix("area:"): return 30
        default: return 40
        }
    }

    private static func displayName(for name: String) -> String {
        if name.hasPrefix("priority:") {
            return String(name.dropFirst("priority:".count)).uppercased()
        }
        if name.hasPrefix("area:") {
            let area = String(name.dropFirst("area:".count))
            switch area {
            case "macos": return "macOS"
            case "ios": return "iOS"
            case "api": return "API"
            default: return area.replacingOccurrences(of: "-", with: " ").capitalized
            }
        }
        return name.replacingOccurrences(of: "-", with: " ").capitalized
    }
}

// MARK: - The filter bars

/// GitHub issue filters. The shared `WorkFilterBar` owns the native control
/// layout; this adapter owns GitHub's server-facing choices and local search.
@MainActor
final class WorkIssueFilterBar: NSView {
    var onChange: ((CrmIssueFilter) -> Void)?

    private(set) var filter = CrmIssueFilter()
    private let controls = WorkFilterBar(
        stateTitles: CrmIssueFilter.State.allCases.map(\.menuTitle),
        searchPlaceholder: String(localized: "Filter these issues"),
        sortTitles: CrmIssueFilter.Sort.allCases.map(\.menuTitle) + [String(localized: "Oldest")]
    )
    private let labelPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    private let assigneePopup = NSPopUpButton(frame: .zero, pullsDown: false)
    private let milestonePopup = NSPopUpButton(frame: .zero, pullsDown: false)
    /// Milestones are chosen by title and sent by number — GitHub takes the
    /// number, and nobody knows an issue's milestone by its number.
    private var milestoneNumbers: [String: String] = [:]

    init() {
        super.init(frame: .zero)

        for popup in [labelPopup, assigneePopup, milestonePopup] {
            popup.target = self
        }
        labelPopup.action = #selector(labelChanged)
        assigneePopup.action = #selector(assigneeChanged)
        milestonePopup.action = #selector(milestoneChanged)

        controls.onStateChange = { [weak self] index in
            guard let self else { return }
            let states = CrmIssueFilter.State.allCases
            filter.state = states[min(max(index, 0), states.count - 1)]
            report()
        }
        controls.onSearchChange = { [weak self] value in
            guard let self else { return }
            filter.search = value
            report()
        }
        controls.onSortChange = { [weak self] index in
            guard let self else { return }
            let sorts = CrmIssueFilter.Sort.allCases
            if index >= sorts.count {
                // Oldest is the created sort read the other way round, as in
                // GitHub's own menu.
                filter.sort = .created
                filter.ascending = true
            } else {
                filter.sort = sorts[min(max(index, 0), sorts.count - 1)]
                filter.ascending = false
            }
            report()
        }
        controls.onClearFilters = { [weak self] in self?.clearFilters() }

        controls.translatesAutoresizingMaskIntoConstraints = false
        addSubview(controls)
        controls.pinToEdges(of: self)
        controls.setFacets([
            .init(title: String(localized: "Labels"), popup: labelPopup),
            .init(title: String(localized: "Assignee"), popup: assigneePopup),
            .init(title: String(localized: "Milestone"), popup: milestonePopup),
        ])
        syncActiveFilters()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// Fill the menus from what came back. A selected value stays available
    /// even if it no longer appears in the current result page.
    func offer(_ issues: [CrmIssue]) {
        let labels = Set(issues.flatMap(\.labels)).union(filter.labels).sorted()
        fill(
            labelPopup,
            all: String(localized: "All labels"),
            options: labels.map { (title: $0, value: $0) },
            chosen: filter.labels.first
        )

        var logins = Set(issues.flatMap { issue in issue.assignees.map(\.login) })
        logins.formUnion(issues.compactMap(\.assigneeLogin))
        if let chosen = filter.assignee, chosen != "none" { logins.insert(chosen) }
        fill(
            assigneePopup,
            all: String(localized: "Anyone"),
            options: logins.sorted().map { (title: $0, value: $0) },
            chosen: filter.assignee == "none" ? nil : filter.assignee,
            extra: (title: String(localized: "Nobody"), value: "none"),
            selectExtra: filter.assignee == "none"
        )

        let previouslyKnownMilestones = milestoneNumbers
        milestoneNumbers = [:]
        for issue in issues {
            guard let milestone = issue.milestoneDetail, let number = milestone.number else { continue }
            milestoneNumbers[milestone.title] = String(number)
        }
        if let selected = filter.milestone, selected != "none",
           !milestoneNumbers.values.contains(selected) {
            let previousTitle = previouslyKnownMilestones.first { $0.value == selected }?.key
            let selectedTitle = milestonePopup.selectedItem?.representedObject as? String == selected
                ? milestonePopup.titleOfSelectedItem
                : nil
            milestoneNumbers[previousTitle ?? selectedTitle ?? "#\(selected)"] = selected
        }
        fill(
            milestonePopup,
            all: String(localized: "Any milestone"),
            options: milestoneNumbers.keys.sorted().compactMap { title in
                milestoneNumbers[title].map { (title: title, value: $0) }
            },
            chosen: filter.milestone,
            extra: (title: String(localized: "No milestone"), value: "none"),
            selectExtra: filter.milestone == "none"
        )

        var facets: [WorkFilterBar.Facet] = []
        if !labels.isEmpty { facets.append(.init(title: String(localized: "Labels"), popup: labelPopup)) }
        if !logins.isEmpty || filter.assignee != nil {
            facets.append(.init(title: String(localized: "Assignee"), popup: assigneePopup))
        }
        if !milestoneNumbers.isEmpty || filter.milestone != nil {
            facets.append(.init(title: String(localized: "Milestone"), popup: milestonePopup))
        }
        controls.setFacets(facets)
        syncActiveFilters()
    }

    private func fill(
        _ popup: NSPopUpButton,
        all: String,
        options: [(title: String, value: String)],
        chosen: String?,
        extra: (title: String, value: String)? = nil,
        selectExtra: Bool = false
    ) {
        popup.removeAllItems()
        popup.addItem(withTitle: all)
        if let extra {
            popup.menu?.addItem(.separator())
            popup.addItem(withTitle: extra.title)
            popup.lastItem?.representedObject = extra.value
        }
        if !options.isEmpty {
            popup.menu?.addItem(.separator())
            for option in options {
                popup.addItem(withTitle: option.title)
                popup.lastItem?.representedObject = option.value
            }
        }
        if selectExtra, let extra,
           let index = popup.itemArray.firstIndex(where: { ($0.representedObject as? String) == extra.value }) {
            popup.selectItem(at: index)
        } else if let chosen,
                  let index = popup.itemArray.firstIndex(where: { ($0.representedObject as? String) == chosen }) {
            popup.selectItem(at: index)
        } else {
            popup.selectItem(at: 0)
        }
    }

    /// The leading “all” item has no value, and separators cannot be selected.
    private func chosenValue(_ popup: NSPopUpButton) -> String? {
        popup.selectedItem?.representedObject as? String
    }

    @objc private func labelChanged() {
        filter.labels = chosenValue(labelPopup).map { [$0] } ?? []
        report()
    }

    @objc private func assigneeChanged() {
        filter.assignee = chosenValue(assigneePopup)
        report()
    }

    @objc private func milestoneChanged() {
        filter.milestone = chosenValue(milestonePopup)
        report()
    }

    private func clearFilters() {
        filter = CrmIssueFilter()
        controls.selectState(0)
        controls.selectSort(0)
        controls.setSearchText("")
        for popup in [labelPopup, assigneePopup, milestonePopup] { popup.selectItem(at: 0) }
        report()
    }

    private func syncActiveFilters() {
        let count = (filter.labels.isEmpty ? 0 : 1)
            + (filter.assignee == nil ? 0 : 1)
            + (filter.milestone == nil ? 0 : 1)
        controls.setActiveFilters(count, canClear: filter.isNarrowed)
    }

    private func report() {
        syncActiveFilters()
        onChange?(filter)
    }
}

/// Task filters stay local over the complete subject list. This adapter shares
/// the same native scope bar as issues while keeping task-specific choices here.
@MainActor
final class WorkTaskFilterBar: NSView {
    var onChange: ((CrmTaskFilter) -> Void)?

    private(set) var filter = CrmTaskFilter()
    private let controls = WorkFilterBar(
        stateTitles: CrmTaskFilter.State.allCases.map(\.menuTitle),
        searchPlaceholder: String(localized: "Filter these tasks"),
        sortTitles: CrmTaskFilter.Sort.allCases.map(\.menuTitle)
    )
    private let responsiblePopup = NSPopUpButton(frame: .zero, pullsDown: false)
    private let assigneePopup = NSPopUpButton(frame: .zero, pullsDown: false)
    private let duePopup = NSPopUpButton(frame: .zero, pullsDown: false)

    init() {
        super.init(frame: .zero)

        for popup in [responsiblePopup, assigneePopup, duePopup] {
            popup.target = self
        }
        responsiblePopup.action = #selector(responsibleChanged)
        assigneePopup.action = #selector(assigneeChanged)
        duePopup.action = #selector(dueChanged)

        controls.onStateChange = { [weak self] index in
            guard let self else { return }
            let states: [CrmTaskFilter.State] = [.open, .completed, .all]
            filter.state = states[min(max(index, 0), states.count - 1)]
            report()
        }
        controls.onSearchChange = { [weak self] value in
            guard let self else { return }
            filter.search = value
            report()
        }
        controls.onSortChange = { [weak self] index in
            guard let self else { return }
            let sorts = CrmTaskFilter.Sort.allCases
            filter.sort = sorts[min(max(index, 0), sorts.count - 1)]
            filter.ascending = false
            report()
        }
        controls.onClearFilters = { [weak self] in self?.clearFilters() }

        controls.translatesAutoresizingMaskIntoConstraints = false
        addSubview(controls)
        controls.pinToEdges(of: self)
        offer([])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func reset() {
        filter = CrmTaskFilter()
        controls.selectState(0)
        controls.selectSort(0)
        controls.setSearchText("")
        offer([])
    }

    /// Menus are rebuilt from the current subject so an assignee only appears
    /// when that person actually has a task in this list.
    func offer(_ tasks: [CrmTask]) {
        let parties = CrmTaskResponsible.allCases.map { ($0.title, $0.rawValue) }
        fill(responsiblePopup, all: String(localized: "Any side"), options: parties, selected: filter.responsible?.rawValue)

        var assigneesByID: [String: String] = [:]
        for task in tasks {
            if let id = task.assigneeID, let name = task.assigneeName {
                assigneesByID[id] = name
            }
        }
        if let selected = filter.assigneeID, assigneesByID[selected] == nil {
            let oldTitle = assigneePopup.selectedItem?.title
            assigneesByID[selected] = oldTitle.flatMap { $0 == String(localized: "Anyone") ? nil : $0 } ?? selected
        }
        let assignees = assigneesByID.sorted {
            $0.value.localizedCaseInsensitiveCompare($1.value) == .orderedAscending
        }
        fill(assigneePopup, all: String(localized: "Anyone"), options: assignees.map { ($0.value, $0.key) }, selected: filter.assigneeID)

        fill(
            duePopup,
            all: CrmTaskFilter.Due.any.menuTitle,
            options: CrmTaskFilter.Due.allCases.dropFirst().map { ($0.menuTitle, $0.rawValue) },
            selected: filter.due == .any ? nil : filter.due.rawValue
        )

        var facets = [WorkFilterBar.Facet(title: String(localized: "Responsible"), popup: responsiblePopup)]
        if !assignees.isEmpty || filter.assigneeID != nil {
            facets.append(.init(title: String(localized: "Assignee"), popup: assigneePopup))
        }
        facets.append(.init(title: String(localized: "Due date"), popup: duePopup))
        controls.setFacets(facets)
        syncActiveFilters()
    }

    private func fill(
        _ popup: NSPopUpButton,
        all: String,
        options: [(String, String)],
        selected: String?
    ) {
        popup.removeAllItems()
        popup.addItem(withTitle: all)
        for (title, value) in options {
            popup.addItem(withTitle: title)
            popup.lastItem?.representedObject = value
        }
        if let selected,
           let index = popup.itemArray.firstIndex(where: { ($0.representedObject as? String) == selected }) {
            popup.selectItem(at: index)
        } else {
            popup.selectItem(at: 0)
        }
    }

    @objc private func responsibleChanged() {
        let raw = responsiblePopup.indexOfSelectedItem == 0
            ? nil
            : responsiblePopup.selectedItem?.representedObject as? String
        filter.responsible = raw.flatMap(CrmTaskResponsible.init(rawValue:))
        report()
    }

    @objc private func assigneeChanged() {
        filter.assigneeID = assigneePopup.indexOfSelectedItem == 0
            ? nil
            : assigneePopup.selectedItem?.representedObject as? String
        report()
    }

    @objc private func dueChanged() {
        let raw = duePopup.indexOfSelectedItem == 0
            ? CrmTaskFilter.Due.any.rawValue
            : duePopup.selectedItem?.representedObject as? String ?? CrmTaskFilter.Due.any.rawValue
        filter.due = CrmTaskFilter.Due(rawValue: raw) ?? .any
        report()
    }

    private func clearFilters() {
        filter = CrmTaskFilter()
        controls.selectState(0)
        controls.selectSort(0)
        controls.setSearchText("")
        for popup in [responsiblePopup, assigneePopup, duePopup] { popup.selectItem(at: 0) }
        report()
    }

    private func syncActiveFilters() {
        let count = (filter.responsible == nil ? 0 : 1)
            + (filter.assigneeID == nil ? 0 : 1)
            + (filter.due == .any ? 0 : 1)
        controls.setActiveFilters(count, canClear: filter.isNarrowed)
    }

    private func report() {
        syncActiveFilters()
        onChange?(filter)
    }
}

// MARK: - Who said it

/// Somebody's GitHub picture, in a circle, for a byline or an assignee.
///
/// Initials first and always: they are drawn immediately, and they stay if
/// there is no picture, if the load fails, or while it is in flight — so a
/// thread never has a row of grey holes in it waiting for the network.
///
/// The picture comes **through the Worker**, never from the CDN. The bytes are
/// public; who asks for them is not, and a device loading them directly would
/// tell `avatars.githubusercontent.com` the owner's address and, from the
/// pattern of requests, roughly which issues they read. `docs/PRIVACY.md` says
/// no device talks to GitHub, and an image is not the thing to make that
/// sentence false for.
@MainActor
final class StarlingsLoginAvatar: NSView {
    /// Decoded pictures, by the URL they came from. `URLCache` already spares
    /// the network; this spares the decode, which is what makes scrolling a
    /// long thread free.
    private static var decoded = NSCache<NSString, NSImage>()

    private let label = NSTextField(labelWithString: "")
    private let picture = NSImageView()
    private var loadTask: Task<Void, Never>?

    /// `api` is how the picture is fetched. Without one the circle is
    /// initials, which is a perfectly good avatar.
    init(
        login: String,
        avatarURL: String? = nil,
        diameter: CGFloat = 18,
        api: MeetingControlAPI? = nil
    ) {
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = diameter / 2
        layer?.borderWidth = 1
        layer?.masksToBounds = true

        label.stringValue = StarlingsLoginAvatar.initials(of: login)
        label.font = .systemFont(ofSize: diameter * 0.42, weight: .semibold)
        label.alignment = .center
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)

        picture.imageScaling = .scaleProportionallyUpOrDown
        picture.isHidden = true
        picture.translatesAutoresizingMaskIntoConstraints = false
        addSubview(picture)

        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: centerXAnchor),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
            widthAnchor.constraint(equalToConstant: diameter),
            heightAnchor.constraint(equalToConstant: diameter),
        ])
        picture.pinToEdges(of: self)
        setContentHuggingPriority(.required, for: .horizontal)
        toolTip = login
        setAccessibilityLabel(login)
        recolour()
        load(avatarURL, diameter: diameter, api: api)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    deinit {
        // A row scrolled away has no use for the picture it asked for.
        loadTask?.cancel()
    }

    private func load(_ avatarURL: String?, diameter: CGFloat, api: MeetingControlAPI?) {
        guard let avatarURL, !avatarURL.isEmpty, let api else { return }
        // Ask for what will actually be drawn on this screen, doubled for a
        // retina panel. A 400px face in an 18pt circle is bytes nobody sees.
        let wanted = Int(diameter * 2)
        let key = "\(avatarURL)@\(wanted)" as NSString
        if let known = StarlingsLoginAvatar.decoded.object(forKey: key) {
            show(known)
            return
        }
        loadTask = Task { [weak self] in
            guard let data = try? await api.githubAvatar(url: avatarURL, size: wanted),
                  let image = NSImage(data: data)
            else { return }
            guard !Task.isCancelled else { return }
            StarlingsLoginAvatar.decoded.setObject(image, forKey: key)
            self?.show(image)
        }
    }

    private func show(_ image: NSImage) {
        picture.image = image
        picture.isHidden = false
        // The initials stay under it rather than being removed: a picture with
        // transparency should not open onto the window behind it.
        label.isHidden = true
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        recolour()
    }

    private func recolour() {
        layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.elevated, for: self).cgColor
        layer?.borderColor = StarlingsColors.resolved(StarlingsColors.border, for: self).cgColor
        label.textColor = StarlingsColors.secondaryText
    }

    /// A GitHub login is one word, so `ParticipantInitials`' two-name rule has
    /// nothing to work with. `envisioning-core[bot]` is EC, `mz` is MZ.
    static func initials(of login: String) -> String {
        let parts = login
            .split(whereSeparator: { !$0.isLetter && !$0.isNumber })
            .prefix(2)
        let letters = parts.compactMap { $0.first.map(String.init) }
        return letters.isEmpty ? "?" : letters.joined().uppercased()
    }
}

// MARK: - Markdown

/// Markdown as blocks, not as one run of inline text.
///
/// `AttributedString`'s inline-only parse is what the app used before, and it
/// flattens exactly the things an issue is written with: a heading reads as
/// body text, a bullet keeps its hyphen, a fenced block loses its font, and an
/// acceptance-criteria checklist arrives as literal `- [ ]`. Reading an issue
/// in the app is only 1:1 with reading it on GitHub if those survive.
///
/// Anything the parser cannot make sense of comes back as the markdown it is —
/// legible, and honest about what it is, which beats an empty pane over
/// something somebody wrote.
enum StarlingsMarkdown {
    static func attributed(
        _ source: String,
        size: CGFloat = StarlingsTypography.scaled(12),
        text: NSColor = StarlingsColors.primaryText,
        secondary: NSColor = StarlingsColors.secondaryText
    ) -> NSAttributedString {
        let plain: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: size),
            .foregroundColor: text,
        ]
        guard !source.isEmpty else { return NSAttributedString(string: "", attributes: plain) }
        let options = AttributedString.MarkdownParsingOptions(
            allowsExtendedAttributes: true,
            interpretedSyntax: .full,
            failurePolicy: .returnPartiallyParsedIfPossible
        )
        guard let parsed = try? AttributedString(markdown: source, options: options) else {
            return NSAttributedString(string: source, attributes: plain)
        }

        let output = NSMutableAttributedString()
        var openBlock: Int?
        for run in parsed.runs {
            let intent = run.presentationIntent
            let identity = intent?.components.first?.identity
            if identity != openBlock {
                if output.length > 0 { output.append(NSAttributedString(string: "\n")) }
                output.append(NSAttributedString(string: marker(for: intent), attributes: [
                    .font: NSFont.systemFont(ofSize: size),
                    .foregroundColor: secondary,
                ]))
                openBlock = identity
            }
            let piece = String(parsed[run.range].characters)
            output.append(NSAttributedString(
                string: piece,
                attributes: attributes(
                    block: intent,
                    inline: run.inlinePresentationIntent,
                    link: run.link,
                    size: size,
                    text: text,
                    secondary: secondary
                )
            ))
        }
        return checkboxes(in: output)
    }

    /// What a block needs in front of it. A bullet is drawn rather than
    /// carried over from the source, and a numbered item keeps its number.
    private static func marker(for intent: PresentationIntent?) -> String {
        guard let intent else { return "" }
        var ordinal: Int?
        var isOrdered = false
        var isList = false
        var quoted = false
        for component in intent.components {
            switch component.kind {
            case .listItem(let index): ordinal = index; isList = true
            case .orderedList: isOrdered = true
            case .unorderedList: isList = true
            case .blockQuote: quoted = true
            case .thematicBreak: return "———\n"
            default: break
            }
        }
        if quoted { return "▏ " }
        guard isList else { return "" }
        if isOrdered, let ordinal { return "\(ordinal). " }
        return "•  "
    }

    private static func attributes(
        block: PresentationIntent?,
        inline: InlinePresentationIntent?,
        link: URL?,
        size: CGFloat,
        text: NSColor,
        secondary: NSColor
    ) -> [NSAttributedString.Key: Any] {
        var font = NSFont.systemFont(ofSize: size)
        var colour = text
        var attributes: [NSAttributedString.Key: Any] = [:]

        for component in block?.components ?? [] {
            switch component.kind {
            case .header(let level):
                // Three steps and then flat: an issue body rarely goes deeper,
                // and a sixth-level heading smaller than the body reads wrong.
                let bump: CGFloat = switch level {
                case 1: 5
                case 2: 3
                case 3: 1
                default: 0
                }
                font = .systemFont(ofSize: size + bump, weight: .semibold)
            case .codeBlock:
                font = .monospacedSystemFont(ofSize: size - 1, weight: .regular)
                colour = secondary
            case .blockQuote:
                colour = secondary
            default:
                break
            }
        }

        if let inline {
            if inline.contains(.code) {
                font = .monospacedSystemFont(ofSize: size - 1, weight: .regular)
            }
            if inline.contains(.stronglyEmphasized) {
                font = NSFontManager.shared.convert(font, toHaveTrait: .boldFontMask)
            }
            if inline.contains(.emphasized) {
                font = NSFontManager.shared.convert(font, toHaveTrait: .italicFontMask)
            }
            if inline.contains(.strikethrough) {
                attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
            }
        }

        if let link {
            attributes[.link] = link
            colour = StarlingsColors.accent
            attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue
        }

        attributes[.font] = font
        attributes[.foregroundColor] = colour
        return attributes
    }

    /// GitHub task lists are not something Foundation's parser knows about, so
    /// `- [ ]` survives the parse as literal text. Drawing the box is the last
    /// thing between an acceptance-criteria list and how it reads on GitHub.
    private static func checkboxes(in source: NSMutableAttributedString) -> NSAttributedString {
        let text = source.string as NSString
        for (marker, box) in [("[ ] ", "☐ "), ("[x] ", "☑ "), ("[X] ", "☑ ")] {
            var searched = NSRange(location: 0, length: text.length)
            while searched.length > 0 {
                let found = source.mutableString.range(of: marker, options: [], range: searched)
                guard found.location != NSNotFound else { break }
                // Only at the start of a line or straight after a bullet, so a
                // literal `[x]` inside a sentence is left as somebody typed it.
                let before = found.location == 0
                    ? "\n"
                    : source.mutableString.substring(with: NSRange(location: found.location - 1, length: 1))
                if before == "\n" || before == " " {
                    source.mutableString.replaceCharacters(in: found, with: box)
                }
                let next = found.location + box.utf16.count
                searched = NSRange(location: next, length: max(source.length - next, 0))
            }
        }
        return source
    }
}

// MARK: - Reading an issue

/// An issue read the way GitHub lays it out: what it is, then the body, then
/// everything that happened under it in the order it happened.
///
/// The old pane was one text view holding the body with the comments glued to
/// the end of it, which made a label change invisible and a comment look like
/// a continuation of the body. Here each of those is its own card, and the
/// timeline events sit between them as quiet lines.
@MainActor
final class WorkIssueReadingView: NSView {
    /// Somebody set the labels, the assignees or the milestone. The whole set
    /// each time — GitHub replaces rather than adds, and a caller that had to
    /// diff would get it wrong somewhere.
    var onEditLabels: (([String]) -> Void)?
    var onEditAssignees: (([String]) -> Void)?
    /// Nil takes the milestone off.
    var onEditMilestone: ((Int?) -> Void)?

    /// What this repository offers. Empty until it lands, and the rail stays
    /// readable throughout — a picker nobody can fill is simply not offered.
    var facets = CrmIssueFacets.none

    private let scroll = NSScrollView()
    private let column = NSStackView()
    private let ground: NSColor
    /// How a face is fetched — through the Worker, never from GitHub's CDN.
    private let api: MeetingControlAPI?
    /// The issue on screen, so a menu knows what it is changing from.
    private var shown: CrmIssue?
    /// Its children, once the detail read brings them. Only a full read has
    /// them, so the rail draws a bar until then and rows afterwards.
    private var children: [CrmSubIssue] = []

    init(ground: NSColor = StarlingsColors.panel, api: MeetingControlAPI? = nil) {
        self.ground = ground
        self.api = api
        super.init(frame: .zero)

        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 12
        column.translatesAutoresizingMaskIntoConstraints = false

        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.borderType = .noBorder
        let clip = WorkIssueFlippedClip()
        clip.drawsBackground = false
        scroll.contentView = clip
        scroll.documentView = column
        scroll.translatesAutoresizingMaskIntoConstraints = false
        addSubview(scroll)
        scroll.pinToEdges(of: self)
        NSLayoutConstraint.activate([
            column.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// What is known before the full read lands: the facts the list already
    /// had. The pane is never blank while it waits.
    func show(_ issue: CrmIssue, status: String?, failed: Bool = false) {
        clear()
        shown = issue
        children = []
        addMeta(for: issue)
        if let status, failed {
            let waiting = StarlingsNoticeView()
            waiting.setText(status, tone: .danger)
            add(waiting)
        } else if status != nil {
            StarlingsPlaceholderRowView.rows(glyph: false).forEach(add)
        }
    }

    func render(_ detail: CrmIssueDetail) {
        clear()
        shown = detail.issue
        children = detail.subIssues
        addMeta(for: detail.issue)

        if detail.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let none = NSTextField(labelWithString: String(localized: "No description."))
            none.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
            none.textColor = StarlingsColors.secondaryText
            add(none)
        } else {
            let author = detail.issue.author?.login ?? String(localized: "Somebody")
            add(card(
                who: author,
                face: detail.issue.author?.avatarURL,
                byline: byline(
                    who: author,
                    what: "opened this",
                    when: CrmTaskDate.date(detail.issue.createdAt),
                    edited: false
                ),
                markdown: detail.body,
                reactions: detail.issue.reactions,
                url: detail.issue.url
            ))
        }

        for entry in detail.thread {
            switch entry {
            case .comment(let comment):
                add(card(
                    who: comment.author,
                    face: comment.authorAvatarURL,
                    byline: byline(
                        who: comment.author,
                        what: "commented",
                        when: CrmTaskDate.date(comment.createdAt),
                        edited: comment.updatedAt != nil
                    ),
                    markdown: comment.body,
                    reactions: comment.reactions,
                    url: comment.url
                ))
            case .event(let event):
                if let line = eventLine(event) { add(line) }
            }
        }

        // The thread is capped; saying so beats a reader assuming they have
        // seen everything that was said.
        if detail.comments.count < detail.issue.comments {
            let more = NSTextField(labelWithString:
                "Showing \(detail.comments.count) of \(detail.issue.comments) comments. Open in GitHub for the rest.")
            more.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
            more.textColor = StarlingsColors.secondaryText
            more.maximumNumberOfLines = 2
            add(more)
        }
    }

    func clear() {
        column.arrangedSubviews.forEach { $0.removeFromSuperview() }
    }

    // MARK: What it is

    /// GitHub's right-hand rail, stacked: state, then who owns it, then what
    /// it belongs to. Every row that has nothing to say is absent rather than
    /// present and empty.
    private func addMeta(for issue: CrmIssue) {
        let state = WorkIssueStatePill(issue: issue)
        let reference = NSTextField(labelWithString: "\(issue.owner)/\(issue.repo) \(issue.shortReference)")
        reference.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
        reference.textColor = StarlingsColors.secondaryText
        let top = NSStackView(views: [state, reference])
        top.orientation = .horizontal
        top.alignment = .centerY
        top.spacing = 8
        add(top)

        let owners = issue.assignees.isEmpty
            ? [issue.assigneeLogin].compactMap { $0 }
            : issue.assignees.map(\.login)
        // Editable where this repository told us what it would accept, and a
        // plain line where it did not — a picker with nothing in it is worse
        // than no picker, because it reads as "nobody can be assigned".
        if !facets.assignees.isEmpty {
            add(labelled(
                "Assignees",
                view: chooser(
                    summary: owners.isEmpty ? String(localized: "Nobody") : owners.joined(separator: ", "),
                    menu: assigneeMenu(chosen: Set(owners))
                ),
                height: nil
            ))
        } else if !owners.isEmpty {
            // The plural list carries the pictures; the legacy single field
            // has only a login, and initials are the honest answer for it.
            let pictures = Dictionary(
                issue.assignees.map { ($0.login, $0.avatarURL) },
                uniquingKeysWith: { first, _ in first }
            )
            let faces = NSStackView(views: owners.map {
                StarlingsLoginAvatar(login: $0, avatarURL: pictures[$0] ?? nil, diameter: 16, api: api)
            })
            faces.orientation = .horizontal
            faces.spacing = 3
            let names = NSTextField(labelWithString: owners.joined(separator: ", "))
            names.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
            names.textColor = StarlingsColors.primaryText
            names.lineBreakMode = .byTruncatingTail
            names.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            let row = NSStackView(views: [faces, names])
            row.orientation = .horizontal
            row.alignment = .centerY
            row.spacing = 6
            add(labelled(String(localized: "Assignees"), view: row, height: nil))
        }

        if !facets.labels.isEmpty {
            let chips = StarlingsLabelChipRow(issue.drawableLabels, ground: ground)
            let picker = chooser(
                summary: issue.labels.isEmpty ? String(localized: "None") : String(localized: "\(issue.labels.count) chosen"),
                menu: labelMenu(chosen: Set(issue.labels))
            )
            let stack = NSStackView(views: issue.drawableLabels.isEmpty ? [picker] : [chips, picker])
            stack.orientation = .vertical
            stack.alignment = .leading
            stack.spacing = 5
            if !issue.drawableLabels.isEmpty {
                chips.translatesAutoresizingMaskIntoConstraints = false
                chips.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
                chips.heightAnchor.constraint(
                    greaterThanOrEqualToConstant: issue.drawableLabels.count > 4 ? 38 : 18
                ).isActive = true
            }
            add(labelled(String(localized: "Labels"), view: stack, height: nil))
        } else if !issue.drawableLabels.isEmpty {
            let row = StarlingsLabelChipRow(issue.drawableLabels, ground: ground)
            add(labelled(String(localized: "Labels"), view: row, height: issue.drawableLabels.count > 4 ? 38 : 18))
        }

        if !facets.milestones.isEmpty {
            add(labelled(
                "Milestone",
                view: chooser(
                    summary: milestoneSummary(issue) ?? String(localized: "None"),
                    menu: milestoneMenu(chosen: issue.milestoneDetail?.number)
                ),
                height: nil
            ))
        } else if let summary = milestoneSummary(issue) {
            add(field(String(localized: "Milestone"), value: summary))
        }

        if let type = issue.issueType { add(field(String(localized: "Type"), value: type)) }

        if let sub = issue.subIssues, children.isEmpty {
            let bar = NSProgressIndicator()
            bar.isIndeterminate = false
            bar.minValue = 0
            bar.maxValue = Double(max(sub.total, 1))
            bar.doubleValue = Double(sub.completed)
            bar.controlSize = .small
            bar.translatesAutoresizingMaskIntoConstraints = false
            bar.heightAnchor.constraint(equalToConstant: 6).isActive = true
            let count = NSTextField(labelWithString: String(localized: "\(sub.completed) of \(sub.total) done"))
            count.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
            count.textColor = StarlingsColors.secondaryText
            let stack = NSStackView(views: [count, bar])
            stack.orientation = .vertical
            stack.alignment = .leading
            stack.spacing = 3
            add(labelled(String(localized: "Sub-issues"), view: stack, height: 26))
        }

        // Named children beat a count of them: the bar above is only drawn
        // when the list below is empty, so the same fact is never said twice.
        if !children.isEmpty {
            let done = children.filter { !$0.isOpen }.count
            let rows = children.map { child -> NSView in
                let button = NSButton(
                    title: "#\(child.number)  \(child.title)",
                    target: self,
                    action: #selector(referencePressed)
                )
                button.bezelStyle = .inline
                button.isBordered = false
                button.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
                button.image = NSImage(
                    systemSymbolName: child.isOpen ? "circle" : "checkmark.circle.fill",
                    accessibilityDescription: child.isOpen ? String(localized: "Open") : String(localized: "Closed")
                )
                button.imagePosition = .imageLeading
                button.contentTintColor = child.isOpen ? StarlingsColors.primaryText : StarlingsColors.secondaryText
                button.alignment = .left
                button.identifier = NSUserInterfaceItemIdentifier(child.url)
                button.applyMeetHoverLift(cornerRadius: 5)
                return button
            }
            let stack = NSStackView(views: rows)
            stack.orientation = .vertical
            stack.alignment = .leading
            stack.spacing = 1
            add(labelled(String(localized: "Sub-issues — \(done) of \(children.count) done"), view: stack, height: nil))
        }

        if let closed = CrmTaskDate.date(issue.closedAt) {
            add(field(String(localized: "Closed"), value: closed.meetDateTimeString(dateStyle: .abbreviated)))
        }

        let rule = NSBox()
        rule.boxType = .separator
        add(rule)
    }

    private func milestoneSummary(_ issue: CrmIssue) -> String? {
        guard let milestone = issue.milestoneDetail else { return issue.milestone }
        guard let due = CrmTaskDate.date(milestone.dueOn) else { return milestone.title }
        return milestone.title + " · due " + StarlingsDateFormatting.date(due)
    }

    // MARK: What it can be set to

    /// A pop-up that reads as the current value and opens the choices. Not an
    /// `NSPopUpButton`: labels and assignees are sets, and a pop-up button
    /// insists on exactly one selected item.
    private func chooser(summary: String, menu: NSMenu) -> NSButton {
        let button = NSButton(title: summary, target: nil, action: nil)
        button.bezelStyle = .rounded
        button.controlSize = .small
        button.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
        button.imagePosition = .imageTrailing
        button.image = NSImage(systemSymbolName: "chevron.up.chevron.down", accessibilityDescription: nil)
        button.symbolConfiguration = .init(pointSize: 8, weight: .medium)
        button.target = self
        button.action = #selector(chooserPressed)
        // The menu rides on the button, so one handler serves all three.
        button.menu = menu
        button.setContentHuggingPriority(.defaultHigh, for: .horizontal)
        return button
    }

    @objc private func chooserPressed(_ sender: NSButton) {
        guard let menu = sender.menu else { return }
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: sender.bounds.height + 2), in: sender)
    }

    /// Every label the repository has, ticked where the issue carries it.
    /// Choosing one toggles it and sends the whole set.
    private func labelMenu(chosen: Set<String>) -> NSMenu {
        let menu = NSMenu()
        for label in facets.labels {
            let item = NSMenuItem(title: label.name, action: #selector(labelToggled), keyEquivalent: "")
            item.target = self
            item.state = chosen.contains(label.name) ? .on : .off
            item.representedObject = label.name
            // The colour is what somebody recognizes a label by, and a menu
            // of twenty names in one ink is unreadable.
            if let hue = StarlingsLabelChip.colour(from: label.color) {
                item.image = StarlingsLabelChip.swatch(hue)
            }
            menu.addItem(item)
        }
        return menu
    }

    @objc private func labelToggled(_ sender: NSMenuItem) {
        guard let name = sender.representedObject as? String, let issue = shown else { return }
        var wanted = Set(issue.labels)
        if wanted.contains(name) { wanted.remove(name) } else { wanted.insert(name) }
        onEditLabels?(wanted.sorted())
    }

    private func assigneeMenu(chosen: Set<String>) -> NSMenu {
        let menu = NSMenu()
        let nobody = NSMenuItem(title: String(localized: "Nobody"), action: #selector(assigneesCleared), keyEquivalent: "")
        nobody.target = self
        nobody.state = chosen.isEmpty ? .on : .off
        menu.addItem(nobody)
        menu.addItem(.separator())
        for person in facets.assignees {
            let item = NSMenuItem(title: person.login, action: #selector(assigneeToggled), keyEquivalent: "")
            item.target = self
            item.state = chosen.contains(person.login) ? .on : .off
            item.representedObject = person.login
            menu.addItem(item)
        }
        return menu
    }

    @objc private func assigneeToggled(_ sender: NSMenuItem) {
        guard let login = sender.representedObject as? String, let issue = shown else { return }
        var wanted = Set(issue.assignees.map(\.login))
        if wanted.isEmpty, let only = issue.assigneeLogin { wanted.insert(only) }
        if wanted.contains(login) { wanted.remove(login) } else { wanted.insert(login) }
        onEditAssignees?(wanted.sorted())
    }

    @objc private func assigneesCleared() {
        onEditAssignees?([])
    }

    private func milestoneMenu(chosen: Int?) -> NSMenu {
        let menu = NSMenu()
        let none = NSMenuItem(title: String(localized: "None"), action: #selector(milestoneChosen), keyEquivalent: "")
        none.target = self
        none.state = chosen == nil ? .on : .off
        menu.addItem(none)
        menu.addItem(.separator())
        for milestone in facets.milestones {
            guard let number = milestone.number else { continue }
            let item = NSMenuItem(title: milestone.title, action: #selector(milestoneChosen), keyEquivalent: "")
            item.target = self
            item.state = number == chosen ? .on : .off
            item.representedObject = number
            menu.addItem(item)
        }
        return menu
    }

    @objc private func milestoneChosen(_ sender: NSMenuItem) {
        onEditMilestone?(sender.representedObject as? Int)
    }

    private func field(_ name: String, value: String) -> NSView {
        let text = NSTextField(wrappingLabelWithString: value)
        text.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
        text.textColor = StarlingsColors.primaryText
        text.isSelectable = true
        return labelled(name, view: text, height: nil)
    }

    /// A caption over its value, the way the app's other detail panes read.
    private func labelled(_ name: String, view: NSView, height: CGFloat?) -> NSView {
        let caption = NSTextField(labelWithString: name.uppercased())
        StarlingsTypography.applySectionLabel(caption)
        view.translatesAutoresizingMaskIntoConstraints = false
        if let height {
            view.heightAnchor.constraint(greaterThanOrEqualToConstant: height).isActive = true
        }
        let stack = NSStackView(views: [caption, view])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 3
        view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        return stack
    }

    // MARK: What was said

    private func byline(who: String, what: String, when: Date?, edited: Bool) -> String {
        var line = "\(who) \(what)"
        if let when { line += " · " + when.meetDateTimeString(dateStyle: .abbreviated) }
        if edited { line += " · edited" }
        return line
    }

    /// One thing somebody wrote: who and when in a quiet strip, the markdown
    /// under it, and any reactions at the foot.
    private func card(
        who: String,
        face: String?,
        byline: String,
        markdown: String,
        reactions: [String: Int],
        url: String?
    ) -> NSView {
        let line = NSTextField(labelWithString: byline)
        line.font = .systemFont(ofSize: StarlingsTypography.scaled(11), weight: .semibold)
        line.textColor = StarlingsColors.secondaryText
        line.lineBreakMode = .byTruncatingTail
        line.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let head = NSStackView(views: [StarlingsLoginAvatar(login: who, avatarURL: face, api: api), line])
        head.orientation = .horizontal
        head.alignment = .centerY
        head.spacing = 6

        // NSTextView has no intrinsic height, so in this vertical stack its
        // byline can remain visible while the actual issue text collapses to
        // zero. The transcript's TextKit view measures its wrapped glyphs and
        // is the same read-only primitive we need here.
        let body = ThreadSelectableTextView(attributed: StarlingsMarkdown.attributed(markdown))

        var views: [NSView] = [head, body]
        if !reactions.isEmpty {
            // Reactions are read here and added on GitHub. This app's writes go
            // out as the GitHub App rather than as the person — a comment can
            // say who asked for it in its own text, and an emoji cannot, so
            // everybody's reactions would collapse into the one bot account.
            // Rather than a button that lies, the tally is the way there.
            views.append(githubReactionTally(reactions, url: url))
        }

        let card = WorkIssueCardView(views: views)
        return card
    }

    @objc private func reactionsPressed(_ sender: NSButton) {
        guard let raw = sender.identifier?.rawValue, let url = URL(string: raw) else { return }
        NSWorkspace.shared.open(url)
    }

    private func githubReactionTally(_ reactions: [String: Int], url: String?) -> NSView {
        let stack = NSStackView()
        stack.orientation = .horizontal
        stack.spacing = 6
        for (name, count) in reactions.sorted(by: { $0.key < $1.key }) {
            let button = NSButton(title: "\(count)", target: url == nil ? nil : self, action: #selector(reactionsPressed))
            button.bezelStyle = .inline
            button.isBordered = false
            button.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
            button.image = NSImage(
                systemSymbolName: githubReactionSymbol(for: name),
                accessibilityDescription: githubReactionLabel(for: name)
            )?.withSymbolConfiguration(.init(pointSize: 11, weight: .regular))
            button.imagePosition = .imageLeading
            button.contentTintColor = StarlingsColors.secondaryText
            button.setAccessibilityLabel("\(githubReactionLabel(for: name)), \(count)")
            if let url, let link = URL(string: url) {
                button.identifier = NSUserInterfaceItemIdentifier(link.absoluteString)
                // Only a tally with somewhere to go is a button; one with no
                // url is a readout and must not light up.
                button.applyMeetHoverLift(cornerRadius: 5)
            }
            stack.addArrangedSubview(button)
        }
        return stack
    }

    // The words and symbols are `GitHubReactions` (Sources/GitHubReactions.swift), shared with the other Apple client.
    private func githubReactionLabel(for name: String) -> String { GitHubReactions.label(for: name) }

    private func githubReactionSymbol(for name: String) -> String { GitHubReactions.symbol(for: name) }

    /// A timeline event: one centred-left line with a mark, no card and no
    /// bubble, so what happened never competes with what was said.
    private func eventLine(_ event: CrmIssueEvent) -> NSView? {
        guard let summary = event.summary else { return nil }
        let mark = NSImageView()
        mark.image = NSImage(systemSymbolName: symbol(for: event.kind), accessibilityDescription: nil)
        mark.contentTintColor = StarlingsColors.secondaryText
        mark.symbolConfiguration = .init(pointSize: 9, weight: .regular)
        mark.setContentHuggingPriority(.required, for: .horizontal)

        var text = summary
        if let when = CrmTaskDate.date(event.createdAt) {
            text += " · " + when.formatted(Date.FormatStyle(date: .abbreviated, time: .omitted).locale(StarlingsDateFormatting.locale))
        }
        let line = StarlingsTypography.wrappingLabel(text)
        line.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
        line.textColor = StarlingsColors.secondaryText
        line.maximumNumberOfLines = 2

        var views: [NSView] = [mark]
        // The label is the point of a labelling event, so it is drawn rather
        // than named — the same chip the list and the meta rail use.
        if let label = event.label, event.kind == "labeled" {
            views.append(StarlingsLabelChip(label, ground: ground))
        }
        // "mz mentioned this in #277" should go to #277. The reference has
        // travelled the whole wire; leaving it as text wasted the trip.
        if let raw = event.url, let link = URL(string: raw) {
            let button = NSButton(title: text, target: self, action: #selector(referencePressed))
            button.bezelStyle = .inline
            button.isBordered = false
            button.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
            button.contentTintColor = StarlingsColors.secondaryText
            button.alignment = .left
            button.identifier = NSUserInterfaceItemIdentifier(link.absoluteString)
            button.applyMeetHoverLift(cornerRadius: 5)
            views.append(button)
        } else {
            views.append(line)
        }
        let row = NSStackView(views: views)
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 6
        return row
    }

    @objc private func referencePressed(_ sender: NSButton) {
        guard let raw = sender.identifier?.rawValue, let url = URL(string: raw) else { return }
        NSWorkspace.shared.open(url)
    }

    private func symbol(for kind: String) -> String {
        switch kind {
        case "labeled", "unlabeled": "tag"
        case "assigned", "unassigned": "person"
        case "milestoned", "demilestoned": "flag"
        case "renamed": "pencil"
        case "closed": "checkmark.circle"
        case "reopened": "arrow.counterclockwise.circle"
        case "referenced", "cross-referenced", "connected", "disconnected": "arrow.triangle.branch"
        case "locked", "unlocked": "lock"
        case "pinned", "unpinned": "pin"
        default: "circle.dashed"
        }
    }

    private func add(_ view: NSView) {
        view.translatesAutoresizingMaskIntoConstraints = false
        column.addArrangedSubview(view)
        view.widthAnchor.constraint(equalTo: column.widthAnchor).isActive = true
    }
}

/// The state, said once — the one fact about an issue somebody reads before
/// anything else. Open, closed, and closed-not-planned read apart by glyph
/// (a ring, a check, a slash), not by hue: none of the three is a success, a
/// failure, or an action to take, so none of them earns a colour.
@MainActor
private final class WorkIssueStatePill: NSView {
    init(issue: CrmIssue) {
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 9

        let symbolName = issue.isOpen
            ? "circle"
            : (issue.stateReason == "not_planned" ? "slash.circle" : "checkmark.circle")
        let mark = NSImageView()
        mark.image = NSImage(systemSymbolName: symbolName, accessibilityDescription: nil)
        mark.contentTintColor = StarlingsColors.secondaryText
        mark.symbolConfiguration = .init(pointSize: 10, weight: .semibold)
        mark.setContentHuggingPriority(.required, for: .horizontal)

        let text = NSTextField(labelWithString: issue.stateSummary)
        text.font = .systemFont(ofSize: StarlingsTypography.scaled(11), weight: .semibold)
        text.textColor = StarlingsColors.secondaryText

        let row = NSStackView(views: [mark, text])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 4
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            row.centerYAnchor.constraint(equalTo: centerYAnchor),
            heightAnchor.constraint(equalToConstant: 18),
        ])
        setContentHuggingPriority(.required, for: .horizontal)
        layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.secondaryText, for: self).withAlphaComponent(0.16).cgColor
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        // A CGColor set once goes stale when the appearance flips.
        layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.secondaryText, for: self).withAlphaComponent(0.16).cgColor
    }
}

/// One thing somebody wrote, on the app's elevated rung with a hairline —
/// which is what keeps a comment from reading as more of the body.
@MainActor
private final class WorkIssueCardView: NSView {
    init(views: [NSView]) {
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 8
        layer?.borderWidth = 1

        let stack = NSStackView(views: views)
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 4
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        stack.pinToEdges(of: self, insets: NSEdgeInsets(top: 8, left: 10, bottom: 8, right: 10))
        for view in views {
            view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
        recolour()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        recolour()
    }

    private func recolour() {
        layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.elevated, for: self).cgColor
        layer?.borderColor = StarlingsColors.resolved(StarlingsColors.border, for: self).cgColor
    }
}

/// A clip view that starts at the top. AppKit's own starts at the bottom, and
/// a reading pane that opens at the end of the thread is nobody's idea of one.
private final class WorkIssueFlippedClip: NSClipView {
    override var isFlipped: Bool { true }
}
