import AppKit
import StarlingsContracts

/// Log and edit sheet for a call, meeting or note on a subject's History
///. The sheet owns the write: a failure stays on the sheet in
/// red with Copy, with the draft intact, so a retry needs no retyping.
///
/// Fields follow `WorkSubjectEditor`: captions above controls, the relation
/// pickers search through the Worker and never preload a directory.
@MainActor
enum WorkInteractionEditor {
    static func present(
        over window: NSWindow?,
        api: MeetingControlAPI,
        draft: CrmInteractionDraft,
        onSaved: @escaping (CrmInteraction) -> Void
    ) {
        InteractionSheetController(api: api, draft: draft, onSaved: onSaved).run(over: window)
    }
}

@MainActor
private final class InteractionSheetController: NSViewController, NSTextFieldDelegate {
    private enum Metrics {
        static let width: CGFloat = 480
        static let padding: CGFloat = 20
        static let gap: CGFloat = 14
        static let captionGap: CGFloat = 6
        static let buttonHeight: CGFloat = 32
    }

    private let api: MeetingControlAPI
    private var draft: CrmInteractionDraft
    private let onSaved: (CrmInteraction) -> Void

    private let typeField = StarlingsPopUpField(frame: .zero)
    private let titleField = StarlingsTextField(placeholder: String(localized: "Title"))
    private let whenPicker = StarlingsDatePickerField(frame: .zero)
    private let summaryView = NSTextView()
    private let linkField = StarlingsTextField(placeholder: "https://…")
    private let organizationPicker: RelationPickerView
    private let leadPicker: RelationPickerView
    private let projectPicker: RelationPickerView
    private let contactPicker: RelationPickerView
    private let errorLabel = StarlingsNoticeView(wrapping: true)
    private let saveButton = StarlingsFilledButton(frame: .zero)
    private var isSaving = false
    private var resolveTask: Task<Void, Never>?

