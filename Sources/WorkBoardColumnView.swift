import AppKit

// The column and the clip view the card board is built from. They came
// from the subject pipeline board, which slice 5 removed; the card
// board (docs/BOARD.md) is the one board now, and these are its parts.

/// One column of a board: a title, a fold, and a drop target for one
/// pasteboard type. Written for two boards, kept for the one that stayed, because
/// two columns that fold, count, and light up differently would make the two
/// boards feel like two products.
@MainActor
final class WorkBoardColumnView: NSView {
    let columnID: String
    /// `(dragged token, column id)`. The board resolves the token — a
    /// pasteboard carries an identifier, never a copy of the record.
    var onDrop: ((String, String) -> Void)?
    var onFoldChange: (() -> Void)?
    private let dragType: NSPasteboard.PasteboardType

    private let disclosure = NSButton()
    private let countLabel = NSTextField(labelWithString: "")
    private let cardsStack = NSStackView()
    private let cardsScroll = NSScrollView()
    private let emptyLabel = NSTextField(labelWithString: "")
    private let foldKey: String
    private var isCollapsed: Bool
    private var widthConstraint: NSLayoutConstraint!
    private var isDropTarget = false

    private static let expandedWidth: CGFloat = 264
    private static let collapsedWidth: CGFloat = 148

    init(
        id: String,
        title: String,
        foldKey: String,
        startsCollapsed: Bool,
        dragType: NSPasteboard.PasteboardType
    ) {
        columnID = id
        self.foldKey = foldKey
        self.dragType = dragType
        // A column nobody has folded yet uses its own default, so the
        // graveyard columns are not the first thing a board shows.
        if UserDefaults.standard.object(forKey: "meet.sidebarFold." + foldKey) == nil {
            isCollapsed = startsCollapsed
        } else {
            isCollapsed = MeetingSidebarFoldPreferences.isCollapsed(foldKey)
        }
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        wantsLayer = true

        disclosure.bezelStyle = .inline
        SettingsChrome.applyQuietButton(disclosure)
        disclosure.font = StarlingsTypography.sectionLabelFont
        disclosure.contentTintColor = StarlingsColors.secondaryText
        disclosure.imagePosition = .imageLeading
        disclosure.imageHugsTitle = true
        disclosure.title = title.uppercased()
        disclosure.target = self
        disclosure.action = #selector(toggleFold)
        disclosure.lineBreakMode = .byTruncatingTail
        disclosure.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        countLabel.font = StarlingsTypography.sectionLabelFont
        countLabel.textColor = StarlingsColors.secondaryText
        countLabel.setContentHuggingPriority(.required, for: .horizontal)
        countLabel.setContentCompressionResistancePriority(.required, for: .horizontal)

        let header = NSStackView(views: [disclosure, NSView(), countLabel])
        header.orientation = .horizontal
        header.alignment = .centerY
        header.spacing = 6
        header.translatesAutoresizingMaskIntoConstraints = false

        cardsStack.orientation = .vertical
        cardsStack.alignment = .leading
        cardsStack.spacing = 8
        cardsStack.translatesAutoresizingMaskIntoConstraints = false

        cardsScroll.drawsBackground = false
        cardsScroll.hasVerticalScroller = true
        cardsScroll.borderType = .noBorder
        let clip = WorkBoardClipView()
        clip.drawsBackground = false
        cardsScroll.contentView = clip
        cardsScroll.documentView = cardsStack
        cardsScroll.translatesAutoresizingMaskIntoConstraints = false

        emptyLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
        emptyLabel.textColor = StarlingsColors.secondaryText
        emptyLabel.lineBreakMode = .byTruncatingTail
        emptyLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        addSubview(header)
        addSubview(cardsScroll)
        widthConstraint = widthAnchor.constraint(equalToConstant: Self.expandedWidth)
        NSLayoutConstraint.activate([
            widthConstraint,
            header.topAnchor.constraint(equalTo: topAnchor, constant: 4),
            header.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            header.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            cardsScroll.topAnchor.constraint(equalTo: header.bottomAnchor, constant: 8),
            cardsScroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            cardsScroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            cardsScroll.bottomAnchor.constraint(equalTo: bottomAnchor),
            cardsStack.widthAnchor.constraint(equalTo: cardsScroll.contentView.widthAnchor, constant: -16),
        ])

        registerForDraggedTypes([dragType])
        setLoading()
        apply()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func setLoading() {
        setRows(StarlingsPlaceholderRowView.rows(), count: nil, hasMore: false)
    }

    /// Core would not answer for this status. Said here rather than as an
    /// empty column, which would read as a stage with nothing in it.
    func setUnavailable() {
        setRows([emptyRow(String(localized: "Couldn’t load."))], count: nil, hasMore: false)
    }

    func setCards(_ cards: [NSView], hasMore: Bool) {
        setRows(cards.isEmpty ? [emptyRow(String(localized: "Nothing here."))] : cards, count: cards.count, hasMore: hasMore)
    }

    private func setRows(_ rows: [NSView], count: Int?, hasMore: Bool) {
        cardsStack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        for row in rows {
            row.translatesAutoresizingMaskIntoConstraints = false
            cardsStack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: cardsStack.widthAnchor).isActive = true
        }
        // Core caps a browse at 50, so a full column is a lower bound. Same
        // `+` the sidebar's counts use, meaning the same thing.
        countLabel.stringValue = count.map { "\($0)\(hasMore ? "+" : "")" } ?? ""
        countLabel.isHidden = countLabel.stringValue.isEmpty
        // Swapping arranged subviews resizes cardsStack via Auto Layout, but
        // NSScrollView doesn't reliably resync its tracked bounds from that —
        // same staleness onFoldChange works around for the outer scroll.
        // Without this nudge the column looks pushed down until something
        // else (a window resize) forces a full layout pass.
        cardsScroll.reflectScrolledClipView(cardsScroll.contentView)
    }

