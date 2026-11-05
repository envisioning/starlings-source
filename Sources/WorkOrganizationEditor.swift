import AppKit
import StarlingsContracts

/// Edit organization on the Mac: name, the fields of
/// `OrganizationDraft`, and the three flags. A sheet over Work's window, open
/// until the save lands, like the contact editor.
@MainActor
enum WorkOrganizationEditor {
    static func present(
        over window: NSWindow?,
        api: MeetingControlAPI,
        detail: CrmSubjectDetail,
        onSaved: @escaping (CrmSubjectDetail) -> Void
    ) {
        OrganizationSheetController(api: api, detail: detail, onSaved: onSaved).run(over: window)
    }
}

@MainActor
private final class OrganizationSheetController: NSViewController, NSTextFieldDelegate {
    private enum Metrics {
        static let width: CGFloat = 480
        static let padding: CGFloat = 20
        static let gap: CGFloat = 12
        static let buttonHeight: CGFloat = 32
    }

    private let api: MeetingControlAPI
    private let detail: CrmSubjectDetail
    private let initial: OrganizationDraft
    private let onSaved: (CrmSubjectDetail) -> Void
    private let nameField = StarlingsTextField(placeholder: String(localized: "Name"))
    private var textFields: [OrganizationDraft.TextField: StarlingsTextField] = [:]
    private let notesView = NSTextView()
    private var flagBoxes: [OrganizationDraft.Flag: NSButton] = [:]
    private let saveButton = StarlingsFilledButton(frame: .zero)
    private let cancelButton = NSButton(title: String(localized: "Cancel"), target: nil, action: nil)
    private let errorLabel = StarlingsNoticeView(wrapping: true)
    private var saveTask: Task<Void, Never>?

    init(api: MeetingControlAPI, detail: CrmSubjectDetail, onSaved: @escaping (CrmSubjectDetail) -> Void) {
        self.api = api
        self.detail = detail
        initial = OrganizationDraft(detail)
        self.onSaved = onSaved
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private var heading: String { String(localized: "Edit organization") }

    override func loadView() {
        let root = NSView()
        root.wantsLayer = true
        root.layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.panel, for: root).cgColor

        let headingLabel = NSTextField(labelWithString: heading)
        headingLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(15), weight: .semibold)
        headingLabel.textColor = StarlingsColors.primaryText

        nameField.stringValue = initial.name
        nameField.delegate = self
        var rows: [NSView] = [headingLabel, field(String(localized: "Name") + FormFieldRegistry.requiredMark, nameField)]

        for textField in OrganizationDraft.TextField.allCases {
            if textField.isLong {
                rows.append(field(textField.label, notesScroll(initial.value(textField))))
            } else {
                let control = StarlingsTextField(placeholder: textField.label)
                control.stringValue = initial.value(textField)
                textFields[textField] = control
                rows.append(field(textField.label, control))
            }
        }

        let flags = NSStackView()
        flags.orientation = .horizontal
        flags.spacing = 16
        for flag in OrganizationDraft.Flag.allCases {
            let box = NSButton(checkboxWithTitle: flag.label, target: nil, action: nil)
            box.state = initial.flag(flag) ? .on : .off
            box.applyMeetCheckboxStyle()
            flagBoxes[flag] = box
            flags.addArrangedSubview(box)
        }
        rows.append(flags)

        let form = NSStackView(views: rows)
        form.orientation = .vertical
        form.alignment = .leading
        form.spacing = Metrics.gap
        for row in rows where row !== headingLabel && row !== flags {
            row.widthAnchor.constraint(equalTo: form.widthAnchor).isActive = true
        }

        cancelButton.target = self
        cancelButton.action = #selector(cancel)
        SettingsChrome.applySecondaryButton(cancelButton, height: Metrics.buttonHeight)
        cancelButton.keyEquivalent = "\u{1b}"
        saveButton.target = self
        saveButton.action = #selector(save)
        applySaveTitle(String(localized: "Save"))
        saveButton.keyEquivalent = "\r"
        saveButton.isEnabled = initial.canSave

        let spacer = NSView()
        spacer.setContentHuggingPriority(NSLayoutConstraint.Priority(1), for: .horizontal)
        let footer = NSStackView(views: [spacer, cancelButton, saveButton])
        footer.orientation = .horizontal
        footer.alignment = .centerY
        footer.spacing = 10

