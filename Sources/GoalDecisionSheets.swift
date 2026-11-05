import AppKit
import StarlingsContracts

/// The Mac sheets for goals and decisions (#262): a goal is a
/// title with a target day and an owner; a decision is a body that may cite
/// a goal. Both are the task sheet's chrome (`MeetingTaskEditor`) with fewer
/// rows, built on one form controller so the two cannot drift.
@MainActor
enum GoalSheet {
    struct Draft {
        var title: String
        var targetDate: Date?
        var owner: String?
    }

    static func present(over window: NSWindow?, initial: Draft, team: [CrmTeamMember], onSave: @escaping (Draft) -> Void) {
        let titleField = StarlingsTextField(placeholder: String(localized: "What the project is aiming at"))
        titleField.stringValue = initial.title
        let ownerField = StarlingsSearchablePickerField(frame: .zero)
        var ownerID = initial.owner
        ownerField.setOptions(
            [StarlingsSearchablePickerOption(id: "", title: String(localized: "Nobody yet"))]
                + team.people.map { StarlingsSearchablePickerOption(id: $0.id, title: $0.name) },
            placeholder: String(localized: "Nobody yet"),
            selectedID: initial.owner ?? ""
        )
        ownerField.onSelection = { ownerID = $0.isEmpty ? nil : $0 }
        let dateRow = WorkFormSheet.DateRow(caption: String(localized: "Has a target date"), initial: initial.targetDate)

        let sheet = WorkFormSheet(
            heading: String(localized: "New goal"),
            rows: [
                .field(caption: String(localized: "Goal"), control: titleField),
                .view(team.isEmpty ? nil : WorkFormSheet.field(caption: String(localized: "Owner"), control: ownerField)),
                .view(dateRow),
            ],
            firstResponder: titleField,
            canSave: { !titleField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty },
            onSave: {
                onSave(Draft(
                    title: titleField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines),
                    targetDate: dateRow.date,
                    owner: ownerID
                ))
            }
        )
        titleField.delegate = sheet
        sheet.run(over: window)
    }
}

@MainActor
enum DecisionSheet {
    struct Draft {
        var body: String
        var goalID: String?
    }

    static func present(over window: NSWindow?, initial: Draft, goals: [CrmGoal], onSave: @escaping (Draft) -> Void) {
        let bodyField = StarlingsTextField(placeholder: String(localized: "What was settled"))
        bodyField.stringValue = initial.body
        let goalField = StarlingsSearchablePickerField(frame: .zero)
        var goalID = initial.goalID
        goalField.setOptions(
            [StarlingsSearchablePickerOption(id: "", title: String(localized: "None"))]
                + goals.map { StarlingsSearchablePickerOption(id: $0.id, title: $0.title) },
            placeholder: String(localized: "None"),
            selectedID: initial.goalID ?? ""
        )
        goalField.onSelection = { goalID = $0.isEmpty ? nil : $0 }

        let sheet = WorkFormSheet(
            heading: String(localized: "Record decision"),
            rows: [
                .field(caption: String(localized: "Decision"), control: bodyField),
                .view(goals.isEmpty ? nil : WorkFormSheet.field(caption: String(localized: "Goal"), control: goalField)),
            ],
            firstResponder: bodyField,
            canSave: { !bodyField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty },
            onSave: {
                onSave(Draft(
                    body: bodyField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines),
                    goalID: goalID
                ))
            }
        )
        bodyField.delegate = sheet
        sheet.run(over: window)
    }
}

