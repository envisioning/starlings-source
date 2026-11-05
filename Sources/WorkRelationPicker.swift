import AppKit

/// One relation on a subject — an organization, a contact — as the editor
/// draws it: what is chosen, and a line to find the next one.
///
/// Typeahead, never a directory. An earlier version preloaded every
/// organization into a popup so the menu was full the moment the sheet
/// opened; with a few hundred organizations and over a thousand contacts that
/// is a wall of names nobody reads. Nothing is listed here until you type,
/// and what comes back is Core's ranked answer to what you typed.
///
/// Rows follow `CalendarInviteesEditorView`: a name, its own remove button,
/// and a field underneath. Names are long, a project can have several, and a
/// row each gives every one somewhere to put the ✕.
@MainActor
final class RelationPickerView: NSStackView, NSTextFieldDelegate {
    enum Mode {
        /// One at a time. Choosing replaces what was there.
        case single
        /// Several. Choosing appends, and each row removes on its own.
        case multi
    }

    typealias Search = @MainActor (String) async throws -> [WorkSubjectEditor.RelationOption]
    typealias Create = @MainActor (String) async throws -> WorkSubjectEditor.RelationOption

    /// Fires whenever the selection changes, so the sheet can resize and
    /// clear a stale validation message.
    var onChange: (() -> Void)?
    /// A failed search. The sheet owns the notice view, so the message goes
    /// there rather than into a label of our own.
    var onError: ((String) -> Void)?

    private(set) var selected: [WorkSubjectEditor.RelationOption] = []

    private let mode: Mode
    private let search: Search?
    private let create: Create?
    private let rows = NSStackView()
    private let searchField: StarlingsTextField
    private let results = NSStackView()
    private var searchTask: Task<Void, Never>?
    /// The last query's hits, so a click can resolve an id back to an option.
    private var hits: [WorkSubjectEditor.RelationOption] = []
    private var searchFailed = false
    /// What the last failed search said, kept so the error row can show it
    /// and Copy can carry it.
    private var searchErrorMessage = ""
    private let emptyText: String
    private var isSearching = false
    private var isCreating = false

    init(mode: Mode, placeholder: String, emptyText: String = String(localized: "No matches"), search: Search?, create: Create? = nil) {
        self.mode = mode
        self.emptyText = emptyText
        self.search = search
        self.create = create
        self.searchField = StarlingsTextField(placeholder: placeholder)
        super.init(frame: .zero)

        orientation = .vertical
        alignment = .leading
        spacing = 6

        for stack in [rows, results] {
            stack.orientation = .vertical
            stack.alignment = .leading
            stack.spacing = 2
            stack.translatesAutoresizingMaskIntoConstraints = false
        }

        searchField.delegate = self
        searchField.isEnabled = search != nil

        addArrangedSubview(rows)
        addArrangedSubview(searchField)
        addArrangedSubview(results)
        rows.widthAnchor.constraint(equalTo: widthAnchor).isActive = true
        searchField.widthAnchor.constraint(equalTo: widthAnchor).isActive = true
        results.widthAnchor.constraint(equalTo: widthAnchor).isActive = true

        render()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// Start from what the subject already has. Names a detail did not carry
    /// arrive as ids; the caller resolves those before handing them over.
    func setSelected(_ options: [WorkSubjectEditor.RelationOption]) {
        var seen = Set<String>()
        selected = options.filter { !$0.id.isEmpty && seen.insert($0.id).inserted }
        render()
    }

    /// Shown in place of the field when Core is not connected, so the reason
    /// the picker is dead is on screen rather than implied by a dim box.
    func setUnavailableHint(_ hint: String) {
        searchField.placeholderString = hint
    }

    var selectedIDs: [String] { selected.map(\.id) }

    func cancel() { searchTask?.cancel() }

    // MARK: - Drawing

    private func render() {
        rows.arrangedSubviews.forEach { $0.removeFromSuperview() }
        for option in selected {
            let row = chosenRow(option)
            rows.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: rows.widthAnchor).isActive = true
        }
        // A single-value picker that already has its value keeps the field —
        // choosing again is how you change it — but says so.
        searchField.isHidden = false
        rows.isHidden = selected.isEmpty
    }