        let column = NSStackView(views: [form, SettingsChrome.hairline(), errorLabel, footer])
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = Metrics.padding
        root.addSubview(column)
        column.pinToEdges(of: root, insets: NSEdgeInsets(top: Metrics.padding, left: Metrics.padding, bottom: Metrics.padding, right: Metrics.padding))
        for view in column.arrangedSubviews {
            view.widthAnchor.constraint(equalTo: column.widthAnchor).isActive = true
        }
        root.widthAnchor.constraint(equalToConstant: Metrics.width).isActive = true
        view = root
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        view.window?.makeFirstResponder(nameField)
    }

    private func notesScroll(_ text: String) -> NSView {
        notesView.string = text
        notesView.font = .systemFont(ofSize: StarlingsTypography.scaled(13))
        notesView.textColor = StarlingsColors.primaryText
        notesView.backgroundColor = StarlingsColors.field
        notesView.drawsBackground = true
        notesView.isRichText = false
        notesView.textContainerInset = NSSize(width: 8, height: 7)
        StarlingsTextField.styleFieldEditor(notesView, font: .systemFont(ofSize: StarlingsTypography.scaled(13)))
        let scroll = NSScrollView()
        scroll.borderType = .bezelBorder
        scroll.hasVerticalScroller = true
        scroll.documentView = notesView
        notesView.minSize = NSSize(width: 0, height: 70)
        notesView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        notesView.isVerticallyResizable = true
        notesView.isHorizontallyResizable = false
        notesView.autoresizingMask = [.width]
        scroll.heightAnchor.constraint(equalToConstant: 72).isActive = true
        return scroll
    }

    private func field(_ caption: String, _ control: NSView) -> NSView {
        let group = NSStackView(views: [StarlingsTypography.fieldCaption(caption), control])
        group.orientation = .vertical
        group.alignment = .leading
        group.spacing = 6
        control.widthAnchor.constraint(equalTo: group.widthAnchor).isActive = true
        return group
    }

    /// What the sheet holds now.
    private var draft: OrganizationDraft {
        var draft = initial
        draft.name = nameField.stringValue
        for (textField, control) in textFields { draft.text[textField] = control.stringValue }
        draft.text[.notes] = notesView.string
        for (flag, box) in flagBoxes { draft.flags[flag] = box.state == .on }
        return draft
    }

    func controlTextDidChange(_ notification: Notification) {
        guard saveTask == nil else { return }
        saveButton.isEnabled = draft.canSave
    }

    @objc private func cancel() { close() }

    @objc private func save() {
        let draft = self.draft
        guard saveTask == nil, draft.canSave else { return }
        guard let patch = draft.patch(from: initial) else {
            close()
            return
        }
        errorLabel.clear()
        saveButton.isEnabled = false
        applySaveTitle(String(localized: "Saving…"))
        let api = api
        let id = detail.id
        saveTask = Task { [weak self] in
            do {
                let saved = try await api.updateCrmOrganization(id: id, patch)
                guard let self else { return }
                saveTask = nil
                onSaved(saved)
                close()
            } catch {
                guard let self else { return }
                saveTask = nil
                applySaveTitle(String(localized: "Save"))
                saveButton.isEnabled = self.draft.canSave
                errorLabel.showError((error as? StarlingsError)?.message ?? error.localizedDescription)
                resizeToFit()
            }
        }
    }

    private func applySaveTitle(_ title: String) {
        saveButton.apply(.accent, title: title, font: .systemFont(ofSize: StarlingsTypography.scaled(13), weight: .semibold), height: Metrics.buttonHeight)
    }

    private func resizeToFit() {
        guard let window = view.window else { return }
        view.layoutSubtreeIfNeeded()
        window.setContentSize(view.fittingSize)
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
        saveTask?.cancel()
        guard let window = view.window else { return }
        if let parent = window.sheetParent {
            parent.endSheet(window)
        } else {
            NSApp.stopModal()
            window.orderOut(nil)
        }
    }
}

/// Merge a duplicate into an organization, as
/// the Core host does: pick the duplicate, then the window asks before
/// it merges. The organization the page shows is never offered.
@MainActor
enum OrganizationMergeSheet {
    static func present(
        over window: NSWindow?,
        api: MeetingControlAPI,
        organization: CrmSubject,
        onPick: @escaping (_ duplicate: StarlingsSearchablePickerOption) -> Void
    ) {
        let picker = StarlingsSearchablePickerField(frame: .zero)
        var picked: StarlingsSearchablePickerOption?
        var shown: [StarlingsSearchablePickerOption] = []
        picker.setOptions([], placeholder: String(localized: "Search organizations"), selectedID: nil)
        picker.search = { query in
            let matches = (try? await api.crmOrganizations(matching: query)) ?? []
            shown = matches
                .filter { $0.id != organization.id }
                .map { StarlingsSearchablePickerOption(id: $0.id, title: $0.name) }
            return shown
        }
        let sheet = WorkFormSheet(
            heading: String(localized: "Merge organization"),
            saveTitle: String(localized: "Merge"),
            rows: [.field(caption: String(localized: "Duplicate"), control: picker)],
            firstResponder: picker,
            canSave: { picked != nil },
            onSave: { if let picked { onPick(picked) } }
        )
        picker.onSelection = { [weak sheet] id in
            picked = shown.first { $0.id == id }
            sheet?.refreshSaveAvailability()
        }
        sheet.run(over: window)
    }
}