/// A decision waiting on you, opened from INBOX (docs/help/howto/answer-a-decision.md):
/// the sender, context and links, visible options with the recommendation
/// marked, and a note. Answer sends the explicitly chosen option. The row's menu
/// answers in one step; this is for reading first.
@MainActor
enum DecisionAskSheet {
    static func present(over window: NSWindow?, ask: DecisionAsk, onAnswer: @escaping (_ option: String, _ note: String?) -> Void) {
        let optionField = Choices(options: ask.options, recommendation: ask.recommendation)
        let noteField = StarlingsTextField(placeholder: String(localized: "Note (optional)"))

        let meta = [
            ask.overdue ? String(localized: "Overdue") : nil,
            ask.defaultByLabel,
            ask.subject?.title,
        ].compactMap { $0 }.joined(separator: " · ")
        let metaLabel = NSTextField(wrappingLabelWithString: meta)
        metaLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
        metaLabel.textColor = ask.overdue ? StarlingsColors.danger : StarlingsColors.secondaryText
        metaLabel.preferredMaxLayoutWidth = WorkFormSheet.contentWidth

        let senderLabel = NSTextField(wrappingLabelWithString: String(localized: "Asked by \(ask.askedBy)"))
        senderLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(13), weight: .semibold)
        senderLabel.textColor = StarlingsColors.primaryText
        var rows: [WorkFormSheet.Row] = [.view(senderLabel), .view(metaLabel)]
        if let context = ask.context, !context.isEmpty {
            rows.append(.view(Self.contextLabel(context)))
        }
        if !ask.links.isEmpty {
            rows.append(.field(caption: String(localized: "Links"), control: Self.linksLabel(ask.links)))
        }
        rows.append(.field(caption: String(localized: "Answer"), control: optionField))
        rows.append(.field(caption: String(localized: "Note"), control: noteField))

        let sheet = WorkFormSheet(
            heading: ask.question,
            saveTitle: String(localized: "Answer"),
            rows: rows,
            firstResponder: optionField.arrangedSubviews.first,
            canSave: { optionField.selectedKey != nil },
            onSave: {
                guard let option = optionField.selectedKey else { return }
                let note = noteField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
                onAnswer(option, note.isEmpty ? nil : note)
            }
        )
        optionField.onSelection = { [weak sheet] in sheet?.refreshSaveAvailability() }
        noteField.delegate = sheet
        sheet.run(over: window)
    }

    /// Every option stays visible; the recommendation is a hint, never a selection.
    private final class Choices: NSStackView {
        var selectedKey: String?
        var onSelection: (() -> Void)?

        init(options: [DecisionAskOption], recommendation: String) {
            super.init(frame: .zero)
            orientation = .vertical
            alignment = .leading
            spacing = 8
            for option in options {
                let title = option.key == recommendation
                    ? String(localized: "\(option.label) — Recommended") : option.label
                let button = NSButton(title: title, target: self, action: #selector(selectOption(_:)))
                button.identifier = NSUserInterfaceItemIdentifier(option.key)
                button.setButtonType(.pushOnPushOff)
                button.bezelStyle = .regularSquare
                button.font = .systemFont(ofSize: StarlingsTypography.scaled(13))
                (button.cell as? NSButtonCell)?.wraps = true
                let bounds = (title as NSString).boundingRect(with: NSSize(width: WorkFormSheet.contentWidth - 32, height: CGFloat.greatestFiniteMagnitude), options: [.usesLineFragmentOrigin], attributes: [.font: button.font!])
                button.heightAnchor.constraint(equalToConstant: max(44, ceil(bounds.height) + 24)).isActive = true
                button.setAccessibilityLabel(title)
                addArrangedSubview(button)
                button.widthAnchor.constraint(equalTo: widthAnchor).isActive = true
            }
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

        @objc private func selectOption(_ sender: NSButton) {
            selectedKey = sender.identifier?.rawValue
            for case let button as NSButton in arrangedSubviews {
                button.state = button === sender ? .on : .off
            }
            onSelection?()
        }
    }

    /// The agent's markdown, inline styles kept, line breaks as written.
    private static func contextLabel(_ markdown: String) -> NSTextField {
        let label = NSTextField(wrappingLabelWithString: "")
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        let parsed = (try? NSMutableAttributedString(AttributedString(markdown: markdown, options: options), including: \.appKit))
            ?? NSMutableAttributedString(string: markdown)
        let whole = NSRange(location: 0, length: parsed.length)
        parsed.addAttribute(.foregroundColor, value: StarlingsColors.primaryText, range: whole)
        parsed.enumerateAttribute(.font, in: whole) { value, range, _ in
            let base = NSFont.systemFont(ofSize: StarlingsTypography.scaled(13))
            let traits = (value as? NSFont)?.fontDescriptor.symbolicTraits ?? []
            let font = NSFont(descriptor: base.fontDescriptor.withSymbolicTraits(traits), size: base.pointSize) ?? base
            parsed.addAttribute(.font, value: font, range: range)
        }
        label.attributedStringValue = parsed
        label.isSelectable = true
        label.allowsEditingTextAttributes = true
        label.preferredMaxLayoutWidth = WorkFormSheet.contentWidth
        return label
    }

    /// One clickable line per link: its title, or the address.
    private static func linksLabel(_ links: [DecisionAskLinksItem]) -> NSTextField {
        let text = NSMutableAttributedString()
        for (index, link) in links.enumerated() {
            if index > 0 { text.append(NSAttributedString(string: "\n")) }
            var attributes: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: StarlingsTypography.scaled(13))]
            if let url = URL(string: link.url) { attributes[.link] = url }
            text.append(NSAttributedString(string: link.title ?? link.url, attributes: attributes))
        }
        let label = NSTextField(wrappingLabelWithString: "")
        label.attributedStringValue = text
        label.isSelectable = true
        label.allowsEditingTextAttributes = true
        label.preferredMaxLayoutWidth = WorkFormSheet.contentWidth
        return label
    }
}

