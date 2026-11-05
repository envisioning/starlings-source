import AppKit

/// The shared AppKit shell for a row in a Work detail-pane list. The content
/// and context menu remain typed because each list's rows carry different
/// actions, but geometry, activation, selection, and accessibility must not
/// drift between them. Originally built for Mine's tasks and issues; also
/// backs Interactions and meeting tasks, so every "list of entries" in Work's
/// detail pane and task rail comes from the same shell.
@MainActor
class WorkListRowView: NSView, WorkSidebarSelectableRow {
    private let onActivate: () -> Void
    private var isHovered = false

    var selectionKey: AnyHashable?
    var isSelected: Bool {
        didSet {
            guard isSelected != oldValue else { return }
            paint()
        }
    }

    init(
        content: NSView,
        isSelected: Bool,
        accessibilityLabel: String,
        height: CGFloat = 56,
        onActivate: @escaping () -> Void
    ) {
        self.onActivate = onActivate
        self.isSelected = isSelected
        super.init(frame: .zero)

        content.translatesAutoresizingMaskIntoConstraints = false
        addSubview(content)
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            content.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            content.centerYAnchor.constraint(equalTo: centerYAnchor),
            heightAnchor.constraint(equalToConstant: height),
        ])

        setAccessibilityElement(true)
        setAccessibilityRole(.row)
        setAccessibilityLabel(accessibilityLabel)
        paint()
        trackMeetHover { [weak self] hovered in
            self?.isHovered = hovered
            self?.paint()
        }
    }

    private func paint() {
        WorkSidebarRowPaint.apply(to: self, selected: isSelected, hovered: isHovered)
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        paint()
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        meetHoverMonitor?.resync()
    }

    /// The width of the leading mark column. A task's checkbox, an issue's
    /// tile and an interaction's glyph have different natural widths; each
    /// sits centred in this column so every title starts at the same x.
    static let leadingSlot: CGFloat = 24
    static let leadingGap: CGFloat = 8

    /// The row's type: every list row's title and detail line use these, so a
    /// task, an issue and an interaction in one list read at the same size.
    static let textSpacing: CGFloat = 2
    static func titleFont() -> NSFont {
        .systemFont(ofSize: StarlingsTypography.scaled(13), weight: .medium)
    }
    static func detailFont(bold: Bool = false) -> NSFont {
        .systemFont(ofSize: StarlingsTypography.scaled(11), weight: bold ? .bold : .regular)
    }

    /// The row's content: the leading mark in its fixed-width column, then
    /// the text. Every list row builds its content here, so the mark column
    /// cannot drift between rows of different kinds.
    static func content(leading: NSView, text: NSView) -> NSStackView {
        leading.translatesAutoresizingMaskIntoConstraints = false
        let slot = NSView()
        slot.translatesAutoresizingMaskIntoConstraints = false
        slot.addSubview(leading)
        NSLayoutConstraint.activate([
            slot.widthAnchor.constraint(equalToConstant: leadingSlot),
            slot.heightAnchor.constraint(greaterThanOrEqualTo: leading.heightAnchor),
            leading.centerXAnchor.constraint(equalTo: slot.centerXAnchor),
            leading.centerYAnchor.constraint(equalTo: slot.centerYAnchor),
        ])
        slot.setContentHuggingPriority(.required, for: .horizontal)

        let row = NSStackView(views: [slot, text])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = leadingGap
        row.translatesAutoresizingMaskIntoConstraints = false
        return row
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        onActivate()
    }

    override var acceptsFirstResponder: Bool { true }

    override func keyDown(with event: NSEvent) {
        guard event.charactersIgnoringModifiers == "\r"
            || event.charactersIgnoringModifiers == "\n"
            || event.charactersIgnoringModifiers == " " else {
            super.keyDown(with: event)
            return
        }
        onActivate()
    }
}

/// The checkbox-plus-two-line body shared by every place a task renders as a
/// row: the toggle image/tint, the struck-through-when-done title, and the
/// "· "-joined, bold-when-late detail line must not drift between Mine's
/// sidebar and the meeting rail. Type and the mark column come from the row
/// shell, like every other list row.
@MainActor
enum WorkTaskRowContent {
    static func build(
        title: String,
        isDone: Bool,
        isLate: Bool,
        detailParts: [String]
    ) -> (content: NSStackView, toggle: NSButton) {
        let toggle = NSButton(
            image: NSImage(
                systemSymbolName: isDone ? "checkmark.circle.fill" : "circle",
                accessibilityDescription: isDone ? String(localized: "Mark as still open") : String(localized: "Done")
            ) ?? NSImage(),
            target: nil,
            action: nil
        )
        toggle.bezelStyle = .inline
        toggle.isBordered = false
        toggle.imagePosition = .imageOnly
        toggle.contentTintColor = isDone ? StarlingsColors.accentMark : StarlingsColors.secondaryText
        toggle.setContentHuggingPriority(.required, for: .horizontal)
        toggle.translatesAutoresizingMaskIntoConstraints = false
        SettingsChrome.applyQuietButton(toggle)

        let titleField = NSTextField(labelWithString: title)
        titleField.maximumNumberOfLines = 1
        titleField.lineBreakMode = .byTruncatingTail
        titleField.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        if isDone {
            // Struck through and quiet: still readable, plainly no longer work.
            titleField.attributedStringValue = NSAttributedString(string: title, attributes: [
                .foregroundColor: StarlingsColors.secondaryText,
                .strikethroughStyle: NSUnderlineStyle.single.rawValue,
                .font: WorkListRowView.titleFont(),
            ])
        } else {
            titleField.font = WorkListRowView.titleFont()
            titleField.textColor = StarlingsColors.primaryText
        }

        // Late is bold neutral ink, not a colour — and not once it is done.
        let detailField = NSTextField(labelWithString: detailParts.joined(separator: " · "))
        detailField.font = WorkListRowView.detailFont(bold: isLate)
        detailField.textColor = StarlingsColors.secondaryText
        detailField.maximumNumberOfLines = 1
        detailField.lineBreakMode = .byTruncatingTail
        detailField.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let text = NSStackView(views: [titleField, detailField])
        text.orientation = .vertical
        text.alignment = .leading
        text.spacing = WorkListRowView.textSpacing
        text.translatesAutoresizingMaskIntoConstraints = false

        return (WorkListRowView.content(leading: toggle, text: text), toggle)
    }
}