    init(api: MeetingControlAPI, draft: CrmInteractionDraft, onSaved: @escaping (CrmInteraction) -> Void) {
        self.api = api
        self.draft = draft
        self.onSaved = onSaved
        organizationPicker = RelationPickerView(
            mode: .single,
            placeholder: String(localized: "Search organizations"),
            emptyText: String(localized: "No organizations match"),
            search: { query in try await api.crmOrganizations(matching: query) }
        )
        leadPicker = RelationPickerView(
            mode: .single,
            placeholder: String(localized: "Search leads"),
            emptyText: String(localized: "No leads match"),
            search: { query in try await Self.subjects(api, kind: .lead, query: query) }
        )
        projectPicker = RelationPickerView(
            mode: .single,
            placeholder: String(localized: "Search projects"),
            emptyText: String(localized: "No projects match"),
            search: { query in try await Self.subjects(api, kind: .project, query: query) }
        )
        contactPicker = RelationPickerView(
            mode: .multi,
            placeholder: String(localized: "Search contacts"),
            emptyText: String(localized: "No contacts match"),
            search: { query in try await api.crmContacts(matching: query).map(\.relationOption) }
        )
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    /// Leads or projects by name, as a relation picker draws them.
    private static func subjects(
        _ api: MeetingControlAPI,
        kind: MeetingCategoryKind.SubjectKind,
        query: String
    ) async throws -> [SubjectRelationOption] {
        try await api.crmSubjects(kind: kind, query: query).map {
            SubjectRelationOption(id: $0.id, name: $0.title, secondaryText: $0.subtitle)
        }
    }

    // MARK: Layout

    override func loadView() {
        let root = NSView()
        root.wantsLayer = true
        root.layer?.backgroundColor = StarlingsColors.resolved(StarlingsColors.panel, for: root).cgColor

        let heading = draft.isNew ? String(localized: "Log") : String(localized: "Edit")
        let headingLabel = NSTextField(labelWithString: heading)
        headingLabel.font = .systemFont(ofSize: StarlingsTypography.scaled(15), weight: .semibold)
        headingLabel.textColor = StarlingsColors.primaryText

        typeField.popup.removeAllItems()
        for option in draft.typeOptions {
            typeField.popup.addItem(withTitle: option.editorTitle)
            typeField.popup.lastItem?.representedObject = option.rawValue
        }
        typeField.popup.selectItem(at: draft.typeOptions.firstIndex(of: draft.type) ?? 0)

        titleField.stringValue = draft.title
        titleField.delegate = self
        linkField.stringValue = draft.url
        linkField.delegate = self

        // 24-hour (invariant 20): `StarlingsDatePicker` carries the clock.
        whenPicker.picker.datePickerElements = [.yearMonthDay, .hourMinute]
        whenPicker.picker.dateValue = draft.occurredAt

        WorkSubjectEditor.configureTextView(summaryView, value: draft.summary)

        organizationPicker.setSelected(draft.organization.map { [$0] } ?? [])
        leadPicker.setSelected(draft.lead.map { [$0] } ?? [])
        projectPicker.setSelected(draft.project.map { [$0] } ?? [])
        contactPicker.setSelected(draft.contacts)
        for picker in [organizationPicker, leadPicker, projectPicker, contactPicker] {
            picker.onChange = { [weak self] in
                guard let self else { return }
                errorLabel.clear()
                saveButton.isEnabled = canSave
                resizeToFit()
            }
            picker.onError = { [weak self] message in
                guard let self else { return }
                errorLabel.showError(message)
                resizeToFit()
            }
        }

        let typeAndWhen = NSStackView(views: [
            field(caption: String(localized: "Type"), control: typeField),
            field(caption: String(localized: "Date and time"), control: whenPicker),
        ])
        typeAndWhen.orientation = .horizontal
        typeAndWhen.alignment = .top
        typeAndWhen.distribution = .fillEqually
        typeAndWhen.spacing = 12

        let rows: [NSView] = [
            headingLabel,
            typeAndWhen,
            field(caption: String(localized: "Title"), control: titleField),
            field(caption: String(localized: "Summary"), control: WorkSubjectEditor.textScroll(summaryView)),
            field(caption: String(localized: "Link"), control: linkField),
            field(caption: String(localized: "Organization"), control: organizationPicker),
            field(caption: String(localized: "Lead"), control: leadPicker),
            field(caption: String(localized: "Project"), control: projectPicker),
            field(caption: String(localized: "Contacts"), control: contactPicker),
        ]
        let form = NSStackView(views: rows)
        form.orientation = .vertical
        form.alignment = .leading
        form.spacing = Metrics.gap
        form.setCustomSpacing(Metrics.padding, after: headingLabel)
        for row in rows where row !== headingLabel {
            row.widthAnchor.constraint(equalTo: form.widthAnchor).isActive = true
        }

        let cancelButton = NSButton(title: String(localized: "Cancel"), target: self, action: #selector(cancel))
        SettingsChrome.applySecondaryButton(cancelButton, height: Metrics.buttonHeight)
        cancelButton.keyEquivalent = "\u{1b}"

        saveButton.target = self
        saveButton.action = #selector(save)
        saveButton.apply(
            .accent,
            title: String(localized: "Save"),
            font: .systemFont(ofSize: StarlingsTypography.scaled(13), weight: .semibold),
            height: Metrics.buttonHeight
        )
        saveButton.keyEquivalent = "\r"
        saveButton.isEnabled = canSave

        errorLabel.label.font = .systemFont(ofSize: StarlingsTypography.scaled(12))
        errorLabel.label.maximumNumberOfLines = 3

        let spacer = NSView()
        spacer.setContentHuggingPriority(NSLayoutConstraint.Priority(1), for: .horizontal)
        let footer = NSStackView(views: [spacer, cancelButton, saveButton])
        footer.orientation = .horizontal
        footer.alignment = .centerY
        footer.spacing = 10

        let divider = SettingsChrome.hairline()
        let column = NSStackView(views: [form, divider, errorLabel, footer])
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = Metrics.padding
        root.addSubview(column)
        column.pinToEdges(of: root, insets: NSEdgeInsets(
            top: Metrics.padding,
            left: Metrics.padding,
            bottom: Metrics.padding,
            right: Metrics.padding
        ))
        NSLayoutConstraint.activate([
            root.widthAnchor.constraint(equalToConstant: Metrics.width),
            form.widthAnchor.constraint(equalTo: column.widthAnchor),
            divider.widthAnchor.constraint(equalTo: column.widthAnchor),
            errorLabel.widthAnchor.constraint(equalTo: column.widthAnchor),
            footer.widthAnchor.constraint(equalTo: column.widthAnchor),
        ])
        view = root
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        view.window?.makeFirstResponder(titleField)
        resolveNames()
    }

    private func field(caption: String, control: NSView) -> NSView {
        let group = NSStackView(views: [StarlingsTypography.fieldCaption(caption), control])
        group.orientation = .vertical
        group.alignment = .leading
        group.spacing = Metrics.captionGap
        control.setContentHuggingPriority(.defaultLow, for: .horizontal)
        control.widthAnchor.constraint(equalTo: group.widthAnchor).isActive = true
        return group
    }

    /// An edited row names its organization, lead and project by id. Read
    /// each once and draw its name; a failure leaves the id, which still saves.
    private func resolveNames() {
        let links = draft.unnamedLinks
        guard !links.isEmpty else { return }
        let api = api
        resolveTask = Task { @MainActor [weak self] in
            for link in links {
                guard let detail = try? await api.crmSubjectDetail(kind: link.kind, id: link.id) else { continue }
                guard let self, !Task.isCancelled else { return }
                let option = SubjectRelationOption(id: link.id, name: detail.title)
                switch link.kind {
                case .organization: replace(in: organizationPicker, with: option)
                case .lead: replace(in: leadPicker, with: option)
                case .project: replace(in: projectPicker, with: option)
                case .event: break
                }
            }
        }
    }

    private func replace(in picker: RelationPickerView, with option: SubjectRelationOption) {
        guard picker.selected.first?.id == option.id else { return }
        picker.setSelected([option])
        resizeToFit()
    }

    // MARK: Behaviour

    func controlTextDidChange(_ notification: Notification) {
        errorLabel.clear()
        saveButton.isEnabled = canSave
    }

    /// The draft as the fields say it now.
    private var current: CrmInteractionDraft {
        var next = draft
        let raw = typeField.popup.selectedItem?.representedObject as? String
        next.type = raw.map(CrmInteractionType.init(rawValue:)) ?? draft.type
        next.title = titleField.stringValue
        next.occurredAt = whenPicker.picker.dateValue
        next.summary = summaryView.string
        next.url = linkField.stringValue
        next.organization = organizationPicker.selected.first
        next.lead = leadPicker.selected.first
        next.project = projectPicker.selected.first
        next.contacts = contactPicker.selected
        return next
    }

    private var canSave: Bool { !isSaving && current.canSave }

    private func resizeToFit() {
        guard let window = view.window else { return }
        view.layoutSubtreeIfNeeded()
        window.setContentSize(view.fittingSize)
    }

    @objc private func cancel() {
        close()
    }

    @objc private func save() {
        let next = current
        guard next.canSave, !isSaving else { return }
        isSaving = true
        saveButton.isEnabled = false
        errorLabel.clear()
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let saved: CrmInteraction
                if let original = next.original {
                    saved = try await api.updateInteraction(id: original.id, update: next.update)
                } else {
                    saved = try await api.createInteraction(next.create)
                }
                close()
                onSaved(saved)
            } catch {
                isSaving = false
                saveButton.isEnabled = canSave
                errorLabel.showError(error)
                resizeToFit()
            }
        }
    }

    // MARK: Presentation

    func run(over parent: NSWindow?) {
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: NSSize(width: Metrics.width, height: 100)),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        window.title = draft.isNew ? String(localized: "Log") : String(localized: "Edit")
        window.isReleasedWhenClosed = false
        window.contentViewController = self
        guard let parent else {
            window.center()
            NSApp.runModal(for: window)
            window.orderOut(nil)
            return
        }
        parent.beginSheet(window) { _ in
            window.orderOut(nil)
        }
    }

    private func close() {
        resolveTask?.cancel()
        organizationPicker.cancel()
        leadPicker.cancel()
        projectPicker.cancel()
        contactPicker.cancel()
        guard let window = view.window else { return }
        if let parent = window.sheetParent {
            parent.endSheet(window)
        } else {
            NSApp.stopModal()
            window.orderOut(nil)
        }
    }
}