// MARK: - The form

/// A heading, rows, Cancel and Save, as a document-modal sheet. The same
/// metrics as the task sheet; a row is a captioned control or a view.
@MainActor
final class WorkFormSheet: NSViewController, NSTextFieldDelegate {
    enum Row {
        case field(caption: String, control: NSView)
        /// Nil is a row the sheet does not show — an owner menu with no team.
        case view(NSView?)
    }

    private enum Metrics {
        static let width: CGFloat = 420
        static let padding: CGFloat = 20
        static let rowGap: CGFloat = 14
        static let captionGap: CGFloat = 6
        static let buttonHeight: CGFloat = 32
    }

    /// What a wrapping label inside the form may be wide.
    static let contentWidth: CGFloat = Metrics.width - Metrics.padding * 2

    private let heading: String
    private let saveTitle: String
    private let rows: [Row]
    private weak var firstResponder: NSView?
    private let canSave: () -> Bool
    private let onSave: () -> Void
    private let saveButton = StarlingsFilledButton(frame: .zero)

    init(
        heading: String,
        saveTitle: String = String(localized: "Save"),
        rows: [Row],
        firstResponder: NSView?,
        canSave: @escaping () -> Bool,
        onSave: @escaping () -> Void
    ) {
        self.heading = heading
        self.saveTitle = saveTitle
        self.rows = rows
        self.firstResponder = firstResponder
        self.canSave = canSave
        self.onSave = onSave
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// Caption above the control it names — the house form idiom.
    static func field(caption: String, control: NSView) -> NSView {
        let group = NSStackView(views: [StarlingsTypography.fieldCaption(caption), control])
        group.orientation = .vertical
        group.alignment = .leading
        group.spacing = Metrics.captionGap
        control.setContentHuggingPriority(.defaultLow, for: .horizontal)
        control.widthAnchor.constraint(equalTo: group.widthAnchor).isActive = true
        return group
    }

    /// One menu per choice: what it says, and the wire value it stands for.
    static func configure(_ field: StarlingsPopUpField, choices: [(String, String?)], selecting selected: String?) {
        let popup = field.popup
        popup.removeAllItems()
        for (title, value) in choices {
            popup.addItem(withTitle: title)
            popup.lastItem?.representedObject = value
        }
        popup.selectItem(at: choices.firstIndex { $0.1 == selected } ?? 0)
    }

    /// A checkbox that shows a day picker: undated is the honest default.
    final class DateRow: NSStackView {
        private let toggle: NSButton
        private let picker = StarlingsDatePickerField(frame: .zero)

        init(caption: String, initial: Date?) {
            toggle = NSButton(checkboxWithTitle: caption, target: nil, action: nil)
            super.init(frame: .zero)
            picker.picker.datePickerElements = [.yearMonthDay]
            picker.picker.dateValue = initial ?? Date()
            picker.isHidden = initial == nil
            toggle.attributedTitle = NSAttributedString(string: caption, attributes: [
                .font: NSFont.systemFont(ofSize: StarlingsTypography.scaled(13)),
                .foregroundColor: StarlingsColors.primaryText,
            ])
            toggle.state = initial == nil ? .off : .on
            toggle.applyMeetCheckboxStyle()
            toggle.target = self
            toggle.action = #selector(toggled)
            let tail = NSView()
            tail.setContentHuggingPriority(NSLayoutConstraint.Priority(1), for: .horizontal)
            for view in [toggle, picker, tail] { addArrangedSubview(view) }
            orientation = .horizontal
            alignment = .centerY
            spacing = 12
            toggle.setContentHuggingPriority(.required, for: .horizontal)
            picker.widthAnchor.constraint(equalToConstant: 150).isActive = true
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) {
            fatalError("init(coder:) has not been implemented")
        }

        var date: Date? { toggle.state == .on ? picker.picker.dateValue : nil }

        @objc private func toggled() {
            picker.isHidden = toggle.state != .on
            if let window { window.setContentSize(window.contentView?.fittingSize ?? window.frame.size) }
        }
    }

    override func loadView() {
        let root = NSView()
        root.wantsLayer = true
        root.layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.panel, for: root).cgColor

        let headingLabel = NSTextField(wrappingLabelWithString: heading)
        headingLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(15), weight: .semibold)
        headingLabel.textColor = StarlingsColors.primaryText
        headingLabel.preferredMaxLayoutWidth = Self.contentWidth