    private func emptyRow(_ text: String) -> NSView {
        let label = NSTextField(labelWithString: text)
        label.font = .systemFont(ofSize: StarlingsTypography.scaled(11))
        label.textColor = StarlingsColors.secondaryText
        label.lineBreakMode = .byTruncatingTail
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let holder = NSView()
        label.translatesAutoresizingMaskIntoConstraints = false
        holder.addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: holder.leadingAnchor, constant: 8),
            label.trailingAnchor.constraint(lessThanOrEqualTo: holder.trailingAnchor, constant: -8),
            label.topAnchor.constraint(equalTo: holder.topAnchor, constant: 2),
            label.bottomAnchor.constraint(equalTo: holder.bottomAnchor, constant: -2),
        ])
        return holder
    }

    private func apply() {
        cardsScroll.isHidden = isCollapsed
        widthConstraint.constant = isCollapsed ? Self.collapsedWidth : Self.expandedWidth
        disclosure.image = NSImage(
            systemSymbolName: isCollapsed ? "chevron.right" : "chevron.down",
            accessibilityDescription: nil
        )?.withSymbolConfiguration(.init(pointSize: 9, weight: .semibold))
        disclosure.setAccessibilityExpanded(!isCollapsed)
        layer?.cornerRadius = 10
        layer?.cornerCurve = .continuous
        // The drop target lights up rather than the card following the
        // pointer: a column is the thing being chosen, so it is the thing
        // that answers.
        layer?.backgroundColor = StarlingsColors.resolved(
            isDropTarget ? StarlingsColors.panel : .clear,
            for: self
        ).cgColor
    }

    @objc private func toggleFold() {
        isCollapsed.toggle()
        MeetingSidebarFoldPreferences.setCollapsed(isCollapsed, for: foldKey)
        apply()
        onFoldChange?()
    }

    // MARK: - Dropping

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        guard sender.draggingPasteboard.string(forType: dragType) != nil else { return [] }
        isDropTarget = true
        apply()
        return .move
    }

    override func draggingExited(_ sender: NSDraggingInfo?) {
        isDropTarget = false
        apply()
    }

    override func draggingEnded(_ sender: NSDraggingInfo) {
        isDropTarget = false
        apply()
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        isDropTarget = false
        apply()
        guard let token = sender.draggingPasteboard.string(forType: dragType) else { return false }
        onDrop?(token, columnID)
        return true
    }
}


/// Content sits at the top-left of its clip view and scrolls away from there.
/// An unflipped document view pins short content to the bottom, which would
/// float a half-full column's cards below its own header.
final class WorkBoardClipView: NSClipView {
    override var isFlipped: Bool { true }
}