    private func renderResults() {
        results.arrangedSubviews.forEach { $0.removeFromSuperview() }
        let taken = Set(selected.map(\.id))
        let offered = hits.filter { !taken.contains($0.id) }
        let query = searchField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let foldedQuery = Self.fold(query)
        let hasExactMatch = foldedQuery.count > 0 && hits.contains { Self.fold($0.name) == foldedQuery }
        let canCreate = create != nil && foldedQuery.count >= 2 && !searchFailed && !isSearching && !hasExactMatch
        let showsStatus = foldedQuery.count >= 2 && search != nil
            && (isSearching || searchFailed || (hits.isEmpty && !isCreating))
        results.isHidden = offered.isEmpty && !canCreate && !showsStatus
        if showsStatus {
            // Searching, failed, and a real empty answer each say so. An
            // empty list for an error reads as "nothing exists".
            let row = statusRow()
            results.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: results.widthAnchor).isActive = true
        }
        for option in offered.prefix(8) {
            let row = resultRow(option)
            results.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: results.widthAnchor).isActive = true
        }
        if canCreate {
            let row = createRow(query)
            results.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: results.widthAnchor).isActive = true
        }
        onChange?()
    }

    private func statusRow() -> NSView {
        let text: String
        if isSearching {
            text = String(localized: "Searching…")
        } else if searchFailed {
            text = searchErrorMessage
        } else {
            text = emptyText
        }
        let label = NSTextField(wrappingLabelWithString: text)
        label.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
        label.textColor = searchFailed ? StarlingsColors.primaryText : StarlingsColors.secondaryText
        label.isSelectable = true
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        guard searchFailed else { return label }
        let copy = NSButton(title: String(localized: "Copy"), target: self, action: #selector(copyErrorTapped(_:)))
        copy.bezelStyle = .inline
        SettingsChrome.applyQuietButton(copy, cornerRadius: 6)
        let row = NSStackView(views: [label, copy])
        row.orientation = .horizontal
        row.alignment = .firstBaseline
        row.spacing = 8
        return row
    }

    @objc private func copyErrorTapped(_ sender: NSButton) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(searchErrorMessage, forType: .string)
    }

    private func chosenRow(_ option: WorkSubjectEditor.RelationOption) -> NSView {
        let glyph = NSImageView()
        glyph.image = NSImage(systemSymbolName: "checkmark", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 11, weight: .bold))
        glyph.contentTintColor = StarlingsColors.accentMark
        glyph.setContentHuggingPriority(.required, for: .horizontal)
        glyph.widthAnchor.constraint(equalToConstant: 16).isActive = true

        let name = NSTextField(labelWithString: option.name)
        name.font = .systemFont(ofSize: StarlingsTypography.scaled(13))
        name.textColor = StarlingsColors.primaryText
        name.lineBreakMode = .byTruncatingTail
        name.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        name.setContentHuggingPriority(.defaultLow, for: .horizontal)

        let labels = NSStackView(views: [name])
        labels.orientation = .vertical
        labels.alignment = .leading
        labels.spacing = 1
        labels.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        labels.setContentHuggingPriority(.defaultLow, for: .horizontal)
        if let secondaryText = option.secondaryText, !secondaryText.isEmpty {
            let detail = NSTextField(labelWithString: secondaryText)
            detail.font = .systemFont(ofSize: StarlingsTypography.scaled(10))
            detail.textColor = StarlingsColors.secondaryText
            detail.lineBreakMode = .byTruncatingTail
            detail.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            detail.setContentHuggingPriority(.defaultLow, for: .horizontal)
            labels.addArrangedSubview(detail)
        }

        let remove = NSButton(
            image: NSImage(systemSymbolName: "xmark", accessibilityDescription: String(localized: "Remove"))?
                .withSymbolConfiguration(.init(pointSize: 9, weight: .semibold)) ?? NSImage(),
            target: self,
            action: #selector(removeTapped(_:))
        )
        remove.imagePosition = .imageOnly
        remove.bezelStyle = .inline
        remove.contentTintColor = StarlingsColors.secondaryText
        remove.setAccessibilityLabel(String(localized: "Remove \(option.name)"))
        remove.identifier = NSUserInterfaceItemIdentifier(option.id)
        SettingsChrome.applyQuietButton(remove, cornerRadius: 10)
        remove.widthAnchor.constraint(equalToConstant: 20).isActive = true
        remove.heightAnchor.constraint(equalToConstant: 20).isActive = true

        let row = NSStackView(views: [glyph, labels, NSView(), remove])
        row.orientation = .horizontal
        row.alignment = .centerY
        row.distribution = .fill
        row.spacing = 6
        row.heightAnchor.constraint(equalToConstant: option.secondaryText == nil ? 24 : 34).isActive = true
        row.setAccessibilityLabel(
            [option.name, option.secondaryText].compactMap { $0 }.joined(separator: ", ")
        )
        return row
    }

    private func resultRow(_ option: WorkSubjectEditor.RelationOption) -> NSView {
        let button = NSButton(title: option.name, target: self, action: #selector(hitTapped(_:)))
        button.attributedTitle = NSAttributedString(string: option.name, attributes: [
            .font: NSFont.systemFont(ofSize: StarlingsTypography.scaled(13)),
            .foregroundColor: StarlingsColors.primaryText,
        ])
        button.alignment = .left
        button.identifier = NSUserInterfaceItemIdentifier(option.id)
        SettingsChrome.applyQuietButton(button, cornerRadius: 6)
        button.heightAnchor.constraint(equalToConstant: 24).isActive = true
        return button
    }

    private func createRow(_ name: String) -> NSView {
        let symbol = NSImage(systemSymbolName: "plus.circle", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 12, weight: .medium)) ?? NSImage()
        let button = NSButton(title: name, image: symbol, target: self, action: #selector(createTapped(_:)))
        button.imagePosition = .imageLeading
        button.alignment = .left
        button.identifier = NSUserInterfaceItemIdentifier(name)
        button.setAccessibilityLabel("\(String(localized: "Create organization")): \(name)")
        button.toolTip = String(localized: "Create organization")
        button.isEnabled = !isCreating
        SettingsChrome.applyQuietButton(button, cornerRadius: 6)
        button.heightAnchor.constraint(equalToConstant: 24).isActive = true
        return button
    }

    // MARK: - Choosing

    @objc private func hitTapped(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue,
              let option = hits.first(where: { $0.id == id }) else { return }
        switch mode {
        case .single: selected = [option]
        case .multi where !selected.contains(where: { $0.id == option.id }): selected.append(option)
        case .multi: break
        }
        searchField.stringValue = ""
        hits = []
        searchTask?.cancel()
        render()
        renderResults()
    }

    @objc private func removeTapped(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue else { return }
        selected.removeAll { $0.id == id }
        render()
        renderResults()
    }

    @objc private func createTapped(_ sender: NSButton) {
        guard !isCreating,
              let create,
              let name = sender.identifier?.rawValue,
              !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        isCreating = true
        renderResults()
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let created = try await create(name)
                switch mode {
                case .single: selected = [created]
                case .multi where !selected.contains(where: { $0.id == created.id }): selected.append(created)
                case .multi: break
                }
                searchField.stringValue = ""
                hits = []
                searchFailed = false
                isCreating = false
                render()
                renderResults()
            } catch {
                isCreating = false
                searchFailed = true
                searchErrorMessage = error.localizedDescription
                renderResults()
            }
        }
    }

    // MARK: - Searching

    func controlTextDidChange(_ notification: Notification) {
        guard notification.object as? NSTextField === searchField else { return }
        let query = searchField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        searchTask?.cancel()
        guard query.count >= 2, let search else {
            hits = []
            searchFailed = false
            isSearching = false
            renderResults()
            return
        }
        hits = []
        searchFailed = false
        isSearching = true
        renderResults()
        searchTask = Task { @MainActor [weak self] in
            do {
                // Enough of a pause that a name typed at speed is one request,
                // not one per letter.
                try await Task.sleep(nanoseconds: 250_000_000)
                guard !Task.isCancelled else { return }
                let found = try await search(query)
                guard let self, !Task.isCancelled else { return }
                self.hits = found
                self.searchFailed = false
                self.isSearching = false
                self.renderResults()
            } catch is CancellationError {
                return
            } catch {
                guard let self, !Task.isCancelled else { return }
                self.hits = []
                self.searchFailed = true
                self.searchErrorMessage = String(localized: "Couldn’t search: \(error.localizedDescription)")
                self.isSearching = false
                self.renderResults()
            }
        }
    }

    private static func fold(_ value: String) -> String {
        value.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .current)
    }
}