        var views: [NSView] = [headingLabel]
        for row in rows {
            switch row {
            case .field(let caption, let control): views.append(Self.field(caption: caption, control: control))
            case .view(let view): if let view { views.append(view) }
            }
        }
        let form = NSStackView(views: views)
        form.orientation = .vertical
        form.alignment = .leading
        form.spacing = Metrics.rowGap
        form.setCustomSpacing(Metrics.padding, after: headingLabel)
        for view in views where view !== headingLabel {
            view.widthAnchor.constraint(equalTo: form.widthAnchor).isActive = true
        }

        let cancelButton = NSButton(title: String(localized: "Cancel"), target: self, action: #selector(cancel))
        SettingsChrome.applySecondaryButton(cancelButton, height: Metrics.buttonHeight)
        cancelButton.keyEquivalent = "\u{1b}"

        saveButton.target = self
        saveButton.action = #selector(save)
        saveButton.apply(
            .accent,
            title: saveTitle,
            font: .systemFont(ofSize: StarlingsTypography.scaled(13), weight: .semibold),
            height: Metrics.buttonHeight
        )
        saveButton.keyEquivalent = "\r"
        saveButton.isEnabled = canSave()

        let spacer = NSView()
        spacer.setContentHuggingPriority(NSLayoutConstraint.Priority(1), for: .horizontal)
        let footer = NSStackView(views: [spacer, cancelButton, saveButton])
        footer.orientation = .horizontal
        footer.alignment = .centerY
        footer.spacing = 10

        let divider = SettingsChrome.hairline()
        let column = NSStackView(views: [form, divider, footer])
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = Metrics.padding
        root.addSubview(column)
        column.pinToEdges(of: root, insets: NSEdgeInsets(top: Metrics.padding, left: Metrics.padding, bottom: Metrics.padding, right: Metrics.padding))
        NSLayoutConstraint.activate([
            root.widthAnchor.constraint(equalToConstant: Metrics.width),
            form.widthAnchor.constraint(equalTo: column.widthAnchor),
            divider.widthAnchor.constraint(equalTo: column.widthAnchor),
            footer.widthAnchor.constraint(equalTo: column.widthAnchor),
        ])
        view = root
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        view.window?.makeFirstResponder(firstResponder)
    }

    func refreshSaveAvailability() { saveButton.isEnabled = canSave() }

    func controlTextDidChange(_ notification: Notification) {
        refreshSaveAvailability()
    }

    @objc private func cancel() { close() }

    @objc private func save() {
        guard canSave() else { return }
        close()
        onSave()
    }

    func run(over parent: NSWindow?) {
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: NSSize(width: Metrics.width, height: 100)),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        window.title = heading
        window.isReleasedWhenClosed = false
        window.contentViewController = self
        guard let parent else {
            window.center()
            NSApp.runModal(for: window)
            window.orderOut(nil)
            return
        }
        parent.beginSheet(window) { _ in window.orderOut(nil) }
    }

    private func close() {
        guard let window = view.window else { return }
        if let parent = window.sheetParent {
            parent.endSheet(window)
        } else {
            NSApp.stopModal()
            window.orderOut(nil)
        }
    }
}
