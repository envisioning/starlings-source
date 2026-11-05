import AppKit

/// AppKit presentation of the shared long-list picker contract. The field
/// opens a bounded popover with a Meet text input; arrows move through rows,
/// Return chooses the highlight, and search only calls Core when a first page
/// says there are more results.
@MainActor
final class StarlingsSearchablePickerField: NSView, NSTextFieldDelegate, NSTableViewDataSource, NSTableViewDelegate, NSPopoverDelegate {
    private let trigger = NSButton(title: "", target: nil, action: nil)
    private let popover = NSPopover()
    private let searchField = StarlingsTextField(placeholder: String(localized: "Search"))
    private let table = StarlingsSearchablePickerTableView()
    private let noResults = NSTextField(labelWithString: String(localized: "No options match that search."))
    private let loading = NSTextField(labelWithString: String(localized: "Searching…"))
    private var options: [StarlingsSearchablePickerOption] = []
    private var remoteOptions: [StarlingsSearchablePickerOption]?
    private var placeholder = ""
    private var searchTask: Task<Void, Never>?
    private var isFocused = false
    private var isHovered = false

    var selectedID: String? {
        didSet { refreshTrigger() }
    }
    var isEnabled = true {
        didSet { trigger.isEnabled = isEnabled }
    }
    var onSelection: ((String) -> Void)?
    var search: ((String) async -> [StarlingsSearchablePickerOption])?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.cornerRadius = StarlingsTextField.fieldCornerRadius
        layer?.cornerCurve = .continuous
        layer?.backgroundColor = StarlingsColors.fieldGround(for: self)
        layer?.borderWidth = StarlingsTextField.borderWidth
        refreshBorder()

        trigger.isBordered = false
        trigger.setButtonType(.momentaryChange)
        trigger.target = self
        trigger.action = #selector(togglePicker)
        trigger.alignment = .left
        trigger.font = StarlingsTextField.fieldFont
        trigger.lineBreakMode = .byTruncatingTail
        trigger.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        trigger.translatesAutoresizingMaskIntoConstraints = false
        trigger.applyMeetHoverLift(cornerRadius: StarlingsRadius.control(height: StarlingsTextField.fieldHeight))
        addSubview(trigger)
        NSLayoutConstraint.activate([
            trigger.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            trigger.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            trigger.topAnchor.constraint(equalTo: topAnchor),
            trigger.bottomAnchor.constraint(equalTo: bottomAnchor),
            heightAnchor.constraint(equalToConstant: StarlingsTextField.fieldHeight),
        ])

        trackMeetHover { [weak self] hovered in
            guard let self else { return }
            isHovered = hovered
            refreshBorder()
        }
        trigger.setAccessibilityRole(.popUpButton)
        trigger.setAccessibilityHelp(String(localized: "Opens a searchable list."))
        configurePopover()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func setOptions(_ options: [StarlingsSearchablePickerOption], placeholder: String, selectedID: String?) {
        self.options = options
        self.placeholder = placeholder
        self.selectedID = selectedID
        refreshTrigger()
        refreshRows()
    }

    func updateOptions(_ options: [StarlingsSearchablePickerOption]) {
        self.options = options
        refreshTrigger()
        refreshRows()
    }

    private func configurePopover() {
        let content = NSViewController()
        let stack = NSStackView(views: [searchField, loading, noResults])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        searchField.delegate = self
        searchField.translatesAutoresizingMaskIntoConstraints = false
        loading.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
        loading.textColor = StarlingsColors.secondaryText
        noResults.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
        noResults.textColor = StarlingsColors.secondaryText
        loading.isHidden = true
        noResults.isHidden = true

        table.headerView = nil
        table.rowHeight = 34
        table.usesAlternatingRowBackgroundColors = false
        table.allowsMultipleSelection = false
        table.allowsEmptySelection = true
        table.dataSource = self
        table.delegate = self
        table.activateHighlightedRow = { [weak self] in self?.selectHighlighted() }
        table.closePicker = { [weak self] in self?.popover.close() }
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("destination"))
        column.resizingMask = .autoresizingMask
        table.addTableColumn(column)
        table.columnAutoresizingStyle = .lastColumnOnlyAutoresizingStyle
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        scroll.documentView = table
        scroll.translatesAutoresizingMaskIntoConstraints = false

        stack.addArrangedSubview(scroll)
        scroll.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        scroll.heightAnchor.constraint(equalToConstant: 290).isActive = true
        searchField.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        stack.translatesAutoresizingMaskIntoConstraints = false
        content.view = NSView()
        content.view.addSubview(stack)
        stack.pinToEdges(of: content.view, insets: NSEdgeInsets(top: 10, left: 10, bottom: 10, right: 10))
        content.preferredContentSize = NSSize(width: 380, height: 360)
        popover.contentViewController = content
        popover.behavior = .transient
        popover.animates = true
        popover.delegate = self
    }

    private func refreshTrigger() {
        let selected = options.first { $0.id == selectedID }?.visibleTitle ?? placeholder
        let color = selectedID == nil ? StarlingsColors.secondaryText : StarlingsColors.primaryText
        let attributes: [NSAttributedString.Key: Any] = [
            .font: StarlingsTextField.fieldFont,
            .foregroundColor: color,
        ]
        let title = NSMutableAttributedString()
        // The collapsed field carries the same swatch the rows do (#605); a picker
        // without colours reserves no gap.
        if selectedID != nil, let hex = options.first(where: { $0.id == selectedID })?.colorHex, let rgb = StarlingsRGBColor.hex(hex) {
            let dot = NSImage(size: NSSize(width: 8, height: 8), flipped: false) { rect in
                rgb.nsColor.setFill()
                NSBezierPath(ovalIn: rect).fill()
                return true
            }
            let attachment = NSTextAttachment()
            attachment.image = dot
            attachment.bounds = CGRect(x: 0, y: 0, width: 8, height: 8)
            title.append(NSAttributedString(attachment: attachment))
            title.append(NSAttributedString(string: "  ", attributes: attributes))
        }
        title.append(NSAttributedString(string: selected, attributes: attributes))
        trigger.attributedTitle = title
        trigger.image = NSImage(systemSymbolName: "chevron.up.chevron.down", accessibilityDescription: String(localized: "Choose destination"))
        trigger.imagePosition = .imageRight
        trigger.imageHugsTitle = false
        trigger.toolTip = selected
        trigger.setAccessibilityLabel(String(localized: "Destination, \(selected)"))
    }

    private func refreshRows() {
        let query = searchField.stringValue
        let source = query.isEmpty ? options : (remoteOptions ?? options)
        let filtered = source.filter { $0.matches(query) }
        table.reloadData()
        let highlightedIndex = query.isEmpty
            ? filtered.firstIndex(where: { $0.id == selectedID }) ?? filtered.indices.first
            : filtered.indices.first
        if let highlightedIndex {
            table.selectRowIndexes(IndexSet(integer: highlightedIndex), byExtendingSelection: false)
        } else {
            table.deselectAll(nil)
        }
        noResults.isHidden = !filtered.isEmpty || loading.isHidden == false
        table.isHidden = filtered.isEmpty
    }

    private var visibleOptions: [StarlingsSearchablePickerOption] {
        let query = searchField.stringValue
        let source = query.isEmpty ? options : (remoteOptions ?? options)
        return source.filter { $0.matches(query) }
    }

    @objc private func togglePicker() {
        if popover.isShown {
            popover.close()
        } else {
            searchField.stringValue = ""
            remoteOptions = nil
            refreshRows()
            popover.show(relativeTo: bounds, of: self, preferredEdge: .maxY)
            isFocused = true
            refreshBorder()
            window?.makeFirstResponder(searchField)
        }
    }

    func controlTextDidChange(_ notification: Notification) {
        scheduleSearch()
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        switch commandSelector {
        case #selector(NSResponder.insertNewline(_:)):
            selectHighlighted()
            return true
        case #selector(NSResponder.moveDown(_:)):
            guard !visibleOptions.isEmpty else { return true }
            window?.makeFirstResponder(table)
            if table.selectedRow < 0 {
                table.selectRowIndexes(IndexSet(integer: 0), byExtendingSelection: false)
            }
            return true
        case #selector(NSResponder.cancelOperation(_:)):
            popover.close()
            return true
        default:
            return false
        }
    }

    private func scheduleSearch() {
        searchTask?.cancel()
        let query = searchField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty, let search else {
            remoteOptions = nil
            loading.isHidden = true
            refreshRows()
            return
        }
        remoteOptions = nil
        loading.stringValue = String(localized: "Searching…")
        loading.isHidden = false
        noResults.isHidden = true
        refreshRows()
        let searchOptions = search
        searchTask = Task { [weak self] in
            do {
                try await Task.sleep(for: .milliseconds(100))
                guard !Task.isCancelled else { return }
                let found = await searchOptions(query)
                guard !Task.isCancelled, let self else { return }
                remoteOptions = found
                loading.isHidden = true
                refreshRows()
            } catch {
                // Keep local results visible if this query was superseded.
            }
        }
    }

    private func selectHighlighted() {
        let rows = visibleOptions
        guard !rows.isEmpty else { return }
        let selectedIndex = rows.indices.contains(table.selectedRow) ? table.selectedRow : 0
        selectedID = rows[selectedIndex].id
        onSelection?(rows[selectedIndex].id)
        popover.close()
    }

    func numberOfRows(in tableView: NSTableView) -> Int { visibleOptions.count }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let options = visibleOptions
        guard options.indices.contains(row) else { return nil }
        let option = options[row]
        let title = NSTextField(labelWithString: option.visibleTitle)
        title.font = .systemFont(ofSize: StarlingsTypography.scaled(13))
        title.textColor = StarlingsColors.primaryText
        title.lineBreakMode = .byTruncatingTail
        let leading = NSStackView()
        leading.orientation = .horizontal
        leading.alignment = .centerY
        leading.spacing = 7
        if let colorHex = option.colorHex, let color = StarlingsRGBColor.hex(colorHex) {
            let swatch = NSView()
            swatch.wantsLayer = true
            swatch.layer?.backgroundColor = color.nsColor.cgColor
            swatch.layer?.cornerRadius = 4
            swatch.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([
                swatch.widthAnchor.constraint(equalToConstant: 8),
                swatch.heightAnchor.constraint(equalToConstant: 8),
            ])
            leading.addArrangedSubview(swatch)
        }
        leading.addArrangedSubview(title)
        let accessory = NSStackView()
        accessory.orientation = .horizontal
        accessory.alignment = .centerY
        accessory.spacing = 6
        if option.isStarred {
            accessory.addArrangedSubview(symbol("star.fill", label: String(localized: "Starred")))
        }
        if option.id == selectedID {
            accessory.addArrangedSubview(symbol("checkmark", label: nil))
        }
        let row = NSStackView(views: [leading, accessory])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.spacing = 8
        row.edgeInsets = NSEdgeInsets(top: 2, left: 8, bottom: 2, right: 8)
        row.wantsLayer = true
        row.layer?.cornerRadius = 6
        row.applyMeetHoverLift(cornerRadius: 6)
        return row
    }

    func tableViewSelectionDidChange(_ notification: Notification) {
        guard table.selectedRow >= 0 else { return }
        table.scrollRowToVisible(table.selectedRow)
    }

    func popoverDidClose(_ notification: Notification) {
        isFocused = false
        refreshBorder()
    }

    private func symbol(_ name: String, label: String?) -> NSImageView {
        let image = NSImageView()
        image.image = NSImage(systemSymbolName: name, accessibilityDescription: label)
        image.contentTintColor = StarlingsColors.accent
        image.setAccessibilityLabel(label ?? "")
        return image
    }

    private func refreshBorder() {
        if isFocused {
            layer?.borderColor = StarlingsColors.resolved(StarlingsColors.accent, for: self).cgColor
        } else {
            layer?.borderColor = StarlingsColors.hairline(for: self, hovered: isHovered)
        }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        layer?.backgroundColor = StarlingsColors.fieldGround(for: self)
        refreshBorder()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        layer?.backgroundColor = StarlingsColors.fieldGround(for: self)
        refreshBorder()
    }
}

@MainActor
private final class StarlingsSearchablePickerTableView: NSTableView {
    var activateHighlightedRow: (() -> Void)?
    var closePicker: (() -> Void)?

    override func keyDown(with event: NSEvent) {
        switch event.keyCode {
        case 36, 76: activateHighlightedRow?()
        case 53: closePicker?()
        default: super.keyDown(with: event)
        }
    }

    override func mouseDown(with event: NSEvent) {
        super.mouseDown(with: event)
        activateHighlightedRow?()
    }
}
